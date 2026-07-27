/**
 * /api/debug-plati?token=capcut-setup-2025&code=UNIQUE_CODE
 * Tests Digiseller API (api.digiseller.com) which is different from plati.market/api/api.ashx
 * Plati.market runs on Digiseller platform - their separate API domain is NOT behind DDoS-Guard
 */
const crypto = require('crypto');
const fetch  = require('node-fetch');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'capcut-setup-2025';

async function tryFetch(label, url, options = {}) {
  try {
    const r = await fetch(url, { timeout: 8000, ...options });
    const t = await r.text();
    return { label, status: r.status, isJson: !t.trimStart().startsWith('<'), preview: t.slice(0, 400) };
  } catch (e) {
    return { label, status: 0, isJson: false, preview: 'ERROR: ' + e.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if ((req.query.token || '') !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  const uniqueCode = req.query.code || 'TEST123';
  const sellerId   = parseInt(process.env.PLATI_SELLER_ID || process.env.DIGISELLER_SELLER_ID || '0', 10);
  const apiKey     = process.env.DIGISELLER_API_KEY || process.env.PLATI_SECRET_KEY || '';

  // Step 1: Try to get Digiseller token
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('sha256').update(`${apiKey}${timestamp}`).digest('hex');

  let tokenResult;
  let token = null;
  try {
    const r = await fetch('https://api.digiseller.com/api/apilogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ seller_id: sellerId, timestamp, sign }),
      timeout: 10000,
    });
    const data = await r.json();
    tokenResult = { status: r.status, retval: data.retval, hasToken: !!data.token, desc: data.desc || data.retdesc };
    if (data.token) token = data.token;
  } catch (e) {
    tokenResult = { error: e.message };
  }

  // Step 2: If token obtained, try to verify unique code
  let uniqueCodeResult = null;
  if (token) {
    uniqueCodeResult = await tryFetch(
      'digiseller_unique_code_check',
      `https://api.digiseller.com/api/purchases/unique-code/${uniqueCode}?token=${token}`,
      { headers: { 'Accept': 'application/json' } }
    );
  }

  // Step 3: Also test old plati.market endpoint for comparison
  const oldApiResult = await tryFetch(
    'old_plati_ashx',
    `https://plati.market/api/api.ashx?action=getInfoUniqueCode&id_goods=${process.env.PLATI_GOODS_ID}&unique_code=${uniqueCode}&id_seller=${sellerId}&sign=test`,
    {}
  );

  return res.json({
    env: {
      sellerId,
      apiKey: apiKey ? `${apiKey.slice(0, 6)}...` : '✗ MISSING (add DIGISELLER_API_KEY)',
      uniqueCode,
    },
    step1_get_token: tokenResult,
    step2_verify_unique_code: uniqueCodeResult,
    step3_old_plati_ashx: { status: oldApiResult.status, isJson: oldApiResult.isJson },
    note: 'If step1 retval=0 and step2 isJson=true → Digiseller API works! Switch lib/plati.js to use it.',
  });
};
