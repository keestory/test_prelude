import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeSheetHtml, parseSpreadsheetTabs } from '../server.mjs';

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

function normalizeBrandName(value) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
}

function templateColumnLetter(columnNumber) {
  let number = Number(columnNumber) || 0;
  let label = '';
  while (number > 0) {
    number -= 1;
    label = String.fromCharCode(65 + (number % 26)) + label;
    number = Math.floor(number / 26);
  }
  return label;
}

const raw = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const html = decodeSrcdoc(raw);
const functionStart = html.indexOf('function spreadsheetTabDiff');
const functionEnd = html.indexOf('function spreadsheetDiffItems', functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'spreadsheetTabDiff function must exist');
const functionSource = html.slice(functionStart, functionEnd);
const replacementWrapperStart = html.indexOf('var spreadsheetTabDiffBase=spreadsheetTabDiff');
const replacementWrapperEnd = html.indexOf('var normalizeGoogleSpreadsheetCatalogBase', replacementWrapperStart);
assert.ok(replacementWrapperStart >= 0 && replacementWrapperEnd > replacementWrapperStart, 'spreadsheet link replacement wrapper must exist');
const replacementWrapperSource = html.slice(replacementWrapperStart, replacementWrapperEnd);
const detailFunctionEnd = html.indexOf('function renderSupplierSpreadsheetStatus', functionEnd);
assert.ok(detailFunctionEnd > functionEnd, 'spreadsheet detail helpers must exist');
const detailFunctionSource = html.slice(functionStart, detailFunctionEnd);

function makeDiff(existingBrands, existingBindings) {
  const supplierBrandCatalogs = { SUP: existingBrands };
  const supplierSheetBindings = { SUP: existingBindings };
  const isProductSheetRole = (role) => ['BRAND_PRODUCT', 'COLLECTION_PRODUCT', 'CATEGORY_PRODUCT', 'PRODUCT_LIST'].includes(role);
  const sheetBrandName = (value) => normalizeBrandName(String(value || '').replace(/^Template[_\s-]*/i, '')) || '새 브랜드 탭';
  return new Function(
    'supplierBrandCatalogs',
    'supplierSheetBindings',
    'normalizeBrandName',
    'templateColumnLetter',
    'isProductSheetRole',
    'sheetBrandName',
    `${functionSource}; return spreadsheetTabDiff;`,
  )(supplierBrandCatalogs, supplierSheetBindings, normalizeBrandName, templateColumnLetter, isProductSheetRole, sheetBrandName);
}

function makeReplacementDiff(existingBrands, existingBindings) {
  const supplierBrandCatalogs = { SUP: existingBrands };
  const supplierSheetBindings = { SUP: existingBindings };
  const isProductSheetRole = (role) => ['BRAND_PRODUCT', 'COLLECTION_PRODUCT', 'CATEGORY_PRODUCT', 'PRODUCT_LIST'].includes(role);
  const sheetBrandName = (value) => normalizeBrandName(String(value || '').replace(/^Template[_\s-]*/i, '')) || '새 브랜드 탭';
  const base = new Function(
    'supplierBrandCatalogs',
    'supplierSheetBindings',
    'normalizeBrandName',
    'templateColumnLetter',
    'isProductSheetRole',
    'sheetBrandName',
    `${functionSource}; return spreadsheetTabDiff;`,
  )(supplierBrandCatalogs, supplierSheetBindings, normalizeBrandName, templateColumnLetter, isProductSheetRole, sheetBrandName);
  return new Function(
    'spreadsheetTabDiff',
    'supplierBrandCatalogs',
    'supplierSheetBindings',
    `${replacementWrapperSource}; return spreadsheetTabDiff;`,
  )(base, supplierBrandCatalogs, supplierSheetBindings);
}

function makeDetailHelpers(existingBrands = initialBrands, existingBindings = initialBindings) {
  const supplierBrandCatalogs = { SUP: existingBrands };
  const supplierSheetBindings = { SUP: existingBindings };
  const isProductSheetRole = (role) => ['BRAND_PRODUCT', 'COLLECTION_PRODUCT', 'CATEGORY_PRODUCT', 'PRODUCT_LIST'].includes(role);
  const sheetBrandName = (value) => normalizeBrandName(String(value || '').replace(/^Template[_\s-]*/i, '')) || '새 브랜드 탭';
  return new Function(
    'supplierBrandCatalogs',
    'supplierSheetBindings',
    'normalizeBrandName',
    'templateColumnLetter',
    'isProductSheetRole',
    'sheetBrandName',
    `${detailFunctionSource}; return { spreadsheetTabDiff, spreadsheetDiffItems, spreadsheetDiffEntry };`,
  )(supplierBrandCatalogs, supplierSheetBindings, normalizeBrandName, templateColumnLetter, isProductSheetRole, sheetBrandName);
}

