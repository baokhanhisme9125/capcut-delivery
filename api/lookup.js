const { findOrderByCode } = require('../lib/sheets');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { uniquecode, email } = req.query;

  if (!uniquecode || !email) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ unique code và email.' });
  }

  try {
    const order = await findOrderByCode(uniquecode.trim());

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy đơn hàng với unique code này.',
      });
    }

    // Verify buyer email matches (case-insensitive)
    if (order.buyerEmail.toLowerCase() !== email.trim().toLowerCase()) {
      return res.status(403).json({
        success: false,
        error: 'Email không khớp với đơn hàng. Vui lòng kiểm tra lại email bạn dùng khi mua hàng.',
      });
    }

    return res.status(200).json({
      success: true,
      account: {
        email:    order.accountEmail,
        password: order.accountPassword,
      },
      order: {
        uniqueCode:  order.uniqueCode,
        soldAt:      order.soldAt,
        productName: order.productName,
        orderId:     order.orderId,
      },
    });

  } catch (err) {
    console.error('[lookup] Error:', err);
    return res.status(500).json({ success: false, error: 'Lỗi server. Vui lòng thử lại.' });
  }
};
