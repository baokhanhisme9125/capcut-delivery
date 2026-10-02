/**
 * /api/verify?uniquecode=XXX&email=YYY
 *
 * 1. Check Orders sheet (idempotency)
 * 2. Verify via Digiseller API
 * 3. Auto-detect product variant (7d / 1m / 6m)
 * 4. Claim account atomically (CLAIMED: marker + verify read-back)
 * 5. Double-check Orders AGAIN before saving (cross-instance race guard)
 * 6. After save, detect & clean duplicate orders for same uniqueCode
 */
const { verifyUniqueCode } = require('../lib/plati');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  revertClaimedRow,
  saveOrder,
  savePendingOrder,
  findOrderByCode,
  findAllOrdersByCode,
  deleteOrderRow,
} = require('../lib/sheets');

/* ── Helper: return already-delivered response ──────────────────────── */
function alreadyDeliveredResponse(res, order) {
  return res.status(200).json({
    success: true,
    alreadyDelivered: true,
    account: { email: order.accountEmail, password: order.accountPassword },
    order: {
      uniqueCode:  order.uniqueCode,
      buyerEmail:  order.buyerEmail,
      soldAt:      order.soldAt,
      productType: order.productType,
      productName: order.productName,
      orderId:     order.orderId,
    },
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let code       = (req.query.uniquecode || '').trim();
  let emailParam = (req.query.email      || '').trim().toLowerCase();

  // ── Auto-correct swapped fields ──────────────────────────────────────
  if (code.includes('@') && /^[0-9A-Fa-f]{16}$/i.test(emailParam)) {
    console.log(`[verify] Detected swapped fields — auto-correcting. code="${code}" email="${emailParam}"`);
    const tmp = code; code = emailParam; emailParam = tmp;
  }

  if (!code || code.length < 5) {
    return res.status(400).json({ success: false, error: 'Missing or invalid unique code.' });
  }

  let hasPendingOrder = false;

  try {
    /* ── 1. Idempotency: already delivered? ───────────────────────────── */
    const existing = await findOrderByCode(code);
    if (existing) {
      if (emailParam && existing.buyerEmail && existing.buyerEmail !== 'unknown') {
        if (emailParam !== existing.buyerEmail.toLowerCase()) {
          return res.status(403).json({
            success: false,
            error: 'Email does not match purchase email. / Email не совпадает.',
          });
        }
      }
      if (!existing.isPending) return alreadyDeliveredResponse(res, existing);
      // isPending: true — don't return OOS, try to deliver now
      hasPendingOrder = true;
      console.log(`[verify] Pending order found for code=${code} — retrying delivery from stock`);
    }

    /* ── 2. Verify via Digiseller API (auto-detects variant) ─────────── */
    let platiInfo;
    try {
      platiInfo = await verifyUniqueCode(code);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    /* ── 2b. Block orders before bot was created (27/08/2026) ── */
    function parseDigiDate(str) {
      if (!str) return NaN;
      const pad = n => String(n).padStart(2, '0');
      // Try DD.MM.YYYY HH:MM:SS first (1 or 2 digit time parts)
      const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
      if (m) return new Date(`${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(m[4])}:${pad(m[5])}:${pad(m[6])}Z`).getTime();
      // Try DD.MM.YYYY (no time)
      const m2 = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (m2) return new Date(`${m2[3]}-${pad(m2[2])}-${pad(m2[1])}T00:00:00Z`).getTime();
      // Fallback: native parse (ISO 8601)
      const d1 = new Date(str).getTime();
      if (!isNaN(d1)) return d1;
      return NaN;
    }
    const CUTOFF_DATE = new Date('2026-07-27T00:00:00Z').getTime();
    const orderDate = parseDigiDate(platiInfo.datePay);
    if (!isNaN(orderDate) && orderDate < CUTOFF_DATE) {
      console.warn(`[verify] BLOCKED old order: code=${code} datePay=${platiInfo.datePay}`);
      return res.status(400).json({
        success: false,
        error: 'This order has expired. Delivery is no longer available. / Срок заказа истёк.',
      });
    }

    /* ── 3. Optional email check ─────────────────────────────────────── */
    const buyerEmail = (platiInfo.buyer || '').toLowerCase();
    if (emailParam && buyerEmail && buyerEmail !== 'unknown') {
      if (emailParam !== buyerEmail) {
        return res.status(403).json({
          success: false,
          error: 'Email does not match purchase email. / Email не совпадает.',
        });
      }
    }

    const { productType, productName, sheetName } = platiInfo;

    /* ── 4. Claim account atomically via CLAIMED: marker ───────────── */
    const account = await getNextAvailableAccount(sheetName, code);
    if (!account) {
      // Still OOS — if pending order already exists, don't save duplicate
      if (hasPendingOrder) {
        console.log(`[verify] Still OOS for pending code=${code}`);
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: productName || 'CapCut Pro', orderId: platiInfo ? platiInfo.orderId : null,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }
      // Check if pending order already saved by another instance
      const pendingCheck = await findOrderByCode(code);
      if (pendingCheck) {
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: pendingCheck.productName, orderId: pendingCheck.orderId || null,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }
      await savePendingOrder({
        uniqueCode: code,
        buyerEmail: platiInfo.buyer || emailParam || 'unknown',
        orderId: platiInfo.orderId,
        productType, productName,
      });
      console.log(`[verify] OOS — saved pending order for code=${code}`);
      return res.status(503).json({
        success: false, outOfStock: true, isPending: true,
        productName, orderId: platiInfo.orderId || null,
        error: `Out of stock for ${productName}. Your order is saved — please refresh (F5) to receive your account.`,
      });
    }

    /* ── 5. CRITICAL: Double-check Orders BEFORE saving ──────────────
     *  Another Vercel instance may have saved an order for this code
     *  while we were claiming the account. If so, release our claim
     *  and return the existing order.
     */
    const raceCheck = await findOrderByCode(code);
    if (raceCheck && !raceCheck.isPending) {
      console.warn(`[verify] Race detected for code=${code} — reverting claimed account`);
      try {
        await revertClaimedRow(sheetName, account.claimMark);
      } catch (e) { console.warn('[verify] Could not revert race claim:', e.message); }
      return alreadyDeliveredResponse(res, raceCheck);
    }

    /* ── 5b. Duplicate account check — uses cached deliveredSet ── */
    const normalizedAccKey = `${account.email}:${account.password}`.toLowerCase().replace(/\s*:\s*/, ':');
    const accountDup = account._deliveredSet ? account._deliveredSet.has(normalizedAccKey) : false;
    if (accountDup) {
      console.warn(`[verify] DUPLICATE ACCOUNT BLOCKED: ${account.email} already delivered. Reverting claim for code=${code}`);
      try {
        await revertClaimedRow(sheetName, account.claimMark);
      } catch (e) { console.warn('[verify] Could not revert duplicate claim:', e.message); }
      return res.status(500).json({ success: false, error: 'Server error — account conflict detected. Please try again.' });
    }

    /* ── 6. Delete claimed row + save order ──────────────────────────── */
    await deleteAccountRow(sheetName, account.rowIndex, account.claimMark);
    await saveOrder({
      uniqueCode:      code,
      buyerEmail:      platiInfo.buyer || emailParam || 'unknown',
      accountEmail:    account.email,
      accountPassword: account.password,
      orderId:         platiInfo.orderId,
      productType,
      productName,
    });

    /* ── 7. Post-save: dedup + clean up pending rows ────────────────
     *  Keep the LAST row (just appended = completed).
     *  Delete all earlier rows (pending + race duplicates).
     */
    try {
      const allOrders = await findAllOrdersByCode(code);
      if (allOrders.length > 1) {
        console.warn(`[verify] ${allOrders.length} rows for code=${code} — keeping last (completed), deleting earlier`);
        for (let i = 0; i < allOrders.length - 1; i++) {
          await deleteOrderRow(allOrders[i].rowIndex);
        }
      }
    } catch (e) { console.warn('[verify] Post-save duplicate check error:', e.message); }

    /* ── 8. Return ───────────────────────────────────────────────────── */
    return res.status(200).json({
      success: true,
      alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: {
        uniqueCode:  code,
        buyerEmail:  platiInfo.buyer || emailParam || 'unknown',
        soldAt:      new Date().toISOString(),
        productType,
        productName,
        orderId:     platiInfo.orderId,
      },
    });

  } catch (err) {
    console.error('[verify] Unexpected error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
};