const initialBrands = [
  { id: 'B1', name: 'Alpha', sheet: 'Template_Alpha', sheetId: 101, linkStatus: 'CONFIRMED', templateReady: true },
  { id: 'B2', name: 'Beta', sheet: 'Template_Beta', sheetId: 202, linkStatus: 'CONFIRMED', templateReady: true },
];
const initialBindings = [
  { sheetId: 101, sheetName: 'Template_Alpha', sheetIndex: 0, entityId: 'B1', confirmedRole: 'BRAND_PRODUCT', status: 'CONFIRMED', structureSignature: 'same' },
  { sheetId: 202, sheetName: 'Template_Beta', sheetIndex: 1, entityId: 'B2', confirmedRole: 'BRAND_PRODUCT', status: 'CONFIRMED', structureSignature: 'same' },
];

test('sheetId preserves a renamed tab, adds a review tab, and keeps a deleted tab as LINK_MISSING', () => {
  const spreadsheetTabDiff = makeDiff(initialBrands, initialBindings);
  const result = spreadsheetTabDiff(
    { id: 'SUP', spreadsheetId: 'SPREADSHEET' },
    {
      spreadsheetId: 'SPREADSHEET',
      checkedAt: '2026-08-23T00:00:00.000Z',
      tabs: [
        { sheetId: 101, title: 'Template_Alpha Renamed', sheetIndex: 1, hidden: false, headerRow: 2, dataStartRow: 3, columns: { qty: 6 }, structureSignature: 'same', formatSignature: 'format-a', status: 'CONFIRMED' },
        { sheetId: 303, title: 'Template_Gamma', sheetIndex: 0, hidden: false, headerRow: 2, dataStartRow: 3, columns: { qty: 6 }, structureSignature: 'new', formatSignature: 'format-g', status: 'CONFIRMED' },
      ],
    },
  );
  assert.equal(result.diff.renamed.length, 1);
  assert.equal(result.diff.added.length, 1);
  assert.equal(result.diff.missing.length, 1);
  assert.equal(result.brands.find((brand) => brand.id === 'B1').sheet, 'Template_Alpha Renamed');
  assert.equal(result.bindings.find((binding) => binding.sheetId === 202).status, 'LINK_MISSING');
  assert.equal(result.bindings.find((binding) => binding.sheetId === 303).status, 'NEEDS_REVIEW');
  assert.equal(result.bindings.find((binding) => binding.sheetId === 303).entityId, 'SUP-GS-SPREADSH-303');
  assert.equal(result.status, 'NEEDS_REVIEW');
});

test('unresolved NEEDS_REVIEW and LINK_MISSING states never become VERIFIED on the next read', () => {
  const spreadsheetTabDiff = makeDiff(initialBrands, initialBindings);
  const remote = {
    spreadsheetId: 'SPREADSHEET',
    checkedAt: '2026-08-23T00:00:00.000Z',
    tabs: [
      { sheetId: 101, title: 'Template_Alpha', sheetIndex: 0, hidden: false, headerRow: 2, dataStartRow: 3, columns: { key: 1, qty: 6 }, structureSignature: 'same', formatSignature: 'format-a', status: 'CONFIRMED' },
      { sheetId: 303, title: 'Template_Gamma', sheetIndex: 1, hidden: false, headerRow: 2, dataStartRow: 3, columns: { key: 1, qty: 6 }, structureSignature: 'new', formatSignature: 'format-g', status: 'CONFIRMED' },
    ],
  };
  const first = spreadsheetTabDiff({ id: 'SUP', spreadsheetId: 'SPREADSHEET' }, remote);
  const secondDiff = makeDiff(first.brands, first.bindings);
  const second = secondDiff({ id: 'SUP', spreadsheetId: 'SPREADSHEET' }, remote);
  assert.equal(second.diff.added.length, 0);
  assert.equal(second.diff.missing.length, 0);
  assert.equal(second.bindings.find((binding) => binding.sheetId === 303).status, 'NEEDS_REVIEW');
  assert.equal(second.bindings.find((binding) => binding.sheetId === 202).status, 'LINK_MISSING');
  assert.equal(second.status, 'NEEDS_REVIEW');
});

