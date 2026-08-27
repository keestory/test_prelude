import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.PRELUDE_PORT || 4173);
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const spreadsheetIdPattern = /^[A-Za-z0-9_-]{20,100}$/;
const responseCache = new Map();
const maxSpreadsheetExportBytes = 20 * 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(body));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

function normalizeHeader(value) {
  return decodeHtml(value).normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s_./·()-]+/g, '');
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'PRELUDE-Sheet-Inspector/1.0' },
    });
    if (!response.ok) {
      const error = new Error(`Google 스프레드시트 응답 오류 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function isAllowedGoogleExportUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      hostname === 'docs.google.com'
      || hostname === 'drive.google.com'
      || hostname === 'drive.usercontent.google.com'
      || hostname.endsWith('.googleusercontent.com')
    );
  } catch {
    return false;
  }
}

export function validateSpreadsheetExport(buffer, contentType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    const error = new Error('Google 스프레드시트가 Excel 파일로 내려오지 않았습니다. 공유 권한을 확인해 주세요.');
    error.status = 422;
    throw error;
  }
  if (buffer.length > maxSpreadsheetExportBytes) {
    const error = new Error('Google 스프레드시트 Excel 파일은 20MB 이하만 사용할 수 있습니다.');
    error.status = 413;
    throw error;
  }
  if (contentType && !/(spreadsheetml|octet-stream|zip)/i.test(contentType)) {
    const error = new Error('Google 스프레드시트가 올바른 Excel 형식으로 응답하지 않았습니다.');
    error.status = 422;
    throw error;
  }
  return buffer;
}

async function fetchSpreadsheetExport(spreadsheetId) {
  const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(exportUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'PRELUDE-Sheet-Exporter/1.0' },
    });
    if (!response.ok) {
      const error = new Error(`Google 스프레드시트 Excel 내보내기 오류 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (!isAllowedGoogleExportUrl(response.url)) {
      const error = new Error('허용되지 않은 주소로 연결되어 Excel 내보내기를 중단했습니다.');
      error.status = 502;
      throw error;
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxSpreadsheetExportBytes) {
      const error = new Error('Google 스프레드시트 Excel 파일은 20MB 이하만 사용할 수 있습니다.');
      error.status = 413;
      throw error;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxSpreadsheetExportBytes) {
        const error = new Error('Google 스프레드시트 Excel 파일은 20MB 이하만 사용할 수 있습니다.');
        error.status = 413;
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    return {
      buffer: validateSpreadsheetExport(buffer, response.headers.get('content-type') || ''),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseSpreadsheetTabs(html) {
  const entryPattern = /\[21350203,"((?:\\.|[^"\\])*)"\]/g;
  const tabs = [];
  let match;
  while ((match = entryPattern.exec(html))) {
    let inner;
    let entry;
    try {
      inner = JSON.parse(`"${match[1]}"`);
      entry = JSON.parse(inner);
    } catch {
      continue;
    }
    if (!Array.isArray(entry) || entry.length < 6 || typeof entry[0] !== 'number' || !/^\d+$/.test(String(entry[2]))) continue;
    const titleMatch = JSON.stringify(entry).match(/\[0,0,"([^"]+)"\]/);
    if (!titleMatch) continue;
    tabs.push({
      sheetIndex: entry[0],
      sheetId: Number(entry[2]),
      title: titleMatch[1],
      rowCount: Number(entry.at(-2)) || 0,
      columnCount: Number(entry.at(-1)) || 0,
      hidden: false,
    });
  }
  return tabs.sort((left, right) => left.sheetIndex - right.sheetIndex);
}

export function parseSheetRows(html, sheetId) {
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html))) {
    const idMatch = rowMatch[1].match(new RegExp(`id=["']${sheetId}R(\\d+)["']`));
    if (!idMatch) continue;
    const cells = [];
    const cellPattern = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) cells.push(decodeHtml(cellMatch[2]));
    rows.push({ row: Number(idMatch[1]) + 1, cells, source: rowMatch[0] });
    if (rows.length >= 120) break;
  }
  return rows;
}

