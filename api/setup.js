/**
 * /api/setup
 * One-time setup: writes header rows to Orders sheet and
 * creates example header rows for the 3 product sheets.
 * Call once after deploy: GET /api/setup?token=YOUR_ADMIN_TOKEN
 */
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN || 'capcut-setup-2025';

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

async function writeIfEmpty(sheets, sheetName, headers) {
  // Check if sheet already has data
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A1`,
  });
  const existing = (res.data.values || [])[0]?.[0] || '';
  if (existing) return { sheet: sheetName, status: 'skipped (already has data)' };

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers] },
  });
  return { sheet: sheetName, status: 'headers written ✓' };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = req.query.token || '';
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }

  try {
    const sheets = await getSheetsClient();
    const results = await Promise.all([

      // Orders tab – 7 columns
      writeIfEmpty(sheets, 'Orders', [
        'UniqueCode', 'BuyerEmail', 'Account (Email:Password)',
        'SoldAt', 'PlatiOrderID', 'ProductType', 'ProductName',
      ]),

      // Product tabs – single column header
      writeIfEmpty(sheets, 'CapCut Pro 7 Ngày',  ['Email:Password']),
      writeIfEmpty(sheets, 'CapCut Pro 1 Tháng', ['Email:Password']),
      writeIfEmpty(sheets, 'CapCut Pro 6 Tháng', ['Email:Password']),
    ]);

    return res.status(200).json({
      success: true,
      message: 'Setup complete! All sheet headers initialized.',
      results,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
