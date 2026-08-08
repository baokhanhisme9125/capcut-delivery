/**
 * /api/verify?uniquecode=XXX&email=YYY
 *
 * 1. Check Orders sheet (idempotency)
 * 2. Verify via Digiseller API (api.digiseller.com — no DDoS-Guard)
 * 3. Auto-detect product variant (7d / 1m / 6m) from purchase options
 * 4. Deliver account from correct sheet + save to Orders
 *
 * Race-condition protection:
 *   - In-memory lock per unique code (prevents concurrent same-instance hits)
 *   - Double-check findOrderByCode before committing (prevents cross-instance race)
 */
const { verifyUniqueCode } = require('../lib/plati');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
} = require('../lib/sheets');

/* ── Concurrency guard (per serverless instance) ────────────────────── */
const _pending = new Map();                    // code → timestamp
const PENDING_TTL = 30_000;                    // auto-expire stale locks after 30s

function cleanPending() {
  const now = Date.now();
  for (const [k, t] of _pending) {
    if (now - t > PENDING_TTL) _pending.delete(k);
  }
}

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

  const code       = (req.query.uniquecode || '').trim();
  const emailParam = (req.query.email      || '').trim().toLowerCase();

  if (!code || code.length < 5) {
    return res.status(400).json({ success: false, error: 'Missing or invalid unique code.' });
  }

  try {
    /* ── 0. Concurrency guard (same Vercel instance) ─────────────── */
    cleanPending();
    if (_pending.has(code)) {
      // Another request for the same code is already in-flight on this instance.
      // Wait briefly then return whatever result it saved.
      await new Promise(r => setTimeout(r, 3000));
      const existing = await findOrderByCode(code);
      if (existing) return alreadyDeliveredResponse(res, existing);
      return res.status(429).json({
        success: false,
        error: 'This order is being processed. Please wait a moment and refresh.',
      });
    }
    _pending.set(code, Date.now());

    /* ── 1. Idempotency: already delivered? ─────────────────────────── */
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

    /* ── 4. Get account from correct product sheet ───────────────────── */
    const account = await getNextAvailableAccount(sheetName);
    if (!account) {
      return res.status(503).json({
        success: false,
        outOfStock: true,
        productName,
        orderId: platiInfo.orderId || null,
        error: `Out of stock for ${productName}. Please contact support.`,
      });
    }

    /* ── 4.5. Race-condition guard: re-check before committing ───────── */
    /*  Between step 1 and here, another Vercel instance may have already
        delivered for this code. Check again to prevent duplicate delivery. */
    const raceCheck = await findOrderByCode(code);
    if (raceCheck) {
      // Another instance already delivered — do NOT consume this account
      console.log(`[verify] Race-condition caught for code=${code}. Skipping duplicate delivery.`);
      return alreadyDeliveredResponse(res, raceCheck);
    }

    /* ── 5. Delete from sheet + save to Orders ───────────────────────── */
    await deleteAccountRow(sheetName, account.rowIndex);
    await saveOrder({
      uniqueCode:      code,
      buyerEmail:      platiInfo.buyer || emailParam || 'unknown',
      accountEmail:    account.email,
      accountPassword: account.password,
      orderId:         platiInfo.orderId,
      productType,
      productName,
    });

    /* ── 6. Return ───────────────────────────────────────────────────── */
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
  } finally {
    /* Always release the lock so future requests for this code can proceed */
    _pending.delete(code);
  }
};