function findHeaderColumn(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  const index = headers.findIndex((header) => normalizedCandidates.includes(normalizeHeader(header)));
  return index < 0 ? null : index + 1;
}

export function analyzeSheetHtml(html, tab) {
  const rows = parseSheetRows(html, tab.sheetId);
  const productNameHeaders = ['제품명', '상품명', '상품명(KR)', '상품명(한글)', '상품명(영문)', 'product name', '품명'];
  const quantityHeaders = ['발주수', '발주수량', '발주량', '발주개수', '주문수', '주문수량', '주문량', '주문개수', '수량', '개수', 'qty', 'quantity', 'count', 'order qty', 'order quantity'];
  const headerRow = rows.find((row) => {
    const key = findHeaderColumn(row.cells, productNameHeaders);
    const qty = findHeaderColumn(row.cells, quantityHeaders);
    return key && qty;
  });
  const headers = headerRow ? headerRow.cells : [];
  const productNameColumn = findHeaderColumn(headers, productNameHeaders);
  const keyColumn = productNameColumn;
  const keyField = keyColumn ? 'productName' : null;
  const qtyColumn = findHeaderColumn(headers, quantityHeaders);
  const optionColumn = findHeaderColumn(headers, ['옵션', 'Option', 'Option(Ko/En)', '색상규격']);
  const sizeColumn = findHeaderColumn(headers, ['사이즈', 'Size', '규격', 'size(W x L x Hmm)']);
  const barcodeColumn = findHeaderColumn(headers, ['바코드', 'Barcode', 'EAN13', 'GTIN']);
  const styleNoColumn = findHeaderColumn(headers, ['STYLE NO', 'STYLE NO.', 'STYLE NUMBER', '스타일NO', '스타일번호']);
  const imageColumn = findHeaderColumn(headers, ['제품이미지', '상품이미지', '이미지', 'product image', 'image', 'picture', 'photo']);
  const orderUnitColumn = findHeaderColumn(headers, ['주문단위', '입수', '포장단위']);
  const retailPriceColumn = findHeaderColumn(headers, ['소비자가', '정가', '판매가', 'RETAIL PRICE', '가격(RRP)', 'RRP']);
  const amountColumn = findHeaderColumn(headers, ['금액', '금 액', '합계금액']);
  const dataRow = headerRow && keyColumn && rows.find((row) => row.row > headerRow.row && String(row.cells[keyColumn - 1] || '').trim() !== '');
  const dataStartRow = headerRow ? dataRow?.row || (tab.rowCount > headerRow.row ? headerRow.row + 1 : null) : null;
  const valid = Boolean(headerRow && keyColumn && qtyColumn && keyColumn !== qtyColumn);
  const structureSignature = hash(JSON.stringify({
    headers: headers.map(normalizeHeader),
    headerRow: headerRow?.row || null,
    dataStartRow,
    keyColumn,
    qtyColumn,
  }));
  const formatSignature = hash(rows.slice(0, 40).map((row) => row.source.replace(/>([^<]*)</g, '><').replace(/\s+/g, ' ')).join(''));
  return {
    ...tab,
    headerRow: headerRow?.row || null,
    dataStartRow,
    headers,
    columns: { key: keyColumn, keyField, productName: productNameColumn, option: optionColumn, size: sizeColumn, barcode: barcodeColumn, styleNo: styleNoColumn, identityFields: ['productName', 'option', 'size', 'barcode', 'styleNo'].filter((field) => ({ productName: productNameColumn, option: optionColumn, size: sizeColumn, barcode: barcodeColumn, styleNo: styleNoColumn })[field]), image: imageColumn, retailPrice: retailPriceColumn, orderUnit: orderUnitColumn, qty: qtyColumn, amount: amountColumn },
    structureSignature,
    formatSignature,
    status: valid ? 'CONFIRMED' : 'NEEDS_REVIEW',
    issues: valid ? [] : [
      !keyColumn ? '상품명 열을 자동으로 확인하지 못했습니다.' : null,
      !qtyColumn ? '발주수량 열을 자동으로 확인하지 못했습니다.' : null,
      keyColumn && qtyColumn && keyColumn === qtyColumn ? '상품 식별 열과 발주수량 열은 서로 달라야 합니다.' : null,
    ].filter(Boolean),
  };
}

