/**
 * /api/verify-ggsel?orderid=XXX&email=YYY
 *
 * GGSEL verification flow (Order ID + Email):
 * 1. Check Orders sheet (idempotency)
 * 2. Call GGSEL API purchase/info/{invoice_id} to verify
 * 3. Check buyer email matches
 * 4. Deliver account from "CapCut Pro 1 Tháng" sheet
 *
 * Race-condition protection (same as verify.js)
 */
const { getToken } = require('../lib/ggsel');
const fetch = require('node-fetch');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
} = require('../lib/sheets');

const GGSEL_API = 'https://seller.ggsel.com/api_sellers/api';

/* ── Concurrency guard ──────────────────────────────────────────────── */
const _pending = new Map();
const PENDING_TTL = 30_000;

function cleanPending() {
  const now = Date.now();
  for (const [k, t] of _pending) {
    if (now - t > PENDING_TTL) _pending.delete(k);
  }
}

/* ── Helper: already-delivered response ─────────────────────────────── */
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
      platform:    'ggsel',
    },
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const orderId    = (req.query.orderid || '').trim();
  const emailParam = (req.query.email   || '').trim().toLowerCase();

  if (!orderId) {
    return res.status(400).json({ success: false, error: 'Missing Order ID.' });
  }
  if (!emailParam) {
    return res.status(400).json({ success: false, error: 'Missing email address.' });
  }

  // Use "ggsel-{orderId}" as the key for Orders sheet lookup
  const orderKey = `ggsel-${orderId}`;

  try {
    /* ── 0. Concurrency guard ────────────────────────────────────── */
    cleanPending();
    if (_pending.has(orderKey)) {
      await new Promise(r => setTimeout(r, 3000));
      const existing = await findOrderByCode(orderKey);
      if (existing) return alreadyDeliveredResponse(res, existing);
      return res.status(429).json({
        success: false,
        error: 'This order is being processed. Please wait a moment and refresh.',
      });
    }
    _pending.set(orderKey, Date.now());

    /* ── 1. Idempotency: already delivered? ─────────────────────── */
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      if (emailParam !== (existing.buyerEmail || '').toLowerCase()) {
        return res.status(403).json({
          success: false,
          error: 'Email does not match purchase email. / Email не совпадает.',
        });
      }
      return alreadyDeliveredResponse(res, existing);
    }

    /* ── 2. Verify via GGSEL API ─────────────────────────────────── */
    let token;
    try {
      token = await getToken();
    } catch (err) {
      return res.status(500).json({ success: false, error: 'GGSEL API connection failed.' });
    }

    const apiRes = await fetch(`${GGSEL_API}/purchase/info/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 12000,
    });
    const apiData = await apiRes.json();

    if (!apiData || apiData.retval !== 0 || !apiData.content) {
      const desc = apiData ? (apiData.retdesc || apiData.desc) : 'Unknown error';
      return res.status(404).json({
        success: false,
        error: `Order not found or GGSEL error: ${desc}`,
      });
    }

    const purchase = apiData.content;

    /* ── 3. Verify payment status (3 = paid) ─────────────────────── */
    if (purchase.invoice_state !== undefined && purchase.invoice_state !== 3) {
      return res.status(400).json({
        success: false,
        error: 'This order has not been paid or is invalid. / Заказ не оплачен.',
      });
    }

    /* ── 4. Verify buyer email ───────────────────────────────────── */
    const buyerEmail = (
      (purchase.buyer_info && purchase.buyer_info.email) ||
      purchase.email || ''
    ).trim().toLowerCase();

    if (!buyerEmail || buyerEmail !== emailParam) {
      return res.status(403).json({
        success: false,
        error: 'Email does not match purchase email. / Email не совпадает с email покупки.',
      });
    }

    /* ── 5. Get account from "CapCut Pro 1 Tháng" ────────────────── */
    const sheetName   = 'CapCut Pro 1 Tháng';
    const productType = '1m';
    const productName = 'CapCut Pro 1 Month';

    const account = await getNextAvailableAccount(sheetName);
    if (!account) {
      return res.status(503).json({
        success: false,
        outOfStock: true,
        productName,
        error: 'Out of stock. Please contact support. / Товар временно отсутствует.',
      });
    }

    /* ── 5.5. Race-condition guard ────────────────────────────────── */
    const raceCheck = await findOrderByCode(orderKey);
    if (raceCheck) {
      console.log(`[verify-ggsel] Race-condition caught for order=${orderId}`);
      return alreadyDeliveredResponse(res, raceCheck);
    }

    /* ── 6. Delete from sheet + save to Orders ───────────────────── */
    await deleteAccountRow(sheetName, account.rowIndex);
    await saveOrder({
      uniqueCode:      orderKey,       // "ggsel-123456"
      buyerEmail:      buyerEmail,
      accountEmail:    account.email,
      accountPassword: account.password,
      orderId:         orderId,
      productType,
      productName,
      platform:        'ggsel',
    });

    console.log(`[verify-ggsel] Delivered ${productName} for GGSEL order ${orderId}`);

    /* ── 7. Return ───────────────────────────────────────────────── */
    return res.status(200).json({
      success: true,
      alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: {
        uniqueCode:  orderKey,
        buyerEmail:  buyerEmail,
        soldAt:      new Date().toISOString(),
        productType,
        productName,
        orderId:     orderId,
        platform:    'ggsel',
      },
    });

  } catch (err) {
    console.error('[verify-ggsel] Unexpected error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  } finally {
    _pending.delete(orderKey);
  }
};
