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
   Column A only:  Email:Password  (also accepts Email;Password)
   Example row:    acc1@email.com:Pass@123
───────────────────────────────────────────────────────────── */

const ORDERS_SHEET = 'Orders';

/**
 * Parse a stock cell into { email, password }.
 * Accepts both email:password and email;password.
 * Returns null if malformed.
 */
function parseAccountCell(cell) {
  if (!cell || cell.startsWith('CLAIMED:') || cell.startsWith('FORMAT_ERROR:')) return null;
  const atIdx = cell.indexOf('@');
  let sepIdx = -1, sep = null;
  if (atIdx >= 0) {
    const c = cell.indexOf(':', atIdx + 1);
    const s = cell.indexOf(';', atIdx + 1);
    if (c >= 0 && (s < 0 || c <= s)) { sepIdx = c; sep = ':'; }
    else if (s >= 0)                  { sepIdx = s; sep = ';'; }
  } else {
    const c = cell.indexOf(':'); const s = cell.indexOf(';');
    if (c >= 0 && (s < 0 || c <= s)) { sepIdx = c; sep = ':'; }
    else if (s >= 0)                  { sepIdx = s; sep = ';'; }
  }
  if (sepIdx < 0 || !sep) return null;
  const email = cell.slice(0, sepIdx).trim();
  const password = cell.slice(sepIdx + 1).trim();
  if (!email || !password || !email.includes('@')) return null;
  return { email, password };
}


/**
 * Build a Set of account strings (email:password) already present in Column C
 * of the Orders sheet, so we never re-deliver the same account.
 */
async function getDeliveredAccountSet(sheets, ordersSheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${ordersSheetName || 'Orders'}'!C:C`,
    });
    const rows = res.data.values || [];
    const used = new Set();
    for (const row of rows) {
      const cell = (row[0] || '').trim().toLowerCase();
      if (cell && cell.includes(':')) used.add(cell);
    }
    return used;
  } catch {
    return new Set();
  }
}

/**
 * Atomically claim the next available account using optimistic locking
 * + duplicate-account guard.
 *
 * Strategy (serverless-safe, works across multiple Vercel instances):
 *   1. Pre-load all already-delivered accounts from Orders Col C into a Set.
 *   2. Read all rows from the product sheet.
 *   3. Find first row that:
 *      a. Looks like "email:password" (no CLAIMED: prefix)
 *      b. Is NOT already in the delivered-accounts Set
 *   4. Overwrite that cell with "CLAIMED:<uniqueCode>" marker.
 *   5. Wait a short random delay, then re-read the cell.
 *   6. If the cell still has OUR marker → we own it. Return { rowIndex, email, password }.
 *   7. If someone else's marker is there → try the next row.
 *   8. If no rows available → return null (Out of Stock).
 */
async function getNextAvailableAccount(sheetName, uniqueCode) {
  const sheets = await getSheetsClient();

  const [stockRes, deliveredSet] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A:A`,
    }),
    getDeliveredAccountSet(sheets, ORDERS_SHEET),
  ]);

  const rows = stockRes.data.values || [];

  // Guard: if this uniqueCode is already claimed, another process is handling it
  if (uniqueCode) {
    const alreadyClaimed = rows.some(r => (r[0] || '').trim() === `CLAIMED:${uniqueCode}`);
    if (alreadyClaimed) {
      console.log(`[sheets] CLAIMED:${uniqueCode} already exists — waiting for other process...`);
      await new Promise(r => setTimeout(r, 800));
      return null;
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell) continue;
    if (cell.startsWith('CLAIMED:')) continue;
    if (cell.startsWith('FORMAT_ERROR:')) continue;

    const parsed = parseAccountCell(cell);
    if (!parsed) {
      if (cell.includes(':') || cell.includes(';') || cell.includes('@')) {
        console.warn(`[sheets] FORMAT_ERROR row ${i + 1}: "${cell.slice(0, 60)}"`);
        try {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${sheetName}'!A${i + 1}`,
            valueInputOption: 'RAW',
            requestBody: { values: [[`FORMAT_ERROR: ${cell}`]] },
          });
        } catch (e) { console.warn('[sheets] Could not write FORMAT_ERROR:', e.message); }
      }
      continue;
    }
    const { email, password } = parsed;

    // ── Duplicate guard: skip if this account was already delivered ──
    const normalized = `${email}:${password}`.toLowerCase();
    if (deliveredSet.has(normalized)) {
      console.warn(`[sheets] Skipping already-delivered account at row ${i + 1}: ${email}`);
      continue;
    }

    // ── Attempt to claim this row ──
    const claimMark = `CLAIMED:${uniqueCode || Date.now()}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[claimMark]] },
      });
    } catch (writeErr) {
      console.warn(`[sheets] Claim write failed row ${i + 1}:`, writeErr.message);
      continue;
    }

    // ── Wait a short random delay, then verify we own it ──
    await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));

    let verifyCell = '';
    try {
      const vRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A${i + 1}`,
      });
      verifyCell = (vRes.data.values?.[0]?.[0] || '').trim();
    } catch (readErr) {
      console.warn(`[sheets] Claim verify read failed row ${i + 1}:`, readErr.message);
      continue;
    }

    if (verifyCell === claimMark) {
      return { rowIndex: i + 1, email, password };
    }

    console.warn(`[sheets] Row ${i + 1} race lost (got: ${verifyCell.slice(0, 40)}), trying next`);
  }

  return null; // Out of stock
}