function spreadsheetTitle(html) {
  const title = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1]
    || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
    || 'Google 스프레드시트';
  return decodeHtml(title).replace(/\s+-\s+Google (Sheets|Drive).*$/i, '');
}

async function inspectPublicSpreadsheet(spreadsheetId) {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  const workbookHtml = await fetchText(`${base}?usp=sharing`);
  const tabs = parseSpreadsheetTabs(workbookHtml);
  if (!tabs.length) {
    const error = new Error('공개된 스프레드시트 탭을 읽지 못했습니다. 공유 권한을 확인해 주세요.');
    error.status = 403;
    throw error;
  }
  const analyzedTabs = [];
  for (const tab of tabs) {
    const tabHtml = tab.sheetIndex === 0 ? workbookHtml : await fetchText(`${base}?gid=${tab.sheetId}#gid=${tab.sheetId}`);
    analyzedTabs.push(analyzeSheetHtml(tabHtml, tab));
  }
  const checkedAt = new Date().toISOString();
  return {
    spreadsheetId,
    spreadsheetTitle: spreadsheetTitle(workbookHtml),
    checkedAt,
    sourceType: 'PUBLIC_GOOGLE_SHEETS',
    workbookSignature: hash(analyzedTabs.map((tab) => `${tab.sheetId}:${tab.structureSignature}:${tab.formatSignature}`).join('|')),
    tabs: analyzedTabs,
  };
}

async function readRequestBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error('요청이 너무 큽니다.');
  }
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigin = !origin || origin === 'null' || origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
  if (!allowedOrigin) return json(res, 403, { error: '허용되지 않은 요청 출처입니다.' });
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'POST' && req.url === '/api/google-sheets/inspect') {
    try {
      const { spreadsheetId } = await readRequestBody(req);
      if (!spreadsheetIdPattern.test(String(spreadsheetId || ''))) return json(res, 400, { error: '올바른 Google 스프레드시트 ID가 아닙니다.' });
      const cacheKey = String(spreadsheetId);
      const cached = responseCache.get(cacheKey);
      if (cached && Date.now() - cached.savedAt < 5000) return json(res, 200, cached.value);
      const value = await inspectPublicSpreadsheet(cacheKey);
      if (responseCache.size >= 100) responseCache.delete(responseCache.keys().next().value);
      responseCache.set(cacheKey, { savedAt: Date.now(), value });
      return json(res, 200, value);
    } catch (error) {
      const status = Number(error?.status) || (error?.name === 'AbortError' ? 504 : 502);
      return json(res, status, { error: error?.message || 'Google 스프레드시트를 읽지 못했습니다.' });
    }
  }
  if (req.method === 'POST' && req.url === '/api/google-sheets/export') {
    try {
      const { spreadsheetId } = await readRequestBody(req);
      if (!spreadsheetIdPattern.test(String(spreadsheetId || ''))) return json(res, 400, { error: '올바른 Google 스프레드시트 ID가 아닙니다.' });
      const exported = await fetchSpreadsheetExport(String(spreadsheetId));
      res.writeHead(200, {
        'content-type': exported.contentType,
        'content-length': exported.buffer.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return res.end(exported.buffer);
    } catch (error) {
      const status = Number(error?.status) || (error?.name === 'AbortError' ? 504 : 502);
      return json(res, status, { error: error?.message || 'Google 스프레드시트 Excel 파일을 가져오지 못했습니다.' });
    }
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = await readFile(path.join(rootDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    } catch {
      return res.writeHead(500).end('index.html을 읽지 못했습니다.');
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    console.log(`PRELUDE running at http://${host}:${port}/index.html`);
  });
}
