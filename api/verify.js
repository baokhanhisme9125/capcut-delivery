/**
 * /api/verify?uniquecode=XXX&email=YYY
 *
 * 1. Check Orders sheet (idempotency)
 * 2. Verify via Digiseller API (api.digiseller.com — no DDoS-Guard)
 * 3. Auto-detect product variant (7d / 1m / 6m) from purchase options
 * 4. Deliver account from correct sheet + save to Orders
 */
const { verifyUniqueCode } = require('../lib/plati');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
} = require('../lib/sheets');

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
      return res.status(200).json({
        success: true,
        alreadyDelivered: true,
        account: { email: existing.accountEmail, password: existing.accountPassword },
        order: {
          uniqueCode:  existing.uniqueCode,
          buyerEmail:  existing.buyerEmail,
          soldAt:      existing.soldAt,
          productType: existing.productType,
          productName: existing.productName,
          orderId:     existing.orderId,
        },
      });
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
  }
};