test('a changed spreadsheet link archives old bindings and never reuses a coincident sheetId', () => {
  const changedLinkDiff = makeReplacementDiff(initialBrands.slice(0, 1), initialBindings.slice(0, 1));
  const remote = {
    spreadsheetId: 'NEW_SPREADSHEET',
    checkedAt: '2026-08-27T00:00:00.000Z',
    tabs: [{ sheetId: 101, title: 'Template_New', sheetIndex: 0, hidden: false, headerRow: 2, dataStartRow: 3, columns: { key: 1, qty: 6 }, structureSignature: 'new', formatSignature: 'new-format', status: 'CONFIRMED' }],
  };
  const first = changedLinkDiff({ id: 'SUP', spreadsheetId: 'OLD_SPREADSHEET' }, remote);
  const archived = first.bindings.find((binding) => binding.entityId === 'B1');
  const active = first.bindings.find((binding) => binding.entityId !== 'B1');
  assert.equal(archived.status, 'LINK_REPLACED');
  assert.equal(archived.previousSpreadsheetId, 'OLD_SPREADSHEET');
  assert.equal(active.status, 'NEEDS_REVIEW');
  assert.notEqual(active.entityId, archived.entityId);
  assert.equal(first.diff.missing.length, 0);

  active.status = 'CONFIRMED';
  first.brands.find((brand) => brand.id === active.entityId).linkStatus = 'CONFIRMED';
  const secondDiff = makeReplacementDiff(first.brands, first.bindings);
  const second = secondDiff({ id: 'SUP', spreadsheetId: 'NEW_SPREADSHEET' }, remote);
  assert.equal(second.status, 'VERIFIED');
  assert.equal(second.bindings.find((binding) => binding.entityId === 'B1').status, 'LINK_REPLACED');
});

test('a changed required structure moves an existing tab to NEEDS_REVIEW', () => {
  const spreadsheetTabDiff = makeDiff(initialBrands.slice(0, 1), initialBindings.slice(0, 1));
  const result = spreadsheetTabDiff(
    { id: 'SUP', spreadsheetId: 'SPREADSHEET' },
    {
      spreadsheetId: 'SPREADSHEET',
      checkedAt: '2026-08-23T00:00:00.000Z',
      tabs: [
        { sheetId: 101, title: 'Template_Alpha', sheetIndex: 0, hidden: false, headerRow: 4, dataStartRow: 5, columns: { qty: null }, structureSignature: 'changed', formatSignature: 'format-b', status: 'NEEDS_REVIEW' },
      ],
    },
  );
  assert.equal(result.diff.structureChanged.length, 1);
  assert.equal(result.bindings[0].status, 'NEEDS_REVIEW');
  assert.equal(result.brands[0].templateReady, false);
});

test('structure diff records the tab, changed rows, columns, and headers', () => {
  const brands = [{ id: 'B1', name: 'Alpha', sheet: 'Template_Alpha', sheetId: 101, linkStatus: 'CONFIRMED', templateReady: true }];
  const bindings = [{
    sheetId: 101,
    sheetName: 'Template_Alpha',
    sheetIndex: 0,
    entityId: 'B1',
    confirmedRole: 'BRAND_PRODUCT',
    status: 'CONFIRMED',
    headerRow: 2,
    dataStartRow: 3,
    rowCount: 100,
    columnCount: 6,
    headers: ['상품번호', '제품명', '소비자가', '주문단위', '', '발주수'],
    columns: { key: 1, productName: 2, retailPrice: 3, orderUnit: 4, qty: 6 },
    structureSignature: 'before',
  }];
  const { spreadsheetTabDiff } = makeDetailHelpers(brands, bindings);
  const result = spreadsheetTabDiff({ id: 'SUP', spreadsheetId: 'SPREADSHEET' }, {
    spreadsheetId: 'SPREADSHEET',
    checkedAt: '2026-08-23T00:00:00.000Z',
    tabs: [{
      sheetId: 101,
      title: 'Template_Alpha',
      sheetIndex: 0,
      hidden: false,
      headerRow: 4,
      dataStartRow: 5,
      rowCount: 103,
      columnCount: 7,
      headers: ['상품번호', '제품명', '소비자가', '주문단위', '비고', '', '발주수량'],
      columns: { key: 1, productName: 2, retailPrice: 3, orderUnit: 4, qty: 7 },
      structureSignature: 'after',
      formatSignature: 'format-b',
      status: 'CONFIRMED',
      issues: [],
    }],
  });
  const event = result.diff.structureChanged[0];
  assert.equal(event.title, 'Template_Alpha');
  assert.ok(event.changes.some((change) => change.label === '헤더 행' && change.before === '2행' && change.after === '4행'));
  assert.ok(event.changes.some((change) => change.label === '데이터 시작 행' && change.before === '3행' && change.after === '5행'));
  assert.ok(event.changes.some((change) => change.label === '전체 행 수' && change.note === '3개 행 추가'));
  assert.ok(event.changes.some((change) => change.label === '전체 열 수' && change.note === '1개 열 추가'));
  assert.ok(event.changes.some((change) => change.label === '발주수량 열' && change.before === 'F열' && change.after === 'G열'));
  assert.ok(event.changes.some((change) => change.label === 'E열 헤더' && change.after === '비고'));
});

