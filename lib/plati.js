/**
 * lib/plati.js  — Digiseller API (api.digiseller.com)
 * Plati.market runs on the Digiseller platform.
 *
 * Flow:
 * 1. Login → get Bearer token (cached for 23 h)
 * 2. GET /purchases/unique-code/{code}  → verify + get invoice ID + buyer email + amount
 * 3. GET /purchase/info/{inv}           → full details including options (variant: 7d/1m/6m)
 *
 * Reliability improvements:
 * - Retry up to 3 times with exponential backoff on network errors/timeout
 * - Extended timeout to 20s per attempt
 * - Stale token reuse if refresh fails (rather than crashing)
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

const DIGI_API = 'https://api.digiseller.com/api';

/* ── Token cache ─────────────────────────────────────────────────────── */
let _cachedToken  = null;
let _tokenExpiry  = 0;

/**
 * Fetch with retry (up to maxRetries attempts, exponential backoff).
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  const baseDelay = 500; // ms
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeout || 20000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      lastErr = err;
      const isTimeout = err.name === 'AbortError' || err.type === 'request-timeout' || /timeout/i.test(err.message);
      console.warn(`[plati] fetch attempt ${attempt}/${maxRetries} failed (${isTimeout ? 'timeout' : err.message})`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

async function getToken() {
  // Return cached token if still valid (with 2-min buffer)
  if (_cachedToken && Date.now() < _tokenExpiry - 120_000) return _cachedToken;

  const sellerId = parseInt(process.env.PLATI_SELLER_ID || process.env.DIGISELLER_SELLER_ID || '0', 10);
  const apiKey   = process.env.DIGISELLER_API_KEY || process.env.PLATI_SECRET_KEY || '';

  if (!sellerId || !apiKey) {
    throw new Error('Missing PLATI_SELLER_ID or DIGISELLER_API_KEY in environment variables.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign      = crypto.createHash('sha256').update(`${apiKey}${timestamp}`).digest('hex');

  try {
    const res  = await fetchWithRetry(`${DIGI_API}/apilogin`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ seller_id: sellerId, timestamp, sign }),
      timeout: 20000,
    });
    const data = await res.json();

    if (data.retval !== 0 || !data.token) {
      throw new Error(`Digiseller login failed: ${data.retdesc || data.desc || JSON.stringify(data)}`);
    }

    _cachedToken = data.token;
    _tokenExpiry = data.valid_thru ? new Date(data.valid_thru).getTime() : Date.now() + 23 * 3600_000;
    console.log('[plati] Token refreshed successfully');
    return _cachedToken;
  } catch (err) {
    // If we have a stale cached token, use it rather than crashing
    if (_cachedToken) {
      console.warn('[plati] Token refresh failed, using stale cache:', err.message);
      return _cachedToken;
    }
    throw err;
  }
}

/* ── Detect product variant ──────────────────────────────────────────── */
function detectProduct(ucData, purchaseContent) {
  // Priority 1: Purchase options (most accurate — contains the variant the buyer selected)
  if (purchaseContent && Array.isArray(purchaseContent.options)) {
    const optText = purchaseContent.options
      .map(o => [o.user_data, o.value, o.name].filter(Boolean).join(' '))
      .join(' ')
      .toLowerCase();

    if (/183|6.?month|6.?месяц/.test(optText)) return mk('6m');
    if (/30|1.?month|1.?месяц/.test(optText))  return mk('1m');
    if (/\b7\b|7.?day|7.?ден/.test(optText))   return mk('7d');
  }

  // Priority 2: name_invoice field from unique-code response
  const name = (ucData.name_invoice || '').toLowerCase();
  if (/183/.test(name))   return mk('6m');
  if (/30/.test(name))    return mk('1m');
  if (/\b7\b/.test(name)) return mk('7d');

  // Priority 3: Price thresholds (configurable via Vercel env vars)
  const amount = parseFloat(ucData.amount) || 0;
  const t7d    = parseFloat(process.env.PRICE_THRESHOLD_7D) || 2;
  const t1m    = parseFloat(process.env.PRICE_THRESHOLD_1M) || 10;

  if (amount > 0 && amount <= t7d) return mk('7d');
  if (amount > 0 && amount <= t1m) return mk('1m');
  if (amount > 0)                  return mk('6m');

  return mk('7d'); // safe default
}

function mk(type) {
  const MAP = {
    '7d': { productType: '7d', productName: 'CapCut Pro 7 Days',   sheetName: 'CapCut Pro 7 Ngày'  },
    '1m': { productType: '1m', productName: 'CapCut Pro 1 Month',  sheetName: 'CapCut Pro 1 Tháng' },
    '6m': { productType: '6m', productName: 'CapCut Pro 6 Months', sheetName: 'CapCut Pro 6 Tháng' },
  };
  return MAP[type];
}

/* ── Main export ─────────────────────────────────────────────────────── */
/**
 * Verify a unique code via Digiseller API.
 * Returns enriched order info including productType / sheetName.
 */
async function verifyUniqueCode(uniqueCode) {
  const token = await getToken();

  /* Step 1 — Verify unique code + get invoice ID */
  const ucRes  = await fetchWithRetry(`${DIGI_API}/purchases/unique-code/${uniqueCode}?token=${token}`, {
    headers: { 'Accept': 'application/json' },
    timeout: 20000,
  });
  const ucData = await ucRes.json();

  if (ucData.retval !== 0) {
    throw new Error(ucData.retdesc || ucData.desc || 'Invalid or unrecognised unique code.');
  }

  /* Step 2 — Get full purchase info for variant detection */
  let purchaseContent = null;
  try {
    const piRes  = await fetchWithRetry(`${DIGI_API}/purchase/info/${ucData.inv}?token=${token}`, {
      headers: { 'Accept': 'application/json' },
      timeout: 20000,
    });
    const piData = await piRes.json();
    if (piData.retval === 0 && piData.content) purchaseContent = piData.content;
  } catch (e) {
    console.warn('[plati] purchase/info call failed — using ucData only:', e.message);
  }

  const product = detectProduct(ucData, purchaseContent);

  return {
    orderId:   String(ucData.inv       || ''),
    goodsId:   String(ucData.id_goods  || process.env.PLATI_GOODS_ID || ''),
    buyer:     String(ucData.email     || (purchaseContent && purchaseContent.email) || ''),
    amount:    String(ucData.amount    || ''),
    currency:  String(ucData.type_curr || 'USD'),
    goodsName: String(ucData.name_invoice || ''),
    datePay:   String(ucData.date_pay  || new Date().toISOString()),
    ...product,   // productType, productName, sheetName
  };
}

module.exports = { verifyUniqueCode, getToken };
