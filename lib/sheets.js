const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

/* ═══════════════════════════════════════════
   AUTH
═══════════════════════════════════════════ */
function getAuth() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT JSON');
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

/* ═══════════════════════════════════════════
   PRODUCT SHEETS
   Sheet names: "CapCut Pro 7 Ngày" | "CapCut Pro 1 Tháng" | "CapCut Pro 6 Tháng"
   Columns: A=ID | B=Email | C=Password | D=Status | E=SoldAt | F=UniqueCode
═══════════════════════════════════════════ */

/**
 * Get the first row with Status = "available" (or empty) from a product sheet.
 * @param {string} sheetName  - e.g. "CapCut Pro 7 Ngày"
 */
async function getNextAvailableAccount(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A:F`,
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {         // Row 0 = header
    const status = (rows[i][3] || '').trim().toLowerCase();
    if (!status || status === 'available') {
      return {
        rowIndex: i + 1,                           // 1-indexed sheet row
        id:       rows[i][0] || String(i),
        email:    rows[i][1] || '',
        password: rows[i][2] || '',
      };
    }
  }
  return null;                                     // Out of stock
}

/**
 * Mark a product row as sold.
 * @param {string} sheetName
 * @param {number} rowIndex    - 1-indexed
 * @param {string} uniqueCode
 */
async function markAccountAsSold(sheetName, rowIndex, uniqueCode) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!D${rowIndex}:F${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['sold', new Date().toISOString(), uniqueCode]],
    },
  });
}

/* ═══════════════════════════════════════════
   ORDERS SHEET  (tab: "Orders")
   Columns: A=UniqueCode | B=BuyerEmail | C=AccountEmail | D=AccountPassword
            E=SoldAt | F=PlatiOrderID | G=ProductType | H=ProductName
═══════════════════════════════════════════ */

async function saveOrder({ uniqueCode, buyerEmail, accountEmail, accountPassword, orderId, productType, productName }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        uniqueCode,
        buyerEmail,
        accountEmail,
        accountPassword,
        new Date().toISOString(),
        orderId,
        productType,
        productName,
      ]],
    },
  });
}

/**
 * Find an order by uniqueCode. Searches the Orders sheet.
 */
async function findOrderByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:H',
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      return {
        uniqueCode:      rows[i][0] || '',
        buyerEmail:      rows[i][1] || '',
        accountEmail:    rows[i][2] || '',
        accountPassword: rows[i][3] || '',
        soldAt:          rows[i][4] || '',
        orderId:         rows[i][5] || '',
        productType:     rows[i][6] || '',
        productName:     rows[i][7] || 'CapCut Pro',
      };
    }
  }
  return null;
}

/* ═══════════════════════════════════════════
   STOCK SUMMARY – all 3 sheets
═══════════════════════════════════════════ */
const PRODUCT_SHEETS = [
  { key: '7d',  name: 'CapCut Pro 7 Ngày',   sheetName: 'CapCut Pro 7 Ngày'   },
  { key: '1m',  name: 'CapCut Pro 1 Tháng',  sheetName: 'CapCut Pro 1 Tháng'  },
  { key: '6m',  name: 'CapCut Pro 6 Tháng',  sheetName: 'CapCut Pro 6 Tháng'  },
];

async function getSheetStock(sheetName) {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!D:D`,
    });
    const rows = (res.data.values || []).slice(1);
    const available = rows.filter(r => {
      const s = (r[0] || '').trim().toLowerCase();
      return !s || s === 'available';
    }).length;
    return { available, total: rows.length, sold: rows.length - available };
  } catch {
    return { available: 0, total: 0, sold: 0, error: 'Sheet not found' };
  }
}

async function getAllStock() {
  const results = await Promise.all(
    PRODUCT_SHEETS.map(async p => ({
      key:  p.key,
      name: p.name,
      ...(await getSheetStock(p.sheetName)),
    }))
  );
  return results;
}

module.exports = {
  getNextAvailableAccount,
  markAccountAsSold,
  saveOrder,
  findOrderByCode,
  getAllStock,
  PRODUCT_SHEETS,
};
