import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeSheetHtml } from '../server.mjs';

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

function functionSource(html, name) {
  let start = html.indexOf(`function ${name}`);
  if (start < 0) start = html.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const following = [
    html.indexOf('\n  function ', start + 12),
    html.indexOf('\n  async function ', start + 12),
  ].filter((index) => index >= 0);
  return html.slice(start, following.length ? Math.min(...following) : undefined);
}

const raw = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const html = decodeSrcdoc(raw);
const googleSheetsEdge = await readFile(new URL('../supabase/functions/google-sheets/index.ts', import.meta.url), 'utf8');
const googleSheetsServer = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

test('public Google Sheet inspection records the product image column', () => {
  const tab = { sheetIndex: 0, sheetId: 7, title: 'Collection', rowCount: 20, columnCount: 7, hidden: false };
  const fixture = [
    '<table>',
    '<tr><th id="7R0">1</th><td>상품번호</td><td>제품명</td><td>제품이미지</td><td>소비자가</td><td>주문단위</td><td>발주수</td></tr>',
    '<tr><th id="7R1">2</th><td>A-1</td><td>테스트 상품</td><td></td><td>1000</td><td>1</td><td></td></tr>',
    '</table>',
  ].join('');
  const analyzed = analyzeSheetHtml(fixture, tab);
  assert.equal(analyzed.columns.image, 3);
  assert.equal(analyzed.columns.qty, 6);
  assert.equal(analyzed.status, 'CONFIRMED');
});

test('public Google Sheet inspection preserves a barcode identity and Korean product-name header', () => {
  const tab = { sheetIndex: 0, sheetId: 9, title: '문구류', rowCount: 50, columnCount: 8, hidden: false };
  const fixture = [
    '<table>',
    '<tr><th id="9R0">1</th><td>NO</td><td>STYLE NO</td><td>바코드</td><td>IMAGE</td><td>상품명(KR)</td><td>소비자가</td><td>수량</td><td>비고</td></tr>',
    '<tr><th id="9R1">2</th><td>1</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>',
    '</table>',
  ].join('');
  const analyzed = analyzeSheetHtml(fixture, tab);
  assert.equal(analyzed.columns.key, 3);
  assert.equal(analyzed.columns.keyField, 'barcode');
  assert.equal(analyzed.columns.image, 4);
  assert.equal(analyzed.columns.productName, 5);
  assert.equal(analyzed.columns.qty, 7);
  assert.equal(analyzed.status, 'CONFIRMED');
});

test('OIMU uses the live Sheet2 identity and repairs the legacy Sheet1 binding', () => {
  assert.match(html, /'SUP-OIMU':\[\{id:'OIMU-CATALOG'[^\]]*sheet:'Sheet2',sheetId:1677320358/);
  assert.match(html, /function repairRequestedOimuBindings/);
  assert.match(html, /entityId:'OIMU-CATALOG',inferredRole:'PRODUCT_LIST',confirmedRole:'PRODUCT_LIST'/);
  assert.match(html, /상품명\(한글\).*상품명\(영문\).*product name/);
  assert.match(html, /가격\\\(\?rrp\\\)\?/);
});

test('OIMU legacy and temporary bindings collapse into the stable catalog identity', () => {
  const repair = new Function(
    'offersForSupplier',
    `${functionSource(html, 'hasGoogleSheetId')}\n${functionSource(html, 'repairRequestedOimuBindings')}\nreturn repairRequestedOimuBindings;`,
  )(() => []);
  const result = repair(
    { id: 'SUP-OIMU' },
    {
      spreadsheetId: '1tsuYvojJlbD187iVA320QgDZmAfd17E7xOm6cz6mxaE',
      tabs: [{ sheetId: 1677320358, sheetIndex: 0, title: 'Sheet2', hidden: false }],
    },
    [
      { sheetName: 'Sheet1', entityId: 'OIMU-CATALOG', confirmedRole: 'PRODUCT_LIST', status: 'CONFIRMED' },
      { sheetId: 1677320358, sheetName: 'Sheet2', entityId: 'SUP-OIMU-GS-1tsuYvoj-1677320358', confirmedRole: 'BRAND_PRODUCT', status: 'NEEDS_REVIEW', issues: ['상품 식별 열과 발주수량 열을 자동으로 확인하지 못했습니다.'] },
    ],
    [
      { id: 'OIMU-CATALOG', name: 'OIMU Product List', sheet: 'Sheet1' },
      { id: 'SUP-OIMU-GS-1tsuYvoj-1677320358', name: 'Sheet2', sheet: 'Sheet2' },
    ],
  );
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].entityId, 'OIMU-CATALOG');
  assert.equal(result.bindings[0].sheetId, 1677320358);
  assert.equal(result.bindings[0].sheetName, 'Sheet2');
  assert.equal(result.bindings[0].confirmedRole, 'PRODUCT_LIST');
  assert.equal(result.bindings[0].status, 'CONFIRMED');
  assert.deepEqual(result.bindings[0].issues, []);
  assert.deepEqual(result.brands.map((brand) => brand.id), ['OIMU-CATALOG']);
});

