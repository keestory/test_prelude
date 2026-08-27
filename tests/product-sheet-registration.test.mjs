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
const helperStart = html.indexOf('function productSheetBindingFor');
const helperEnd = html.indexOf('function captureProductSheetDraft', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'product sheet schema helpers must exist');
const helperSource = html.slice(helperStart, helperEnd);

function schemaFor(sheetId, headers) {
  const bindings = {
    MIDORI: [{
      entityId: 'BRAND',
      status: 'CONFIRMED',
      confirmedRole: 'COLLECTION_PRODUCT',
      sheetId,
      sheetName: `Template_${sheetId}`,
      headerRow: 2,
      dataStartRow: 3,
      structureSignature: `structure-${sheetId}`,
      headers,
    }],
  };
  const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
  const meaning = (label) => ({
    상품번호: 'supplierCode',
    제품명: 'productName',
    제품이미지: 'image',
    소비자가: 'retailPrice',
    'RETAIL PRICE': 'retailPrice',
    'Cat.1': 'category1',
    'Cat.2': 'category2',
    'size (W x L x Hmm)': 'size',
    주문단위: 'orderUnit',
    발주수: 'qty',
    '금 액': 'amount',
  })[label] || 'unknown';
  const helpers = new Function(
    'supplierSheetBindings',
    'cleanText',
    'isProductSheetRole',
    'normalizeTemplateHeader',
    'normalizeBrandName',
    'templateHeaderMeaning',
    'excelColumnName',
    `${helperSource}; return { productSheetBindingFor, productSheetSchemaFor };`,
  )(
    bindings,
    (value) => String(value || '').trim(),
    (role) => ['BRAND_PRODUCT', 'COLLECTION_PRODUCT', 'CATEGORY_PRODUCT', 'PRODUCT_LIST'].includes(role),
    normalize,
    (value) => String(value || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim(),
    meaning,
    (index) => String.fromCharCode(64 + index),
  );
  const supplier = { id: 'MIDORI', spreadsheetId: '1lZsRQbHxYIz0qlMlEjC_3Q4skK9nm04rzDKrAHw_RwI' };
  const scope = { id: 'BRAND', name: '테스트 브랜드' };
  const binding = helpers.productSheetBindingFor('MIDORI', 'BRAND');
  return helpers.productSheetSchemaFor(supplier, scope, binding);
}

test('gid 739393750은 연결된 A~G 7개 컬럼을 상품 등록 필드로 만든다', () => {
  const schema = schemaFor(739393750, ['상품번호', '제품명', '제품이미지', '소비자가', '주문단위', '발주수', '금 액']);
  assert.equal(schema.sheetId, 739393750);
  assert.deepEqual(schema.fields.map((field) => field.label), ['상품번호', '제품명', '제품이미지', '소비자가', '주문단위', '발주수', '금 액']);
  assert.equal(schema.fields.find((field) => field.label === '발주수').readOnly, true);
  assert.equal(schema.fields.find((field) => field.label === '금 액').readOnly, true);
});

test('gid 673192706으로 브랜드를 바꾸면 H열 Others가 추가된다', () => {
  const schema = schemaFor(673192706, ['상품번호', '제품명', '제품이미지', '소비자가', '주문단위', '발주수', '금 액', 'Others']);
  assert.equal(schema.sheetId, 673192706);
  assert.equal(schema.fields.length, 8);
  assert.equal(schema.fields.at(-1).label, 'Others');
  assert.equal(schema.fields.at(-1).semantic, 'unknown');
  assert.equal(schema.fields.at(-1).columnLetter, 'H');
});

test('RETAIL PRICE 원본 헤더를 보존하면서 소비자가 숫자 필수 필드로 등록한다', () => {
  const schema = schemaFor(401919740, ['상품번호', '제품명', 'RETAIL PRICE', '주문단위', '발주수']);
  const retailPrice = schema.fields.find((field) => field.label === 'RETAIL PRICE');
  assert.equal(retailPrice.semantic, 'retailPrice');
  assert.equal(retailPrice.type, 'number');
  assert.equal(retailPrice.required, true);
  assert.equal(retailPrice.readOnly, false);
});

test('고정 필드와 동적 customFields 저장 경계를 유지한다', () => {
  assert.match(html, /id="mb-product-supplier"/);
  assert.match(html, /id="mb-product-brand"/);
  assert.match(html, /id="mb-prelude-product-id"/);
  assert.match(html, /id="mb-spreadsheet-product-fields"/);
  assert.match(html, /customFields\[field\.id\]=collected\.values\[field\.id\]/);
  assert.match(html, /sheetProfile:\s*sheetProfile/);
  assert.doesNotMatch(html, /Object\.assign\([^\n]*collected\.values/);
});

test('OIMU Cat.1 Cat.2 size 원본 열을 서로 다른 입력 필드로 보존한다', () => {
  const schema = schemaFor(1677320358, ['No.', 'Cat.1', 'Cat.2', 'Picture', '상품명(한글)', '상품명(영문)', 'Option (Ko/En)', 'Barcode', 'Material (Eng)', 'size (W x L x Hmm)', 'use (Eng)', 'Origin', 'HScode', '가격 (RRP)', '수량']);
  const category1 = schema.fields.find((field) => field.label === 'Cat.1');
  const category2 = schema.fields.find((field) => field.label === 'Cat.2');
  const size = schema.fields.find((field) => field.label === 'size (W x L x Hmm)');
  assert.deepEqual([category1.column, category2.column, size.column], [2, 3, 10]);
  assert.deepEqual([category1.semantic, category2.semantic, size.semantic], ['category1', 'category2', 'size']);
  assert.ok([category1.id, category2.id, size.id].every(Boolean));
  assert.equal(new Set([category1.id, category2.id, size.id]).size, 3);
  assert.deepEqual([category1.readOnly, category2.readOnly, size.readOnly], [false, false, false]);
});
