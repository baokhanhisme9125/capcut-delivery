const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

function getAuth() {
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT JSON'); }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

/* ─────────────────────────────────────────────────────────────
   PRODUCT SHEETS  ("CapCut Pro 7 Ngày" / "CapCut Pro 1 Tháng" / "CapCut Pro 6 Tháng")
   Column A only:  Email:Password
   Example row:    acc1@email.com:Pass@123
───────────────────────────────────────────────────────────── */

/**
 * Get the first account from a product sheet.
 * Skips the header row (row 1) automatically if it contains "email" or ":".
 * Returns { rowIndex, email, password } or null if empty.
 */
async function getNextAvailableAccount(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A:A`,
  });

  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell) continue;
    // Skip header row (if cell doesn't contain ":" it's a header like "Email:Password")
    if (!cell.includes(':')) continue;

    const colonIdx = cell.indexOf(':');
    const email    = cell.slice(0, colonIdx).trim();
    const password = cell.slice(colonIdx + 1).trim();

    if (!email || !password) continue;

    return {
      rowIndex: i + 1,   // 1-indexed sheet row
      email,
      password,
    };
  }
  return null; // Out of stock
}

/**
 * Delete the delivered row from the product sheet.
 * This "moves" the account out of stock automatically.
 */
async function deleteAccountRow(sheetName, rowIndex) {
  const sheets = await getSheetsClient();

  // Get sheet ID for batchUpdate
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId:    sheet.properties.sheetId,
            dimension:  'ROWS',
            startIndex: rowIndex - 1,   // 0-indexed (convert from 1-indexed)
            endIndex:   rowIndex,       // exclusive
          },
        },
      }],
    },
  });
}

/* ─────────────────────────────────────────────────────────────
   ORDERS SHEET  (tab: "Orders")
   A: UniqueCode | B: BuyerEmail | C: Account (Email:Password)
   D: SoldAt | E: PlatiOrderID | F: ProductType | G: ProductName
   H: DeliveryLink
───────────────────────────────────────────────────────────── */

async function saveOrder({ uniqueCode, buyerEmail, accountEmail, accountPassword, orderId, productType, productName }) {
  const sheets = await getSheetsClient();
  const deliveryLink = `https://capcut-delivery-hrzf.vercel.app/delivery.html?uniquecode=${encodeURIComponent(uniqueCode)}&email=${encodeURIComponent(buyerEmail)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        uniqueCode,
        buyerEmail,
        `${accountEmail}:${accountPassword}`,
        new Date().toISOString(),
        orderId,
        productType,
        productName,
        deliveryLink,
      ]],
    },
  });
}

async function savePendingOrder({ uniqueCode, buyerEmail, orderId, productType, productName }) {
  const sheets = await getSheetsClient();
  const deliveryLink = `https://capcut-delivery-hrzf.vercel.app/delivery.html?uniquecode=${encodeURIComponent(uniqueCode)}&email=${encodeURIComponent(buyerEmail)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        uniqueCode,
        buyerEmail,
        '',  // Column C blank — seller fills manually
        new Date().toISOString(),
        orderId,
        productType,
        productName,
        deliveryLink,
      ]],
    },
  });
}

async function findOrderByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:G',
  });

  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      // Parse Account column C: "email:password"
      const accountCell = rows[i][2] || '';
      const colonIdx    = accountCell.indexOf(':');
      const accountEmail    = colonIdx >= 0 ? accountCell.slice(0, colonIdx).trim() : accountCell;
      const accountPassword = colonIdx >= 0 ? accountCell.slice(colonIdx + 1).trim() : '';

      return {
        uniqueCode:      rows[i][0] || '',
        buyerEmail:      rows[i][1] || '',
        accountEmail,
        accountPassword,
        soldAt:          rows[i][3] || '',
        orderId:         rows[i][4] || '',
        productType:     rows[i][5] || '',
        productName:     rows[i][6] || 'CapCut Pro',
        isPending:       !accountCell.includes(':'),
      };
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────
   STOCK SUMMARY
───────────────────────────────────────────────────────────── */
const PRODUCT_SHEETS = [
  { key: '7d', name: 'CapCut Pro 7 Ngày',  sheetName: 'CapCut Pro 7 Ngày'  },
  { key: '1m', name: 'CapCut Pro 1 Tháng', sheetName: 'CapCut Pro 1 Tháng' },
  { key: '6m', name: 'CapCut Pro 6 Tháng', sheetName: 'CapCut Pro 6 Tháng' },
];

async function getSheetStock(sheetName) {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A:A`,
    });
    const rows = (res.data.values || []).filter(r => {
      const c = (r[0] || '').trim();
      return c.includes(':');    // valid Email:Password rows
    });
    return { available: rows.length, total: rows.length };
  } catch {
    return { available: 0, total: 0, error: 'Sheet not found' };
  }
}

async function getAllStock() {
  return Promise.all(
    PRODUCT_SHEETS.map(async p => ({
      key:  p.key,
      name: p.name,
      ...(await getSheetStock(p.sheetName)),
    }))
  );
}

module.exports = {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  savePendingOrder,
  findOrderByCode,
  getAllStock,
  PRODUCT_SHEETS,
};
