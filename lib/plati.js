const crypto = require('crypto');
const fetch  = require('node-fetch');

const PLATI_API = 'https://plati.market/api/api.ashx';

/** sign = md5(seller_id + goods_id + unique_code + secret_key) */
function generateSign(idSeller, idGoods, uniqueCode, secretKey) {
  return crypto
    .createHash('md5')
    .update(`${idSeller}${idGoods}${uniqueCode}${secretKey}`)
    .digest('hex');
}

/**
 * Detect which product variant was purchased from the raw Plati API response.
 *
 * Priority 1 – Parse goods_name / name field (100% price-independent).
 *   "7-дневный" / "7-day"   → 7d
 *   "30-дневный" / "30-day" → 1m
 *   "183-дневный" / "183"   → 6m
 *
 * Priority 2 – Fallback: configurable price thresholds in Vercel env vars.
 *   PRICE_THRESHOLD_7D  (default 2  USD) — amount ≤ this → 7d
 *   PRICE_THRESHOLD_1M  (default 10 USD) — amount ≤ this → 1m
 *   else                                               → 6m
 */
function detectProduct(data) {
  // ── Priority 1: name-based (safe across price changes) ──────────────
  const raw = (data.goods_name || data.name || data.product_name || '').toLowerCase();

  if (raw) {
    // Check 183-day FIRST (contains "3" which would also match "30" checks)
    if (/183|6.?month|6.?месяц|pол/.test(raw)) {
      return { productType: '6m', productName: 'CapCut Pro 6 Tháng', sheetName: 'CapCut Pro 6 Tháng' };
    }
    if (/30|1.?month|1.?месяц/.test(raw)) {
      return { productType: '1m', productName: 'CapCut Pro 1 Tháng', sheetName: 'CapCut Pro 1 Tháng' };
    }
    if (/\b7\b|7.?day|7.?ден/.test(raw)) {
      return { productType: '7d', productName: 'CapCut Pro 7 Ngày', sheetName: 'CapCut Pro 7 Ngày' };
    }
  }

  // ── Priority 2: amount-based fallback (update env vars if price changes) ──
  const amount = parseFloat(data.amount) || 0;
  const t7d    = parseFloat(process.env.PRICE_THRESHOLD_7D)  || 2;   // ≤ $2  → 7d
  const t1m    = parseFloat(process.env.PRICE_THRESHOLD_1M)  || 10;  // ≤ $10 → 1m

  if (amount > 0 && amount <= t7d) return { productType: '7d', productName: 'CapCut Pro 7 Ngày',  sheetName: 'CapCut Pro 7 Ngày'  };
  if (amount > 0 && amount <= t1m) return { productType: '1m', productName: 'CapCut Pro 1 Tháng', sheetName: 'CapCut Pro 1 Tháng' };
  if (amount > 0)                  return { productType: '6m', productName: 'CapCut Pro 6 Tháng', sheetName: 'CapCut Pro 6 Tháng' };

  // ── Priority 3: default ─────────────────────────────────────────────
  return { productType: '7d', productName: 'CapCut Pro 7 Ngày', sheetName: 'CapCut Pro 7 Ngày' };
}

/**
 * Verify a unique code against Plati API using a single PLATI_GOODS_ID.
 * Returns enriched order info including productType / productName / sheetName.
 */
async function verifyUniqueCode(uniqueCode) {
  const idSeller = process.env.PLATI_SELLER_ID;
  const idGoods  = process.env.PLATI_GOODS_ID;   // single ID: 5059273
  const secret   = process.env.PLATI_SECRET_KEY;

  if (!idSeller || !idGoods || !secret) {
    throw new Error('Thiếu cấu hình Plati (PLATI_SELLER_ID / PLATI_GOODS_ID / PLATI_SECRET_KEY)');
  }

  const sign = generateSign(idSeller, idGoods, uniqueCode, secret);
  const url  = `${PLATI_API}?action=getInfoUniqueCode` +
               `&id_goods=${encodeURIComponent(idGoods)}` +
               `&unique_code=${encodeURIComponent(uniqueCode)}` +
               `&id_seller=${encodeURIComponent(idSeller)}` +
               `&sign=${sign}`;

  let data;
  try {
    const res  = await fetch(url, { timeout: 12000 });
    const text = await res.text();
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Không thể kết nối Plati API: ${err.message}`);
  }

  if (data.error || data.id_order === undefined) {
    throw new Error(data.error || data.message || 'Unique code không hợp lệ');
  }

  // Detect product variant from API response (name-first, price-fallback)
  const product = detectProduct(data);

  return {
    orderId:     String(data.id_order  || ''),
    goodsId:     String(data.id_goods  || idGoods),
    sellerId:    String(data.id_seller || ''),
    buyer:       String(data.buyer     || data.email || ''),
    amount:      String(data.amount    || ''),
    currency:    String(data.currency  || 'USD'),
    goodsName:   String(data.goods_name || data.name || ''),
    datePay:     String(data.date_pay  || new Date().toISOString()),
    ...product,  // productType, productName, sheetName
  };
}

module.exports = { verifyUniqueCode };
