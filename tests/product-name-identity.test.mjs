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
const start = html.indexOf('function templateNameIdentityFields');
const end = html.indexOf('var analyzeSupplierTemplateFileBeforeNameIdentity', start);
assert.ok(start >= 0 && end > start, 'product-name identity helpers must exist');
const source = html.slice(start, end);

const helpers = new Function(
  'positiveTemplateInteger',
  'excelPreviewValue',
  `${source}; return { templateNameIdentityFields, resolveTemplateNameIdentityRows };`,
)(
  (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
  (cell) => cell.value ?? '',
);

function sheetFromRows(rows) {
  return {
    name: '동명 테스트',
    rowCount: rows.length,
    getRow(rowNumber) {
      const values = rows[rowNumber - 1] || [];
      return {
        getCell(column) { return { value: values[column - 1] ?? '' }; },
      };
    },
  };
}

const columns = { productName: 1, option: 2, size: 3, barcode: 4, styleNo: 5, retailPrice: 6, qty: 7 };
const mapping = { row: 1, dataStartRow: 2, dataEndRow: 4, columns };
const contract = { dataEndRow: 4, rowMatchParts: ['productName', 'option', 'size', 'barcode', 'styleNo'] };

test('unique names match by name while same names use option, size, barcode, or STYLE NO', () => {
  const sheet = sheetFromRows([
    ['상품명', '옵션', '사이즈', '바코드', 'STYLE NO', '가격', '수량'],
    ['노트', '빨강', 'A5', '0001', 'ST-1', 5000, ''],
    ['노트', '파랑', 'A6', '0002', 'ST-2', 7000, ''],
    ['연필', '', '', '', '', 1000, ''],
  ]);
  const result = helpers.resolveTemplateNameIdentityRows(sheet, mapping, contract, [
    { productName: '노트', option: '파랑', barcode: '0002', templateCellsByColumn: { 3: 'A6', 5: 'ST-2' }, retailPrice: 999999, qty: 22 },
    { productName: '연필', retailPrice: 999999, qty: 33 },
  ]);
  assert.deepEqual(result.resolved.map((entry) => entry.targetRow), [3, 4]);
  assert.deepEqual(helpers.templateNameIdentityFields(columns), ['productName', 'option', 'size', 'barcode', 'styleNo']);
});

test('price and quantity differences cannot disambiguate same-name rows', () => {
  const sheet = sheetFromRows([
    ['상품명', '옵션', '사이즈', '바코드', 'STYLE NO', '가격', '수량'],
    ['노트', '', '', '', '', 5000, ''],
    ['노트', '', '', '', '', 7000, ''],
  ]);
  assert.throws(
    () => helpers.resolveTemplateNameIdentityRows(sheet, { ...mapping, dataEndRow: 3 }, { ...contract, dataEndRow: 3 }, [{ productName: '노트', retailPrice: 7000, qty: 2 }]),
    /옵션·사이즈·바코드·STYLE NO로 구분하지 못했습니다/,
  );
});
