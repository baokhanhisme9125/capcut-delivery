/**
 * /api/webhook
 * Called by Plati.market server when a purchase is confirmed.
 * Plati POST fields: id_order, id_goods, unique_code, email, goods_name, sign
 * sign = md5(seller_id + id_goods + unique_code + secret_key)
 *
 * Configure in Plati product settings → Automatic delivery → API URL:
 *   https://capcut-delivery-hrzf.vercel.app/api/webhook
 */
const crypto = require('crypto');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
  detectProductFromName,
} = require('../lib/sheets');

function generateSign(idSeller, idGoods, uniqueCode, secretKey) {
  return crypto
    .createHash('md5')
    .update(`${idSeller}${idGoods}${uniqueCode}${secretKey}`)
    .digest('hex');
}

function detectProductFromGoods(goodsName, amount) {
  const raw = (goodsName || '').toLowerCase();
  if (raw) {
    if (/183|6.?month|6.?месяц/.test(raw)) return { productType: '6m', productName: 'CapCut Pro 6 Tháng', sheetName: 'CapCut Pro 6 Tháng' };
    if (/30|1.?month|1.?месяц/.test(raw))  return { productType: '1m', productName: 'CapCut Pro 1 Tháng', sheetName: 'CapCut Pro 1 Tháng' };
    if (/\b7\b|7.?day|7.?ден/.test(raw))   return { productType: '7d', productName: 'CapCut Pro 7 Ngày',  sheetName: 'CapCut Pro 7 Ngày'  };
  }
  // Price fallback
  const a = parseFloat(amount) || 0;
  const t7d = parseFloat(process.env.PRICE_THRESHOLD_7D) || 2;
  const t1m = parseFloat(process.env.PRICE_THRESHOLD_1M) || 10;
  if (a > 0 && a <= t7d) return { productType: '7d', productName: 'CapCut Pro 7 Ngày',  sheetName: 'CapCut Pro 7 Ngày'  };
  if (a > 0 && a <= t1m) return { productType: '1m', productName: 'CapCut Pro 1 Tháng', sheetName: 'CapCut Pro 1 Tháng' };
  if (a > 0)             return { productType: '6m', productName: 'CapCut Pro 6 Tháng', sheetName: 'CapCut Pro 6 Tháng' };
  return { productType: '7d', productName: 'CapCut Pro 7 Ngày', sheetName: 'CapCut Pro 7 Ngày' };
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(raw);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        resolve(obj);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try { body = await parseBody(req); }
  catch { return res.status(400).json({ error: 'Cannot parse request body' }); }

  const { id_order, id_goods, unique_code, email, goods_name, sign, amount } = body;

  // ── 1. Verify signature ──────────────────────────────────────────────
  const idSeller = process.env.PLATI_SELLER_ID  || '';
  const idGoods  = process.env.PLATI_GOODS_ID   || '';
  const secret   = process.env.PLATI_SECRET_KEY || '';

  const expectedSign = generateSign(idSeller, id_goods || idGoods, unique_code, secret);

  if (!sign || sign.toLowerCase() !== expectedSign.toLowerCase()) {
    console.error('[webhook] Invalid sign. Got:', sign, 'Expected:', expectedSign);
    return res.status(403).json({ success: false, error: 'Invalid signature' });
  }

  if (!unique_code) return res.status(400).json({ success: false, error: 'Missing unique_code' });

  // ── 2. Idempotency: already delivered? ──────────────────────────────
  const existing = await findOrderByCode(unique_code);
  if (existing) {
    return res.status(200).json({
      success: true,
      alreadyDelivered: true,
      account: existing.accountEmail + ':' + existing.accountPassword,
    });
  }

  // ── 3. Detect product ────────────────────────────────────────────────
  const { productType, productName, sheetName } = detectProductFromGoods(goods_name, amount);

  // ── 4. Get account from product sheet ───────────────────────────────
  const account = await getNextAvailableAccount(sheetName);
  if (!account) {
    return res.status(503).json({
      success: false,
      outOfStock: true,
      error: `Out of stock: ${productName}`,
    });
  }

  // ── 5. Delete from sheet + save to Orders ───────────────────────────
  await deleteAccountRow(sheetName, account.rowIndex);
  await saveOrder({
    uniqueCode:      unique_code,
    buyerEmail:      email || '',
    accountEmail:    account.email,
    accountPassword: account.password,
    orderId:         id_order || '',
    productType,
    productName,
  });

  console.log(`[webhook] Delivered ${productName} for order ${id_order}`);

  return res.status(200).json({
    success: true,
    account: account.email + ':' + account.password,
  });
};