/**
 * Delete ALL rows with the given CLAIMED marker (handles webhook+verify race duplicates).
 * Falls back to index-based delete if no claimMark provided.
 */
async function deleteAccountRow(sheetName, rowIndex, claimMark) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const sheetId = sheet.properties.sheetId;

  if (claimMark) {
    // Find ALL rows with this marker
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `'${sheetName}'!A:A`,
    });
    const allRows = res.data.values || [];
    const indices = [];
    for (let i = 0; i < allRows.length; i++) {
      if ((allRows[i][0] || '').trim() === claimMark) indices.push(i);
    }
    if (indices.length > 1) console.warn(`[sheets] deleteAccountRow: deleting ${indices.length} duplicate markers for ${claimMark}`);
    // Delete in reverse order
    for (let j = indices.length - 1; j >= 0; j--) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: indices[j], endIndex: indices[j] + 1 } } }] },
        });
      } catch (e) { console.warn(`[sheets] deleteAccountRow failed index ${indices[j]}:`, e.message); }
    }
    return;
  }

  // Legacy fallback: index-based
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }] },
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

/**
 * Return ALL orders matching a uniqueCode (for duplicate detection).
 * Each entry includes `rowIndex` (1-based) for deletion.
 */
async function findAllOrdersByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:G',
  });

  const rows = res.data.values || [];
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      const accountCell = rows[i][2] || '';
      const colonIdx    = accountCell.indexOf(':');
      matches.push({
        rowIndex:        i + 1,   // 1-based for Sheets API
        uniqueCode:      rows[i][0] || '',
        buyerEmail:      rows[i][1] || '',
        accountEmail:    colonIdx >= 0 ? accountCell.slice(0, colonIdx).trim() : accountCell,
        accountPassword: colonIdx >= 0 ? accountCell.slice(colonIdx + 1).trim() : '',
        soldAt:          rows[i][3] || '',
        orderId:         rows[i][4] || '',
        productType:     rows[i][5] || '',
        productName:     rows[i][6] || 'CapCut Pro',
        isPending:       !accountCell.includes(':'),
      });
    }
  }
  return matches;
}

/**
 * Delete a specific row in the Orders sheet by 1-based rowIndex.
 */
async function deleteOrderRow(rowIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === ORDERS_SHEET);
  if (!sheet) throw new Error('Orders sheet not found');
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      }],
    },
  });
}


async function findRecentOrderByEmail(buyerEmail, windowMs = 10 * 60 * 1000) {
  if (!buyerEmail || buyerEmail === 'unknown') return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:G',
  });
  const rows = res.data.values || [];
  const now = Date.now();
  const email = buyerEmail.trim().toLowerCase();
  let bestMatch = null;
  for (let i = 0; i < rows.length; i++) {
    const rowEmail = (rows[i][1] || '').trim().toLowerCase();
    if (rowEmail !== email) continue;
    const soldAt = rows[i][3] || '';
    const orderTime = new Date(soldAt).getTime();
    if (isNaN(orderTime) || now - orderTime > windowMs) continue;
    const accountCell = rows[i][2] || '';
    const colonIdx = accountCell.indexOf(':');
    bestMatch = {
      uniqueCode: rows[i][0]||'', buyerEmail: rows[i][1]||'',
      accountEmail: colonIdx>=0?accountCell.slice(0,colonIdx).trim():accountCell,
      accountPassword: colonIdx>=0?accountCell.slice(colonIdx+1).trim():'',
      soldAt, orderId: rows[i][4]||'', productType: rows[i][5]||'',
      productName: rows[i][6]||'CapCut Pro',
      isPending: !accountCell.includes(':'),
    };
  }
  return bestMatch;
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
  findAllOrdersByCode,
  deleteOrderRow,
  findRecentOrderByEmail,
  getAllStock,
  PRODUCT_SHEETS,
};
