/**
 * /api/verify?uniquecode=XXX&email=YYY
 *
 * Supports BOTH platforms:
 *   - Plati.market (Digiseller) — unique code = 16-char hex
 *   - GGSEL.net                 — unique code = 36-char UUID
 *
 * Flow:
 * 1. Auto-detect platform from code format
 * 2. Check Orders sheet (idempotency)
 * 3. Verify via platform API
 * 4. Deliver account from correct sheet + save to Orders
 *
 * Race-condition protection:
 *   - In-memory lock per unique code (prevents concurrent same-instance hits)
 *   - Double-check findOrderByCode before committing (prevents cross-instance race)
 */
const { verifyUniqueCode: verifyPlati } = require('../lib/plati');
const { verifyUniqueCode: verifyGgsel, confirmDelivery: confirmGgselDelivery } = require('../lib/ggsel');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
} = require('../lib/sheets');

/* ── Platform detection ─────────────────────────────────────────────── */
function detectPlatform(code) {
  // GGSEL unique codes are UUIDs: 8-4-4-4-12 hex with hyphens (36 chars)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)) {
    return 'ggsel';
  }
  // Plati unique codes are 16-char hex (no hyphens)
  return 'plati';
}

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
      platform:    order.platform || 'plati',
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

  const platform = detectPlatform(code);
  console.log(`[verify] code=${code.slice(0,8)}... platform=${platform}`);

  try {
    /* ── 0. Concurrency guard (same Vercel instance) ─────────────── */
    cleanPending();
    if (_pending.has(code)) {
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

    /* ── 2. Verify via platform API ──────────────────────────────────── */
    let verifyInfo;
    try {
      if (platform === 'ggsel') {
        verifyInfo = await verifyGgsel(code);
      } else {
        verifyInfo = await verifyPlati(code);
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    /* ── 3. Optional email check ─────────────────────────────────────── */
    const buyerEmail = (verifyInfo.buyer || '').toLowerCase();
    if (emailParam && buyerEmail && buyerEmail !== 'unknown') {
      if (emailParam !== buyerEmail) {
        return res.status(403).json({
          success: false,
          error: 'Email does not match purchase email. / Email не совпадает.',
        });
      }
    }

    const { productType, productName, sheetName } = verifyInfo;

    /* ── 4. Get account from correct product sheet ───────────────────── */
    const account = await getNextAvailableAccount(sheetName);
    if (!account) {
      return res.status(503).json({
        success: false,
        outOfStock: true,
        productName,
        orderId: verifyInfo.orderId || null,
        error: `Out of stock for ${productName}. Please contact support.`,
      });
    }

    /* ── 4.5. Race-condition guard: re-check before committing ───────── */
    const raceCheck = await findOrderByCode(code);
    if (raceCheck) {
      console.log(`[verify] Race-condition caught for code=${code}. Skipping duplicate delivery.`);
      return alreadyDeliveredResponse(res, raceCheck);
    }

    /* ── 5. Delete from sheet + save to Orders ───────────────────────── */
    await deleteAccountRow(sheetName, account.rowIndex);
    await saveOrder({
      uniqueCode:      code,
      buyerEmail:      verifyInfo.buyer || emailParam || 'unknown',
      accountEmail:    account.email,
      accountPassword: account.password,
      orderId:         verifyInfo.orderId,
      productType,
      productName,
      platform,
    });

    /* ── 5.5. Confirm delivery to GGSEL (if applicable) ──────────────── */
    if (platform === 'ggsel') {
      // Fire-and-forget: don't block the response
      confirmGgselDelivery(code).catch(err => {
        console.error('[verify] GGSEL delivery confirmation failed:', err.message);
      });
    }

    /* ── 6. Return ───────────────────────────────────────────────────── */
    return res.status(200).json({
      success: true,
      alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: {
        uniqueCode:  code,
        buyerEmail:  verifyInfo.buyer || emailParam || 'unknown',
        soldAt:      new Date().toISOString(),
        productType,
        productName,
        orderId:     verifyInfo.orderId,
        platform,
      },
    });

  } catch (err) {
    console.error('[verify] Unexpected error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  } finally {
    _pending.delete(code);
  }
};
