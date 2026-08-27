import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAllowedGoogleExportUrl, validateSpreadsheetExport } from '../server.mjs';

function decodeSrcdoc(raw) {
  const start = raw.indexOf('srcdoc="') + 8;
  const end = raw.lastIndexOf('"></iframe>');
  return raw.slice(start, end)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const raw = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const html = decodeSrcdoc(raw);
const apiUrlStart = html.indexOf('function spreadsheetApiUrl');
const apiUrlEnd = html.indexOf('function spreadsheetInspectorUrl', apiUrlStart);
assert.ok(apiUrlStart >= 0 && apiUrlEnd > apiUrlStart, 'spreadsheet API URL helpers must exist');
const apiUrlSource = html.slice(apiUrlStart, apiUrlEnd);
const spreadsheetApiUrl = new Function(`${apiUrlSource}; return spreadsheetApiUrl;`)();

test('srcdoc resolves inspect and export APIs to the deployed Supabase function', () => {
  assert.equal(spreadsheetApiUrl('inspect'), 'https://guonupybxnclgiiltsrr.supabase.co/functions/v1/google-sheets/inspect');
  assert.equal(spreadsheetApiUrl('export'), 'https://guonupybxnclgiiltsrr.supabase.co/functions/v1/google-sheets/export');
  assert.match(html, /function spreadsheetInspectorUrl\(\) \{ return spreadsheetApiUrl\('inspect'\); \}/);
  assert.match(html, /function spreadsheetExporterUrl\(\) \{ return spreadsheetApiUrl\('export'\); \}/);
  assert.match(html, /function spreadsheetRequestHeaders\(\).*'apikey':preludeSupabasePublishableKey/);
  assert.match(raw, /connect-src[^\"]*https:\/\/guonupybxnclgiiltsrr\.supabase\.co/);
  assert.match(raw, /img-src 'self'[^\"]*blob:/);
  assert.match(raw, /connect-src 'self'[^\"]*https:\/\/guonupybxnclgiiltsrr\.supabase\.co/);
  assert.match(html, /img-src 'self'[^\"]*blob:/);
  assert.match(html, /connect-src 'self'[^\"]*https:\/\/guonupybxnclgiiltsrr\.supabase\.co/);
});

test('Google XLSX export only accepts HTTPS Google destinations', () => {
  assert.equal(isAllowedGoogleExportUrl('https://docs.google.com/spreadsheets/d/example/export?format=xlsx'), true);
  assert.equal(isAllowedGoogleExportUrl('https://drive.usercontent.google.com/download?id=example'), true);
  assert.equal(isAllowedGoogleExportUrl('http://docs.google.com/spreadsheets/d/example/export'), false);
  assert.equal(isAllowedGoogleExportUrl('https://docs.google.com.evil.example/export'), false);
  assert.equal(isAllowedGoogleExportUrl('https://evil.example/?next=https://docs.google.com'), false);
});

test('Google XLSX export rejects HTML, invalid MIME, and oversized payloads', () => {
  const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
  assert.equal(validateSpreadsheetExport(xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), xlsx);
  assert.throws(() => validateSpreadsheetExport(Buffer.from('<html>login</html>'), 'text/html'), /Excel 파일로 내려오지 않았습니다/);
  assert.throws(() => validateSpreadsheetExport(xlsx, 'text/html'), /올바른 Excel 형식/);
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 0);
  oversized[0] = 0x50;
  oversized[1] = 0x4b;
  assert.throws(() => validateSpreadsheetExport(oversized, 'application/zip'), /20MB 이하/);
});

test('new order preview, download, and order snapshot share the Google spreadsheet XLSX version', () => {
  assert.match(html, /\/functions\/v1\/google-sheets\//);
  assert.match(html, /sourceType:'GOOGLE_SHEETS_SNAPSHOT'/);
  assert.match(html, /await syncSupplierSpreadsheetSnapshot\(previewSupplier,\{force:false\}\)/);
  assert.match(html, /await ensureDraftSpreadsheetPreview\(draftSupplier\)/);
  assert.match(html, /downloadDraftSpreadsheetWorkbook\(draftSupplier\)/);
  assert.match(html, /xlsxSha256:version\.xlsxSha256\|\|null/);
  assert.match(html, /data-template-preview-sha256/);
  assert.match(html, /mappingSource:'GOOGLE_SHEETS_PUBLIC_STRUCTURE'/);
  assert.match(html, /allowNewRows:true/);
  assert.match(html, /normalizeGoogleSpreadsheetCatalog/);
  assert.match(html, /window\.parent\.location\.href/);
  assert.match(html, /file:\/\/.*http:\/\/127\.0\.0\.1:4173\/index\.html/);
  assert.doesNotMatch(
    html.slice(html.indexOf("#mb-download-draft-xlsx"), html.indexOf("#mb-start-order")),
    /downloadMidoriWorkbook/,
  );
});

test('unreviewed tab or required-structure changes block a new order from using a stale template', () => {
  assert.match(html, /supplier\.spreadsheetStatus!==['"]VERIFIED['"]/);
  assert.match(html, /스프레드시트 탭 또는 필수 열 변경을 확인한 뒤 최신 양식을 적용/);
  assert.match(html, /Google 스프레드시트의 탭·필수 구조 변경을 확인하고 최신 양식을 적용/);
});