test('header-only order sheets are accepted for every supplier and start directly below the header', () => {
  const source = functionSource(html, 'analyzeSupplierTemplateFile');
  assert.doesNotMatch(source, /blankOrderTemplate=supplierId===/);
  assert.match(source, /blankOrderTemplate=mapping\.score>=2&&hasProductKey&&hasOrderQty&&!!mapping\.row&&!mapping\.dataStartRow&&!mapping\.dataEndRow/);
  assert.match(source, /contractStart=mapping\.dataStartRow\|\|mapping\.row\+1/);
  assert.match(source, /allowNewRows:blankOrderTemplate/);
});

test('gid 0 duplicate repair preserves the supplier link and adopts the detected barcode and quantity columns', () => {
  const idSource = functionSource(html, 'hasGoogleSheetId');
  const repairStart = html.indexOf('function repairDuplicateGoogleSheetBindings');
  const repairSource = html.slice(repairStart, html.indexOf('\n  var spreadsheetTabDiffZeroSafeBase', repairStart));
  const repair = new Function(
    'offersForSupplier',
    'googleSpreadsheetSheetIdentity',
    `${idSource}\n${repairSource}; return repairDuplicateGoogleSheetBindings;`,
  )(
    () => [{ scopeId: 'HUGIN-ALL' }],
    (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]+/g, ''),
  );
  const result = repair(
    { id: 'SUP-HUGIN' },
    { tabs: [{ title: '전품목 목록', sheetId: 0, sheetIndex: 0, hidden: false }] },
    {
      bindings: [
        { sheetName: '전품목 목록', entityId: 'HUGIN-ALL', confirmedRole: 'PRODUCT_LIST', status: 'CONFIRMED' },
        { sheetId: 0, sheetName: '전품목 목록', entityId: 'TEMP-0', confirmedRole: 'BRAND_PRODUCT', status: 'NEEDS_REVIEW', headerRow: 1, dataStartRow: 2, columns: { key: 4, keyField: 'barcode', productName: 3, retailPrice: 5, qty: 6 } },
      ],
      brands: [{ id: 'HUGIN-ALL' }, { id: 'TEMP-0' }],
    },
  );
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].entityId, 'HUGIN-ALL');
  assert.equal(result.bindings[0].sheetId, 0);
  assert.equal(result.bindings[0].headerRow, 1);
  assert.equal(result.bindings[0].dataStartRow, 2);
  assert.equal(result.bindings[0].columns.keyField, 'barcode');
  assert.equal(result.bindings[0].columns.key, 4);
  assert.equal(result.bindings[0].columns.qty, 6);
  assert.deepEqual(result.brands.map((brand) => brand.id), ['HUGIN-ALL']);
});

test('spreadsheet tab refresh treats gid 0 as a valid immutable tab id', () => {
  const source = html.slice(html.indexOf('var spreadsheetTabDiffZeroSafeBase=spreadsheetTabDiff'), html.indexOf('\n  function supplierTemplateSlug'));
  assert.match(source, /Number\(binding\.sheetId\)===0/);
  assert.match(source, /binding\.sheetId='0'/);
  assert.match(source, /repairDuplicateGoogleSheetBindings/);
});

