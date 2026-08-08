/**
 * lib/ggsel.js — GGSEL (seller.ggsel.com) API
 *
 * Auth: signature-based login → Bearer token (cached until expiry)
 *   sign = sha256(API_KEY + timestamp_seconds)
 *
 * Flow:
 * 1. POST /apilogin → get Bearer token
 * 2. GET  /purchases/unique-code/{code} → verify + get invoice ID + buyer email
 * 3. GET  /purchase/info/{inv}          → full details (options, payment status)
 *
 * GGSEL unique codes are UUIDs (36 chars with hyphens).
 * Plati unique codes are 16-char hex strings.
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

const GGSEL_API = 'https://seller.ggsel.com/api_sellers/api';

/* ── Token cache ─────────────────────────────────────────────────────── */
let _cachedToken = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) return _cachedToken;

  const sellerId = parseInt(process.env.GGSEL_SELLER_ID || '0', 10);
  const apiKey   = process.env.GGSEL_API_KEY || '';

  if (!sellerId || !apiKey) {
    throw new Error('Missing GGSEL_SELLER_ID or GGSEL_API_KEY in environment variables.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign      = crypto.createHash('sha256').update(`${apiKey}${timestamp}`).digest('hex');

  const res = await fetch(`${GGSEL_API}/apilogin`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify({ seller_id: sellerId, timestamp, sign }),
    timeout: 12000,
  });
  const data = await res.json();

  if (data.retval !== 0 || !data.token) {
    throw new Error(`GGSEL login failed: ${data.desc || data.retdesc || JSON.stringify(data)}`);
  }

  _cachedToken = data.token;
  _tokenExpiry = data.valid_thru ? new Date(data.valid_thru).getTime() : Date.now() + 23 * 3600_000;
  return _cachedToken;
}

/* ── Verify unique code ──────────────────────────────────────────────── */
/**
 * Verify a GGSEL unique code.
 * Returns enriched info in the same format as lib/plati.js:
 *   { orderId, buyer, productType, productName, sheetName, ... }
 *
 * GGSEL CapCut product = only 30 days → always maps to '1m'
 */
async function verifyUniqueCode(uniqueCode) {
  const token = await getToken();

  /* Step 1 — Verify unique code → get invoice ID + buyer email */
  const ucRes = await fetch(`${GGSEL_API}/purchases/unique-code/${uniqueCode}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    timeout: 12000,
  });
  const ucData = await ucRes.json();

  if (ucData.retval !== 0) {
    throw new Error(ucData.retdesc || ucData.desc || 'Invalid or unrecognised GGSEL unique code.');
  }

  const invoiceId = ucData.inv || ucData.invoice_id || ucData.invoice || '';
  const buyerEmail = (ucData.email || ucData.buyer_email || '').trim().toLowerCase();

  /* Step 2 — Get purchase info (verify payment + get product details) */
  let purchaseContent = null;
  if (invoiceId) {
    try {
      const piRes = await fetch(`${GGSEL_API}/purchase/info/${invoiceId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        timeout: 12000,
      });
      const piData = await piRes.json();
      if (piData.retval === 0 && piData.content) {
        purchaseContent = piData.content;

        // Verify payment status: 3 = paid
        if (purchaseContent.invoice_state !== undefined && purchaseContent.invoice_state !== 3) {
          throw new Error('This GGSEL order has not been paid or is invalid.');
        }
      }
    } catch (e) {
      // If this is our own validation error, re-throw it
      if (e.message.includes('not been paid')) throw e;
      console.warn('[ggsel] purchase/info call failed — using ucData only:', e.message);
    }
  }

  // Extract buyer email from purchase content if available
  const actualBuyer = buyerEmail
    || (purchaseContent && purchaseContent.buyer_info && purchaseContent.buyer_info.email
        ? purchaseContent.buyer_info.email.trim().toLowerCase()
        : '');

  /* Step 3 — Product mapping
     GGSEL CapCut store only has 30 day product → always '1m'
     Shared stock with Plati's "CapCut Pro 1 Tháng" sheet */
  return {
    platform:    'ggsel',
    orderId:     String(invoiceId),
    buyer:       actualBuyer,
    amount:      String(ucData.amount || ''),
    currency:    'RUB',
    datePay:     String(
      (purchaseContent && (purchaseContent.date_pay || purchaseContent.pay_date))
      || ucData.date_pay
      || new Date().toISOString()
    ),
    productType: '1m',
    productName: 'CapCut Pro 1 Month',
    sheetName:   'CapCut Pro 1 Tháng',
  };
}

/* ── Confirm delivery to GGSEL ───────────────────────────────────────── */
async function confirmDelivery(uniqueCode) {
  try {
    const token = await getToken();
    const res = await fetch(`${GGSEL_API}/purchases/unique-code/${uniqueCode}/deliver`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: '{}',
      timeout: 10000,
    });
    console.log(`[ggsel] Confirmed delivery for code=${uniqueCode}, status=${res.status}`);
  } catch (err) {
    console.error(`[ggsel] Delivery confirmation failed for ${uniqueCode}:`, err.message);
  }
}

module.exports = { verifyUniqueCode, confirmDelivery, getToken };