test('detail view preserves exact tab names and exposes per-change lines', () => {
  const { spreadsheetDiffItems, spreadsheetDiffEntry } = makeDetailHelpers();
  const diff = {
    added: [{ sheetId: 303, title: 'Template_Gamma & 2026', current: { headerRow: 2, dataStartRow: 3, columns: { key: 1, qty: 6 } } }],
    structureChanged: [{ sheetId: 101, title: 'Template_Alpha', changes: [{ label: '발주수량 열', before: 'F열', after: 'G열', note: '열 위치 변경' }] }],
  };
  const groups = spreadsheetDiffItems(diff);
  assert.equal(groups.find((group) => group.type === 'added').entries[0].title, 'Template_Gamma & 2026');
  assert.equal(spreadsheetDiffEntry('added', diff.added[0]).title, '신규 탭 “Template_Gamma & 2026”');
  assert.deepEqual(spreadsheetDiffEntry('structureChanged', diff.structureChanged[0]).details, ['발주수량 열 · F열 → G열 · 열 위치 변경']);
  assert.match(html, /htmlSafe\(view\.title\)/);
  assert.match(html, /htmlSafe\(detail\)/);
});

test('a read failure cannot be represented as a tab diff and therefore cannot delete mappings', () => {
  const spreadsheetTabDiff = makeDiff(initialBrands, initialBindings);
  assert.throws(() => spreadsheetTabDiff({ id: 'SUP', spreadsheetId: 'SPREADSHEET' }, null));
  assert.equal(initialBindings[0].status, 'CONFIRMED');
  assert.equal(initialBindings[1].status, 'CONFIRMED');
});

test('the refresh button reads a changed link directly and preserves the previous profile on failure', () => {
  const start = html.indexOf('async function refreshChangedSupplierSpreadsheetLink');
  const end = html.indexOf("root.querySelector('#mb-supplier-spreadsheet-diff'", start);
  const source = html.slice(start, end);
  assert.match(source, /spreadsheetId!==supplier\.spreadsheetId\)return refreshChangedSupplierSpreadsheetLink/);
  assert.match(source, /saveSupplierProfileAndTemplate\(profile,null,catalogRecord\)/);
  assert.match(source, /기존 링크와 탭 연결은 그대로 유지됩니다/);
  assert.doesNotMatch(source, /Object\.assign\(supplier,failureProfile\)/);
  assert.match(html, /addEventListener\('click',refreshSupplierSpreadsheetFromEditor\)/);
});

test('the public Sheet parser discovers a stable sheetId and tab title', () => {
  const snapshot = JSON.stringify([0, 0, '739393750', [{ 1: [[0, 0, "Template_Traveler's notebook & company"]] }], 1000, 26]);
  const htmlFixture = `[21350203,${JSON.stringify(snapshot)}]`;
  assert.deepEqual(parseSpreadsheetTabs(htmlFixture), [{
    sheetIndex: 0,
    sheetId: 739393750,
    title: "Template_Traveler's notebook & company",
    rowCount: 1000,
    columnCount: 26,
    hidden: false,
  }]);
});

test('the public Sheet parser detects header, quantity column, and first data row', () => {
  const tab = { sheetIndex: 0, sheetId: 739393750, title: 'Template_Test', rowCount: 100, columnCount: 10, hidden: false };
  const htmlFixture = [
    '<table>',
    '<tr><th id="739393750R0">1</th><td>TEST</td><td></td></tr>',
    '<tr><th id="739393750R1">2</th><td>상품번호</td><td>제품명</td><td>제품이미지</td><td>소비자가</td><td>주문단위</td><td>발주수</td><td>금 액</td></tr>',
    '<tr><th id="739393750R2">3</th><td></td><td></td><td></td><td></td><td></td><td></td><td>-</td></tr>',
    '</table>',
  ].join('');
  const analyzed = analyzeSheetHtml(htmlFixture, tab);
  assert.equal(analyzed.headerRow, 2);
  assert.equal(analyzed.dataStartRow, 3);
  assert.equal(analyzed.columns.key, 2);
  assert.equal(analyzed.columns.keyField, 'productName');
  assert.equal(analyzed.columns.qty, 6);
  assert.equal(analyzed.status, 'CONFIRMED');
});

