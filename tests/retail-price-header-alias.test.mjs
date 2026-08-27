import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
const normalizeTemplateHeader = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must exist`);
  return html.slice(start, end);
}

test('RETAIL PRICE는 공통 헤더 의미에서 소비자가로 해석된다', () => {
  const source = sourceBetween('function templateHeaderMeaning', 'function templateRepeatedHeaderRowsFromSignatures');
  const templateHeaderMeaning = new Function(
    'normalizeTemplateHeader',
    `${source}; return templateHeaderMeaning;`,
  )(normalizeTemplateHeader);

  assert.equal(templateHeaderMeaning('RETAIL PRICE'), 'retailPrice');
  assert.equal(templateHeaderMeaning('소비자가'), 'retailPrice');
  assert.notEqual(templateHeaderMeaning('PURCHASE PRICE'), 'retailPrice');
  assert.notEqual(templateHeaderMeaning('WHOLESALE PRICE'), 'retailPrice');
});

test('Excel 자동 매핑은 RETAIL PRICE 열을 retailPrice로 유지한다', () => {
  const source = sourceBetween('function templateColumnMap', 'function exactStoredTemplateVersion');
  const templateColumnMap = new Function(
    'normalizeTemplateHeader',
    'excelPreviewValue',
    `${source}; return templateColumnMap;`,
  )(normalizeTemplateHeader, (cell) => cell?.value ?? '');

  const rows = [
    ['상품번호', '제품명', 'RETAIL PRICE', '주문단위', '발주수'],
    ['ABC-1', '테스트 상품', 18000, 12, ''],
  ];
  const getRow = (rowNumber) => ({
    eachCell(_options, callback) {
      (rows[rowNumber - 1] || []).forEach((value, index) => {
        if (value !== '' && value != null) callback({ value }, index + 1);
      });
    },
    getCell(columnNumber) {
      return { value: (rows[rowNumber - 1] || [])[columnNumber - 1] ?? '' };
    },
  });
  const mapping = templateColumnMap({ rowCount: rows.length, getRow });

  assert.equal(mapping.columns.retailPrice, 3);
  assert.equal(mapping.columns.supplierCode, 1);
  assert.equal(mapping.columns.qty, 5);
});

test('일반 상품 가져오기도 RETAIL PRICE를 소비자가 price로 인식한다', () => {
  const normalizeSource = sourceBetween('function normalizeImportHeader', 'Object.keys(importHeaderAliases)');
  const automaticSource = sourceBetween('function automaticImportField', 'function mappedImportField');
  const aliasesMatch = html.match(/var importHeaderAliases=\{([\s\S]*?)\n  \};/);
  assert.ok(aliasesMatch, 'import header aliases must exist');
  const importHeaderAliases = new Function(`return ({${aliasesMatch[1]}});`)();
  const normalizeImportHeader = new Function(
    'cleanText',
    `${normalizeSource}; return normalizeImportHeader;`,
  )((value) => String(value ?? '').trim());
  Object.keys(importHeaderAliases).forEach((key) => {
    importHeaderAliases[key] = importHeaderAliases[key].map(normalizeImportHeader);
  });
  const automaticImportField = new Function(
    'importHeaderAliases',
    `${automaticSource}; return automaticImportField;`,
  )(importHeaderAliases);

  assert.equal(automaticImportField(normalizeImportHeader('RETAIL PRICE')), 'price');
});
