/**
 * /api/verify?uniquecode=XXX&email=YYY
 * Looks up an existing order from Google Sheets Orders tab.
 * No Plati API call needed — orders are stored by /api/webhook at purchase time.
 */
const { findOrderByCode } = require('../lib/sheets');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { uniquecode, email } = req.query;

  if (!uniquecode || uniquecode.trim().length < 5) {
    return res.status(400).json({ success: false, error: 'Missing or invalid unique code.' });
  }

  try {
    const order = await findOrderByCode(uniquecode.trim());

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found. Please wait a few seconds and try again, or contact support.',
      });
    }

    // Optional email check for security
    if (email && order.buyerEmail && order.buyerEmail !== 'unknown') {
      if (email.trim().toLowerCase() !== order.buyerEmail.trim().toLowerCase()) {
        return res.status(403).json({
          success: false,
          error: 'Email does not match the purchase email. / Email не совпадает с email при покупке.',
        });
      }
    }

    return res.status(200).json({
      success: true,
      alreadyDelivered: true,
      account: {
        email: order.accountEmail,
        password: order.accountPassword,
      },
      order: {
        uniqueCode: order.uniqueCode,
        buyerEmail: order.buyerEmail,
        soldAt: order.soldAt,
        productType: order.productType,
        productName: order.productName,
        orderId: order.orderId,
      },
    });

  } catch (err) {
    console.error('[verify] Error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Server error. Please try again later.',
    });
  }
};