test('the public Sheet parser maps RETAIL PRICE to the consumer retail price column', () => {
  const tab = { sheetIndex: 0, sheetId: 401919740, title: 'Template_Retail', rowCount: 100, columnCount: 10, hidden: false };
  const htmlFixture = [
    '<table>',
    '<tr><th id="401919740R0">1</th><td>상품번호</td><td>제품명</td><td>제품이미지</td><td>RETAIL PRICE</td><td>주문단위</td><td>발주수</td></tr>',
    '<tr><th id="401919740R1">2</th><td>ABC-1</td><td>테스트 상품</td><td></td><td>18000</td><td>12</td><td></td></tr>',
    '</table>',
  ].join('');
  const analyzed = analyzeSheetHtml(htmlFixture, tab);
  assert.equal(analyzed.columns.retailPrice, 4);
  assert.equal(analyzed.status, 'CONFIRMED');
});

test('the public Sheet parser recognizes the header-only OIMU template contract', () => {
  const tab = { sheetIndex: 0, sheetId: 1677320358, title: 'Sheet2', rowCount: 999, columnCount: 26, hidden: false };
  const htmlFixture = [
    '<table>',
    '<tr><th id="1677320358R0">1</th><td>OIMU Product List</td></tr>',
    '<tr><th id="1677320358R1">2</th><td></td></tr>',
    '<tr><th id="1677320358R2">3</th><td>Date :</td></tr>',
    '<tr><th id="1677320358R3">4</th><td></td></tr>',
    '<tr><th id="1677320358R4">5</th><td>No.</td><td>Cat.1</td><td>Cat.2</td><td>Picture</td><td>상품명(한글)</td><td>상품명(영문)</td><td>Option<br>(Ko/En)</td><td>Barcode</td><td>Material<br>(Eng)</td><td>size<br>(W x L x Hmm)</td><td>use<br>(Eng)</td><td>Origin</td><td>HScode</td><td>가격<br>(RRP)</td><td>수량</td></tr>',
    '</table>',
  ].join('');
  const analyzed = analyzeSheetHtml(htmlFixture, tab);
  assert.equal(analyzed.headerRow, 5);
  assert.equal(analyzed.dataStartRow, 6);
  assert.equal(analyzed.columns.key, 5);
  assert.equal(analyzed.columns.keyField, 'productName');
  assert.equal(analyzed.columns.image, 4);
  assert.equal(analyzed.columns.productName, 5);
  assert.equal(analyzed.columns.category1, 2);
  assert.equal(analyzed.columns.category2, 3);
  assert.equal(analyzed.columns.option, 7);
  assert.equal(analyzed.columns.barcode, 8);
  assert.equal(analyzed.columns.size, 10);
  assert.deepEqual(analyzed.columns.identityFields, ['productName', 'option', 'size', 'barcode']);
  assert.equal(analyzed.columns.retailPrice, 14);
  assert.equal(analyzed.columns.qty, 15);
  assert.deepEqual(analyzed.headers.slice(1, 3), ['Cat.1', 'Cat.2']);
  assert.equal(analyzed.headers[9], 'size (W x L x Hmm)');
  assert.equal(analyzed.status, 'CONFIRMED');
  assert.deepEqual(analyzed.issues, []);
});

test('quantity detection accepts count headers and never treats price or HS code as quantity', () => {
  const tab = { sheetIndex: 0, sheetId: 55, title: 'Count', rowCount: 20, columnCount: 8, hidden: false };
  const fixture = [
    '<table>',
    '<tr><th id="55R0">1</th><td>상품명</td><td>가격</td><td>HS code</td><td>단가</td><td>개수</td></tr>',
    '<tr><th id="55R1">2</th><td>노트</td><td>5000</td><td>4820</td><td>2500</td><td></td></tr>',
    '</table>',
  ].join('');
  const analyzed = analyzeSheetHtml(fixture, tab);
  assert.equal(analyzed.columns.key, 1);
  assert.equal(analyzed.columns.qty, 5);
  assert.equal(analyzed.status, 'CONFIRMED');

  const missing = analyzeSheetHtml(fixture.replace('<td>개수</td>', '<td>금액</td>'), tab);
  assert.equal(missing.columns.qty, null);
  assert.equal(missing.status, 'NEEDS_REVIEW');
});