test('stored snapshot contracts recover a confirmed live binding by immutable sheet index', () => {
  const source = [
    functionSource(html, 'bindingOutputContract'),
    functionSource(html, 'storedTemplateOutputBindings'),
    functionSource(html, 'resolveOutputContract'),
  ].join('\n');
  const supplierSheetBindings = {
    SUP: [{
      sheetName: 'Google Sheet Name Longer Than Excel Allows',
      sheetIndex: 0,
      confirmedRole: 'COLLECTION_PRODUCT',
      entityId: 'scope-a',
      status: 'CONFIRMED',
    }],
  };
  const resolve = new Function(
    'supplierSheetBindings',
    'isProductSheetRole',
    'findSupplier',
    'brandCatalogFor',
    `${source}; return resolveOutputContract;`,
  )(
    supplierSheetBindings,
    (role) => ['BRAND_PRODUCT', 'COLLECTION_PRODUCT', 'CATEGORY_PRODUCT', 'PRODUCT_LIST'].includes(role),
    () => ({ template: { brandLayoutPolicy: { mode: 'PER_SCOPE' } } }),
    () => ({ linkStatus: 'CONFIRMED' }),
  );
  const version = {
    contracts: [{ sheetName: 'Excel Sheet Name', columns: { supplierCode: 1, qty: 6 } }],
    sheets: [{ name: 'Excel Sheet Name', sheetIndex: 0 }],
    bindings: [],
    brandLayoutPolicy: { mode: 'PER_SCOPE' },
  };
  const output = resolve('SUP', 'scope-a', [], version);
  assert.equal(output.sheetName, 'Excel Sheet Name');
  assert.equal(output.contract, version.contracts[0]);
  assert.equal(output.binding.googleSheetName, 'Google Sheet Name Longer Than Excel Allows');
});

test('stored snapshot uses the exact Excel contract name when an existing binding has a Google alias', () => {
  const source = [
    functionSource(html, 'bindingOutputContract'),
    functionSource(html, 'storedTemplateOutputBindings'),
    functionSource(html, 'resolveOutputContract'),
  ].join('\n');
  const resolve = new Function(
    'supplierSheetBindings',
    'isProductSheetRole',
    'findSupplier',
    'brandCatalogFor',
    `${source}; return resolveOutputContract;`,
  )(
    {},
    (role) => role === 'CATEGORY_PRODUCT',
    () => ({ template: { brandLayoutPolicy: { mode: 'PER_SCOPE' } } }),
    () => ({ linkStatus: 'CONFIRMED' }),
  );
  const version = {
    contracts: [{ sheetName: '문구류', row: 1, dataStartRow: 2, columns: { barcode: 3, qty: 7 } }],
    sheets: [{ name: '문구류' }],
    bindings: [{
      sheetName: '문구류(마테, 메모지, 스티커)',
      googleSheetName: '문구류(마테, 메모지, 스티커)',
      excelSheetName: '문구류',
      confirmedRole: 'CATEGORY_PRODUCT',
      entityId: 'MINDO-STATIONERY',
      status: 'CONFIRMED',
    }],
    brandLayoutPolicy: { mode: 'PER_SCOPE' },
  };
  const output = resolve('SUP-MINDOBITTO', 'MINDO-STATIONERY', version.bindings, version);
  assert.equal(output.sheetName, '문구류');
  assert.equal(output.contract, version.contracts[0]);
});

test('Google and Excel sheet aliases keep the selected two-row preview target', () => {
  const namesSource = functionSource(html, 'outputTargetSheetNames');
  const matchesSource = functionSource(html, 'outputTargetMatchesSheet');
  const chooseSource = functionSource(html, 'choosePreviewOutputTarget');
  const choose = new Function(
    `${namesSource}\n${matchesSource}\n${chooseSource}; return choosePreviewOutputTarget;`,
  )();
  const targets = [
    {
      sheetName: '문구류',
      rowCount: 0,
      binding: { sheetName: '문구류', googleSheetName: '문구류', excelSheetName: '문구류' },
    },
    {
      sheetName: '문구류(마테, 메모지, 스티커)',
      rowCount: 2,
      binding: {
        sheetName: '문구류(마테, 메모지, 스티커)',
        googleSheetName: '문구류(마테, 메모지, 스티커) - Google 원본 이름',
        excelSheetName: '문구류(마테, 메모지, 스티커)',
      },
    },
  ];
  const selected = choose(targets, '문구류(마테, 메모지, 스티커) - Google 원본 이름', null);
  assert.equal(selected.sheetName, '문구류(마테, 메모지, 스티커)');
  assert.equal(selected.rowCount, 2);
});

test('preview orchestration refuses a silent two-row to zero-row mismatch', () => {
  const source = functionSource(html, 'renderResolvedStoredTemplatePreview');
  assert.match(source, /choosePreviewOutputTarget\(targets,selectedPreviewOutputSheet,preferredOutput\)/);
  assert.match(source, /outputTargetMatchesSheet\(output,row\.sheet\)/);
  assert.match(source, /expectedRows>0&&rows\.length!==expectedRows/);
  assert.match(source, /data-template-preview-row-count/);
  assert.match(source, /Excel 반영 실패 · 발주 품목 유지/);
});

