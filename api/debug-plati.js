/**
 * /api/debug-plati?code=UNIQUE_CODE&token=capcut-setup-2025
 * Test Plati API raw response — REMOVE after debugging
 */
const crypto = require('crypto');
const fetch  = require('node-fetch');

const PLATI_API   = 'https://plati.market/api/api.ashx';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'capcut-setup-2025';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if ((req.query.token || '') !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uniqueCode = req.query.code || 'TEST123';
  const idSeller   = process.env.PLATI_SELLER_ID  || '';
  const idGoods    = process.env.PLATI_GOODS_ID   || '';
  const secret     = process.env.PLATI_SECRET_KEY || '';

  const sign = crypto.createHash('md5')
    .update(`${idSeller}${idGoods}${uniqueCode}${secret}`)
    .digest('hex');

  // Try 1: POST
  const bodyPost = new URLSearchParams({
    action: 'getInfoUniqueCode', id_goods: idGoods,
    unique_code: uniqueCode, id_seller: idSeller, sign,
  });

  // Try 2: GET
  const urlGet = `${PLATI_API}?action=getInfoUniqueCode&id_goods=${idGoods}&unique_code=${uniqueCode}&id_seller=${idSeller}&sign=${sign}`;

  let postText = '', getText = '';
  try {
    const r1 = await fetch(PLATI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyPost.toString(), timeout: 10000,
    });
    postText = await r1.text();
  } catch (e) { postText = 'ERROR: ' + e.message; }

  try {
    const r2 = await fetch(urlGet, { timeout: 10000 });
    getText = await r2.text();
  } catch (e) { getText = 'ERROR: ' + e.message; }

  return res.json({
    env: { idSeller: idSeller ? '✓ set' : '✗ missing', idGoods, secret: secret ? '✓ set' : '✗ missing' },
    sign,
    uniqueCode,
    post_response: postText.slice(0, 500),
    get_response:  getText.slice(0, 500),
  });
};
