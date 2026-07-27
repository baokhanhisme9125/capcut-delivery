/**
 * /api/debug-plati?code=UNIQUE_CODE&token=capcut-setup-2025
 * Tests multiple Plati API endpoints/headers to find which one bypasses DDoS-Guard.
 */
const crypto = require('crypto');
const fetch  = require('node-fetch');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'capcut-setup-2025';

function sign(idSeller, idGoods, code, secret) {
  return crypto.createHash('md5').update(`${idSeller}${idGoods}${code}${secret}`).digest('hex');
}

async function tryFetch(url, options) {
  try {
    const r = await fetch(url, { timeout: 8000, ...options });
    const t = await r.text();
    return { status: r.status, body: t.slice(0, 300), isJson: !t.trimStart().startsWith('<') };
  } catch (e) {
    return { status: 0, body: 'ERROR: ' + e.message, isJson: false };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if ((req.query.token || '') !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  const code     = req.query.code || 'TEST123';
  const idSeller = process.env.PLATI_SELLER_ID  || '';
  const idGoods  = process.env.PLATI_GOODS_ID   || '';
  const secret   = process.env.PLATI_SECRET_KEY || '';
  const sg       = sign(idSeller, idGoods, code, secret);

  const formBody = `action=getInfoUniqueCode&id_goods=${idGoods}&unique_code=${code}&id_seller=${idSeller}&sign=${sg}`;
  const getQuery = `?action=getInfoUniqueCode&id_goods=${idGoods}&unique_code=${code}&id_seller=${idSeller}&sign=${sg}`;

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
    'Origin': 'https://plati.market',
    'Referer': 'https://plati.market/',
  };

  const results = await Promise.all([
    // 1. plati.market POST plain
    tryFetch('https://plati.market/api/api.ashx', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody,
    }).then(r => ({ test: '1_plati.market_POST_plain', ...r })),

    // 2. plati.market POST + browser headers
    tryFetch('https://plati.market/api/api.ashx', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...browserHeaders }, body: formBody,
    }).then(r => ({ test: '2_plati.market_POST_browserHeaders', ...r })),

    // 3. plati.market GET + browser headers
    tryFetch('https://plati.market/api/api.ashx' + getQuery, {
      headers: browserHeaders,
    }).then(r => ({ test: '3_plati.market_GET_browserHeaders', ...r })),

    // 4. plati.io POST (alternative domain)
    tryFetch('https://plati.io/api/api.ashx', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...browserHeaders }, body: formBody,
    }).then(r => ({ test: '4_plati.io_POST', ...r })),

    // 5. plati.io GET
    tryFetch('https://plati.io/api/api.ashx' + getQuery, {
      headers: browserHeaders,
    }).then(r => ({ test: '5_plati.io_GET', ...r })),

    // 6. wmcentre (Plati's payment processor API)
    tryFetch('https://wmcentre.net/api/api.ashx', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...browserHeaders }, body: formBody,
    }).then(r => ({ test: '6_wmcentre_POST', ...r })),
  ]);

  const working = results.filter(r => r.isJson);

  return res.json({
    env: { idSeller: idSeller ? '✓' : '✗ MISSING', idGoods, secret: secret ? '✓' : '✗ MISSING', code },
    sign: sg,
    working_endpoints: working.length > 0 ? working : 'NONE — all blocked',
    all_results: results.map(r => ({ test: r.test, status: r.status, isJson: r.isJson, preview: r.body.slice(0, 100) })),
  });
};