test('draft and saved order rows carry product images into stored-template compilation', () => {
  const draftSource = functionSource(html, 'templateRowsFromDraft');
  const orderSource = functionSource(html, 'orderExportRows');
  const compileSource = functionSource(html, 'compileStoredTemplateSheet');
  assert.match(draftSource, /imageFileName:item&&item\.imageFileName/);
  assert.match(draftSource, /imageDataUrl:item&&item\.imageDataUrl/);
  assert.match(draftSource, /barcode:item&&item\.barcode/);
  assert.match(orderSource, /hasSnapshotImage=Object\.prototype\.hasOwnProperty\.call\(snapshot,'imageDataUrl'\)/);
  assert.match(orderSource, /imageDataUrl:hasSnapshotImage\?snapshot\.imageDataUrl/);
  assert.match(orderSource, /barcode:excelSafeText\(snapshot\.barcode/);
  assert.match(compileSource, /imageColumn=positiveTemplateInteger\(mapping\.columns\.image\)/);
  assert.match(compileSource, /!templateRowHasImage\(sheet,targetRowNumber,imageColumn\)/);
  assert.match(compileSource, /workbook\.addImage\(\{base64:preparedImage\.dataUrl/);
  assert.match(compileSource, /workbook\.__skippedImageCount=/);
  assert.match(compileSource, /'supplierCode','barcode','productId','sku'/);
});

test('후긴앤무닌 A:F 양식은 No 카테고리명 소비자가를 상품 상세 semantic으로 연결한다', () => {
  const meaningSource = functionSource(html, 'templateHeaderMeaning');
  const templateHeaderMeaning = new Function(
    'normalizeTemplateHeader',
    `${meaningSource}; return templateHeaderMeaning;`,
  )((value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase());
  assert.equal(templateHeaderMeaning('No.'), 'sequence');
  assert.equal(templateHeaderMeaning('카테고리명'), 'category');
  assert.equal(templateHeaderMeaning('소비자가'), 'retailPrice');

  const mapSource = functionSource(html, 'templateColumnMap');
  const templateColumnMap = new Function(
    'normalizeTemplateHeader',
    'excelPreviewValue',
    `${mapSource}; return templateColumnMap;`,
  )(
    (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(),
    (cell) => cell.value ?? '',
  );
  const values = [
    ['No.', '카테고리명', '상품명', '바코드', '소비자가', '수량'],
    ['', '', '', '', '', ''],
  ];
  const getRow = (rowNumber) => ({
    eachCell: ({ includeEmpty }, callback) => values[rowNumber - 1].forEach((value, index) => {
      if (includeEmpty || value !== '') callback({ value }, index + 1);
    }),
    getCell: (column) => ({ value: values[rowNumber - 1][column - 1] }),
  });
  const mapping = templateColumnMap({ rowCount: values.length, getRow });
  assert.deepEqual(mapping.columns, {
    sequence: 1,
    category: 2,
    productName: 3,
    barcode: 4,
    retailPrice: 5,
    qty: 6,
  });
});

test('발주서 No는 시트별 1부터 연속되고 상품 상세 카테고리 소비자가를 row와 snapshot에 보존한다', () => {
  const sequenceSource = functionSource(html, 'sequenceTemplateRows');
  const sequenceTemplateRows = new Function(`${sequenceSource}; return sequenceTemplateRows;`)();
  const rows = sequenceTemplateRows([
    { sheet: '전품목 목록', sku: 'A', retailPrice: 4000 },
    { sheet: '전품목 목록', sku: 'B', retailPrice: 0 },
    { sheet: '다른 시트', sku: 'C' },
  ]);
  assert.deepEqual(rows.map((row) => row.sequence), [1, 2, 1]);
  assert.deepEqual(rows.map((row) => row.retailPrice), [4000, null, null]);

  const draftSource = functionSource(html, 'templateRowsFromDraft');
  const orderSource = functionSource(html, 'orderExportRows');
  const snapshotStart = html.indexOf('function buildOrderLineSnapshot');
  const snapshotSource = html.slice(snapshotStart, html.indexOf('\n  function outputTargetsFromOrderLines', snapshotStart));
  assert.match(draftSource, /category:item&&item\.category/);
  assert.match(draftSource, /retailPrice:itemRetailUnitPrice\(item\)/);
  assert.match(orderSource, /category:excelSafeText\(snapshot\.category/);
  assert.match(orderSource, /retailPrice:Number\(snapshot\.consumerPrice/);
  assert.match(snapshotSource, /category:item\.category/);
  assert.match(snapshotSource, /templateCellsByColumn:templateCellsByColumnForItem\(item,offer\)/);
});

test('빈 소비자가 셀만 상품 상세값으로 채우고 기존 값과 수식은 보존한다', async () => {
  const start = html.indexOf('var compileStoredTemplateSheetMappedFieldsBase');
  const end = html.indexOf('\n  function htmlSafe', start);
  const wrapperSource = html.slice(start, end);
  const cells = new Map();
  const key = (row, column) => `${row}:${column}`;
  const getCell = (row, column) => {
    const cellKey = key(row, column);
    if (!cells.has(cellKey)) cells.set(cellKey, { value: null, numFmt: '' });
    return cells.get(cellKey);
  };
  cells.set(key(2, 4), { value: '0001003658502' });
  cells.set(key(2, 5), { value: null, numFmt: '' });
  cells.set(key(3, 4), { value: '0001001711902' });
  cells.set(key(3, 5), { value: { formula: '1000+1500', result: 2500 }, numFmt: '#,##0' });
  cells.set(key(4, 4), { value: '0001009999999' });
  cells.set(key(4, 5), { value: 7777, numFmt: '#,##0' });
  cells.set(key(4, 1), { value: 42 });
  cells.set(key(4, 2), { value: '공급처 원본 카테고리' });
  const compiled = {
    matchKey: 'barcode',
    mapping: { row: 1, dataStartRow: 2, columns: { barcode: 4, retailPrice: 5 } },
    sheet: { rowCount: 4, getRow: (row) => ({ getCell: (column) => getCell(row, column) }) },
  };
  const sourceWorkbook = { getWorksheet: () => compiled.sheet };
  const compileStoredTemplateSheet = new Function(
    'compileStoredTemplateSheet',
    'positiveTemplateInteger',
    'excelPreviewValue',
    'templateColumnMap',
    'cloneExcelStyle',
    `${wrapperSource}; return compileStoredTemplateSheet;`,
  )(
    async () => {
      getCell(3, 5).value = 9999;
      getCell(4, 5).value = 9999;
      getCell(4, 1).value = 3;
      getCell(4, 2).value = 'PRELUDE 카테고리';
      return compiled;
    },
    (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
    (cell) => cell.value && typeof cell.value === 'object' && cell.value.result != null ? cell.value.result : cell.value ?? '',
    () => ({ columns: { sequence: 1, category: 2, barcode: 4, retailPrice: 5 } }),
    (value) => value && typeof value === 'object' ? structuredClone(value) : value,
  );
  await compileStoredTemplateSheet({ contracts: [] }, '전품목 목록', [
    { barcode: '0001003658502', retailPrice: 4000 },
    { barcode: '0001001711902', retailPrice: 9999 },
    { barcode: '0001009999999', retailPrice: 8888 },
  ], sourceWorkbook);
  assert.equal(getCell(2, 5).value, 4000);
  assert.equal(getCell(2, 5).numFmt, '#,##0');
  assert.deepEqual(getCell(3, 5).value, { formula: '1000+1500', result: 2500 });
  assert.equal(getCell(4, 5).value, 7777);
  assert.equal(getCell(4, 1).value, 42);
  assert.equal(getCell(4, 2).value, '공급처 원본 카테고리');
});

test('소비자가 0원 또는 빈값은 미리보기 반영 성공으로 처리하지 않는다', () => {
  const start = html.indexOf('var auditCompiledTemplateRowsPositiveRetailBase');
  const end = html.indexOf('\n  async function renderResolvedStoredTemplatePreview', start);
  const wrapperSource = html.slice(start, end);
  const cells = new Map([
    ['2:4', { value: '0001003658502' }],
    ['2:5', { value: 0 }],
  ]);
  const compiled = {
    matchKey: 'barcode',
    mapping: { row: 1, dataStartRow: 2, columns: { barcode: 4, retailPrice: 5 } },
    sheet: {
      rowCount: 2,
      getRow: (row) => ({ getCell: (column) => cells.get(`${row}:${column}`) || { value: null } }),
    },
  };
  const auditCompiledTemplateRows = new Function(
    'auditCompiledTemplateRows',
    'positiveTemplateInteger',
    'excelPreviewValue',
    'templateCostNumber',
    `${wrapperSource}; return auditCompiledTemplateRows;`,
  )(
    () => ({ confirmed: 1, rowNumbers: [2], missing: [], missingImages: [] }),
    (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
    (cell) => cell.value ?? '',
    (value) => {
      const parsed = Number(String(value).replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : null;
    },
  );
  const audit = auditCompiledTemplateRows(compiled, [{ barcode: '0001003658502', productName: '초여름' }]);
  assert.equal(audit.confirmed, 0);
  assert.deepEqual(audit.rowNumbers, []);
  assert.deepEqual(audit.missing, ['초여름']);
});

test('a numbered but otherwise blank template row is available for a new product', () => {
  const helperSource = functionSource(html, 'templateRowAcceptsNewProduct');
  const accepts = new Function('excelPreviewValue', `${helperSource}; return templateRowAcceptsNewProduct;`)(
    (cell) => cell.value == null ? '' : cell.value,
  );
  const cells = new Map([[1, { value: 1 }], [3, { value: '' }], [4, { value: '' }], [5, { value: '' }], [7, { value: '' }]]);
  const sheet = { getRow: () => ({ getCell: (column) => cells.get(column) || { value: '' } }) };
  const mapping = { columns: { barcode: 3, image: 4, productName: 5, qty: 7 } };
  assert.equal(accepts(sheet, 2, mapping, 3), true);
  cells.set(7, { value: { formula: '1+1', result: 2 } });
  assert.equal(accepts(sheet, 2, mapping, 3), false);
});

test('preview success is gated by cells confirmed in the compiled workbook', () => {
  const auditSource = functionSource(html, 'auditCompiledTemplateRows');
  const mappedAuditStart = html.indexOf('var auditCompiledTemplateRowsMappedFieldsBase');
  const mappedAuditSource = html.slice(mappedAuditStart, html.indexOf('\n  async function renderResolvedStoredTemplatePreview', mappedAuditStart));
  const previewSource = functionSource(html, 'renderResolvedStoredTemplatePreview');
  assert.match(auditSource, /confirmedRows\.length/);
  assert.match(auditSource, /missingImages/);
  assert.match(mappedAuditSource, /columns\.sequence,columns\.category,columns\.retailPrice/);
  assert.match(mappedAuditSource, /result\.confirmed=result\.rowNumbers\.length/);
  assert.match(previewSource, /audit\.confirmed!==rows\.length/);
  assert.match(previewSource, /미리보기 반영 확인/);
  assert.match(previewSource, /data-template-preview-row-count/);
});

test('ExcelJS drawings are rendered in the same preview cell as an image', () => {
  const anchorSource = functionSource(html, 'templateImageAnchor');
  const dataUrlSource = functionSource(html, 'excelPreviewImageDataUrl');
  const imagesSource = functionSource(html, 'excelPreviewImagesByCell');
  const imagesByCell = new Function(
    `${anchorSource}\n${dataUrlSource}\n${imagesSource}; return excelPreviewImagesByCell;`,
  )();
  const sheet = {
    getImages: () => [{ imageId: 11, range: { tl: { nativeRow: 1, nativeCol: 2 } } }],
  };
  const workbook = {
    getImage: () => ({ extension: 'png', base64: 'iVBORw0KGgo=' }),
  };
  assert.equal(imagesByCell(sheet, workbook)['2:3'], 'data:image/png;base64,iVBORw0KGgo=');
  const renderSource = functionSource(html, 'renderCompiledExcelSheet');
  assert.match(renderSource, /excelPreviewImagesByCell\(sheet,workbook\)/);
  assert.match(renderSource, /class="mb-excel-preview-image"/);
});

test('민도비또의 실제 Google 탭을 기존 상품군 ID에 자동 재연결한다', () => {
  const scopeSource = functionSource(html, 'mindobittoScopeForSheet');
  const reconcileSource = functionSource(html, 'reconcileMindobittoGoogleCatalog');
  const supplierOffers = [{ supplierId: 'SUP-MINDOBITTO', sku: 'SKU-1', scopeId: 'TEMP-GS', brandId: 'TEMP-GS' }];
  const item = { id: 'SKU-1', scopeId: 'TEMP-GS', brandId: 'TEMP-GS' };
  const reconcile = new Function(
    'seedSupplierBrandCatalogs',
    'canonicalScopeName',
    'supplierOffers',
    'findItem',
    'templateColumnLetter',
    'isProductSheetRole',
    `${scopeSource}\n${reconcileSource}; return reconcileMindobittoGoogleCatalog;`,
  )(
    { 'SUP-MINDOBITTO': [{ id: 'MINDO-STATIONERY', name: '문구류', sheet: '문구류' }] },
    (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]+/g, ''),
    supplierOffers,
    () => item,
    (column) => String.fromCharCode(64 + Number(column)),
    (role) => role === 'CATEGORY_PRODUCT',
  );
  const result = reconcile(
    { id: 'SUP-MINDOBITTO' },
    {
      checkedAt: '2026-08-27T00:00:00.000Z',
      tabs: [{
        title: '문구류(마테, 메모지, 스티커)', sheetId: 401919740, sheetIndex: 0,
        status: 'CONFIRMED', headerRow: 1, dataStartRow: 2, columns: { key: 3, keyField: 'barcode', qty: 7 },
      }],
    },
    {
      bindings: [{ sheetId: 401919740, sheetName: '문구류(마테, 메모지, 스티커)', entityId: 'TEMP-GS', confirmedRole: 'CATEGORY_PRODUCT' }],
      brands: [{ id: 'TEMP-GS', name: '임시 탭' }],
      status: 'NEEDS_REVIEW',
    },
  );
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.bindings[0].entityId, 'MINDO-STATIONERY');
  assert.equal(result.bindings[0].columns.keyField, 'barcode');
  assert.equal(supplierOffers[0].scopeId, 'MINDO-STATIONERY');
  assert.equal(item.scopeId, 'MINDO-STATIONERY');
});

test('민도비또 3개 상품과 사용자 지정 Google 양식을 영구 마이그레이션한다', () => {
  const definitionsSource = functionSource(html, 'requestedMindobittoSheetDefinitions');
  const productsSource = functionSource(html, 'requestedMindobittoProducts');
  const upsertSource = functionSource(html, 'upsertRequestedMindobittoProduct');
  const ensureSource = functionSource(html, 'ensureRequestedMindobittoSetup');
  assert.match(definitionsSource, /sheetId:401919740/);
  assert.match(definitionsSource, /sheetId:528968736/);
  assert.match(productsSource, /8800333170126/);
  assert.match(productsSource, /8800333170133/);
  assert.match(productsSource, /8800333170003/);
  assert.match(productsSource, /no:2/);
  assert.match(upsertSource, /templateCellsByColumn:.*1:product\.no,2:product\.style,6:product\.price/);
  assert.match(ensureSource, /1QEjVfGnsC1-KY0eJcIY86mD7b-xmkNAtptoyucwfOHc/);
  assert.match(ensureSource, /mindobittoOrderMigration:\{version:4/);
  assert.match(ensureSource, /Number\(supplier\.mindobittoOrderMigration\.version\)>=4/);
});

test('민도비또 v3의 짧은 Excel 별칭을 실제 탭 이름과 계약으로 자동 복구한다', () => {
  const source = [
    functionSource(html, 'requestedMindobittoSheetDefinitions'),
    functionSource(html, 'requestedMindobittoSheetMatch'),
    functionSource(html, 'requestedMindobittoBinding'),
    functionSource(html, 'repairRequestedMindobittoVersion'),
  ].join('\n');
  const helpers = new Function(
    'seedSupplierBrandCatalogs',
    'canonicalScopeName',
    'isProductSheetRole',
    'cloneExcelStyle',
    `${source}; return { definitions: requestedMindobittoSheetDefinitions, repair: repairRequestedMindobittoVersion };`,
  )(
    { 'SUP-MINDOBITTO': [{ id: 'MINDO-STATIONERY', name: '문구류' }, { id: 'MINDO-NOTE', name: '노트, 파일' }] },
    (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]+/g, ''),
    (role) => role === 'CATEGORY_PRODUCT',
    (value) => JSON.parse(JSON.stringify(value)),
  );
  const definitions = helpers.definitions();
  const version = {
    bindings: [
      { entityId: 'MINDO-STATIONERY', sheetId: 528968736, sheetName: '문구류(마테, 메모지, 스티커)', googleSheetName: '문구류(마테, 메모지, 스티커)', excelSheetName: '문구류', confirmedRole: 'CATEGORY_PRODUCT', status: 'CONFIRMED' },
      { entityId: 'MINDO-NOTE', sheetName: '노트, 파일', excelSheetName: '노트, 파일', confirmedRole: 'CATEGORY_PRODUCT', status: 'CONFIRMED' },
    ],
    sheets: [
      { name: '문구류(마테, 메모지, 스티커)', sheetIndex: 0 },
      { name: '노트, 파일', sheetIndex: 1 },
    ],
    contracts: [
      { sheetName: '문구류', row: 1, dataStartRow: 2, columns: { barcode: 3, qty: 7 } },
      { sheetName: '노트, 파일', row: 1, dataStartRow: 2, columns: { barcode: 3, qty: 7 } },
    ],
  };
  helpers.repair(version, definitions, []);
  assert.deepEqual(version.bindings.map((binding) => binding.sheetId), [401919740, 528968736]);
  assert.deepEqual(version.bindings.map((binding) => binding.excelSheetName), ['문구류(마테, 메모지, 스티커)', '노트, 파일']);
  assert.deepEqual(version.contracts.map((contract) => contract.sheetName), ['문구류(마테, 메모지, 스티커)', '노트, 파일']);
  assert.equal(version.contracts[0].dataStartRow, 2);
  assert.equal(version.contracts[0].columns.productName, 5);
  assert.equal(version.contracts[0].columns.retailPrice, 6);
  assert.equal(version.contracts[0].columns.qty, 7);
  assert.equal(version.contracts[0].rowMatchKey, 'barcode');
});

test('header-only 저장 양식은 실제 시트명과 dataStartRow 계약이 일치할 때만 재사용한다', () => {
  const source = [
    functionSource(html, 'bindingOutputContract'),
    functionSource(html, 'storedTemplateVersionCoherent'),
  ].join('\n');
  const coherent = new Function(
    'isProductSheetRole',
    `${source}; return storedTemplateVersionCoherent;`,
  )((role) => role === 'CATEGORY_PRODUCT');
  const version = {
    sheets: [{ name: '문구류(마테, 메모지, 스티커)' }],
    bindings: [{ sheetName: '문구류(마테, 메모지, 스티커)', excelSheetName: '문구류(마테, 메모지, 스티커)', confirmedRole: 'CATEGORY_PRODUCT', status: 'CONFIRMED' }],
    contracts: [{ sheetName: '문구류(마테, 메모지, 스티커)', row: 1, dataStartRow: 2, columns: { qty: 7 } }],
  };
  assert.equal(coherent(version), true);
  version.bindings[0].excelSheetName = '문구류';
  assert.equal(coherent(version), false);
});

test('Supabase Google Sheets 분석기도 민도비또 헤더와 바코드 키를 보존한다', () => {
  assert.match(googleSheetsEdge, /function identifierFieldForHeader/);
  assert.match(googleSheetsEdge, /"상품명\(KR\)"/);
  assert.match(googleSheetsEdge, /"RETAIL PRICE"/);
  assert.match(googleSheetsEdge, /columns: \{ key: keyColumn, keyField,/);
  const edgeSignature = googleSheetsEdge.slice(googleSheetsEdge.indexOf('const structureSignature'), googleSheetsEdge.indexOf('const formatSignature'));
  const serverSignature = googleSheetsServer.slice(googleSheetsServer.indexOf('const structureSignature'), googleSheetsServer.indexOf('const formatSignature'));
  assert.doesNotMatch(edgeSignature, /keyField/);
  assert.doesNotMatch(serverSignature, /keyField/);
});

test('빈 민도비또 상품 행에는 STYLE NO와 소비자가 passthrough 값을 함께 쓴다', () => {
  const source = functionSource(html, 'expandTemplatePassthroughColumns');
  const expand = new Function('positiveTemplateInteger', `${source}; return expandTemplatePassthroughColumns;`)(
    (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
  );
  const mapping = { columns: { barcode: 3, retailPrice: 6, qty: 7 } };
  const rows = [
    { templateCellsByColumn: { 1: 1, 2: '마스킹테이프', 6: 4000 } },
    { templateCellsByColumn: { 1: 2, 2: '마스킹테이프', 6: 6000 } },
  ];
  expand(mapping, rows);
  assert.equal(mapping.columns.templateCell1, 1);
  assert.equal(mapping.columns.templateCell2, 2);
  assert.equal(mapping.columns.templateCell6, 6);
  assert.equal(rows[1].templateCell1, 2);
  assert.equal(rows[1].templateCell6, 6000);
});

test('민도비또 Excel 등록 상품의 원본 STYLE NO를 미리보기 열 값으로 복원한다', () => {
  const source = [
    functionSource(html, 'importedTemplateColumnNumber'),
    functionSource(html, 'templateCellsByColumnForItem'),
  ].join('\n');
  const templateCells = new Function(
    'positiveTemplateInteger',
    `${source}; return templateCellsByColumnForItem;`,
  )((value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
  const item = {
    customAttributes: { NO: '1', 'STYLE NO': '마스킹\n테이프', 비고: '' },
    importColumnMapping: [
      { column: 'A', targetField: 'custom:no', sourceHeader: 'NO' },
      { column: 'B', targetField: 'min', sourceHeader: 'STYLE NO' },
      { column: 'C', targetField: 'barcode', sourceHeader: '바코드' },
    ],
  };
  assert.deepEqual(templateCells(item, null), { 1: '1', 2: '마스킹\n테이프' });
  assert.deepEqual(templateCells(null, {
    templateCellsByColumn: { 1: 2, 2: '마스킹테이프', 6: 6000 },
  }), { 1: 2, 2: '마스킹테이프', 6: 6000 });
});
