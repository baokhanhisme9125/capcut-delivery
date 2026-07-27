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

  const { uniquecode } = req.query;

  if (!uniquecode || uniquecode.trim().length < 5) {
    return res.status(400).json({ success: false, error: 'Thiếu hoặc sai định dạng unique code.' });
  }

  const code = uniquecode.trim();

  try {
    /* ── 1. Idempotency check: đã giao trước đó? ────────────────────── */
    const existing = await findOrderByCode(code);
    if (existing) {
      return res.status(200).json({
        success: true,
        alreadyDelivered: true,
        account: {
          email:    existing.accountEmail,
          password: existing.accountPassword,
        },
        order: {
          uniqueCode:  existing.uniqueCode,
          soldAt:      existing.soldAt,
          productType: existing.productType,
          productName: existing.productName,
          orderId:     existing.orderId,
        },
      });
    }

    /* ── 2. Verify with Plati API ────────────────────────────────────── */
    let platiInfo;
    try {
      platiInfo = await verifyUniqueCode(code);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    /* ── 2b. Optional email check (manual mode only) ─────────────────── */
    const emailParam = (req.query.email || '').trim().toLowerCase();
    const buyerEmail = (platiInfo.buyer || '').trim().toLowerCase();
    if (emailParam && buyerEmail && buyerEmail !== 'unknown') {
      if (emailParam !== buyerEmail) {
        return res.status(403).json({
          success: false,
          error: 'Email does not match the purchase email. / Email не совпадает с email при покупке.',
        });
      }
    }

    const { productType, productName, sheetName } = platiInfo;

    /* ── 3. Lấy tài khoản từ đúng sheet sản phẩm ────────────────────── */
    const account = await getNextAvailableAccount(sheetName);
    if (!account) {
      return res.status(503).json({
        success: false,
        outOfStock: true,
        productName,
        error: `Hết hàng tạm thời cho ${productName}! Vui lòng liên hệ hỗ trợ.`,
      });
    }

    /* ── 4. Delete from product sheet + save order ──────────────────── */
    await deleteAccountRow(sheetName, account.rowIndex);
    await saveOrder({
      uniqueCode:      code,
      buyerEmail:      platiInfo.buyer,
      accountEmail:    account.email,
      accountPassword: account.password,
      orderId:         platiInfo.orderId,
      productType,
      productName,
    });

    /* ── 5. Trả kết quả ─────────────────────────────────────────────── */
    return res.status(200).json({
      success: true,
      alreadyDelivered: false,
      account: {
        email:    account.email,
        password: account.password,
      },
      order: {
        uniqueCode:  code,
        soldAt:      new Date().toISOString(),
        productType,
        productName,
        orderId:     platiInfo.orderId,
        buyerEmail:  platiInfo.buyer,
      },
    });

  } catch (err) {
    console.error('[verify] Unexpected error:', err);
    return res.status(500).json({
      success: false,
      error: 'Lỗi server nội bộ. Vui lòng thử lại sau hoặc liên hệ hỗ trợ.',
    });
  }
};
