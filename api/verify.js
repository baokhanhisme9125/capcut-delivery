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
      if (existing.isPending) {
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: existing.productName, orderId: existing.orderId || null,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }
      return alreadyDeliveredResponse(res, existing);
    }

    /* ── 2. Verify via Digiseller API (auto-detects variant) ─────────── */
    let platiInfo;
    try {
      platiInfo = await verifyUniqueCode(code);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
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
      // Another instance already delivered — release our claimed row
      console.warn(`[verify] Race detected for code=${code} — releasing claimed account`);
      try {
        // Revert the CLAIMED marker back to the original account data
        await revertClaimedRow(sheetName, account.rowIndex, account.email, account.password);
      } catch (e) { console.warn('[verify] Could not revert claimed row:', e.message); }
      return alreadyDeliveredResponse(res, raceCheck);
    }

    /* ── 6. Delete claimed row + save order ──────────────────────────── */
    const claimMark = `CLAIMED:${code}`;
    await deleteAccountRow(sheetName, account.rowIndex, claimMark);
    await saveOrder({
      uniqueCode:      code,
      buyerEmail:      platiInfo.buyer || emailParam || 'unknown',
      accountEmail:    account.email,
      accountPassword: account.password,
      orderId:         platiInfo.orderId,
      productType,
      productName,
    });

    /* ── 7. Post-save duplicate detection ────────────────────────────
     *  If two instances both passed step 5 (extremely tight race),
     *  there will now be 2+ rows in Orders for the same code.
     *  Keep only the first one, delete the rest.
     */
    try {
      const allOrders = await findAllOrdersByCode(code);
      if (allOrders.length > 1) {
        console.warn(`[verify] DUPLICATE DETECTED: ${allOrders.length} orders for code=${code}. Cleaning...`);
        // Keep the first one (earliest), delete the rest
        for (let i = 1; i < allOrders.length; i++) {
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

/* ── Helper: revert a CLAIMED row back to original account ── */
async function revertClaimedRow(sheetName, rowIndex, email, password) {
  const { google } = require('googleapis');
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'); }
  catch { return; }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${sheetName}'!A${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[`${email}:${password}`]] },
  });
}
