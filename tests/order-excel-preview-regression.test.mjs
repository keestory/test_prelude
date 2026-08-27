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
  const previewSource = functionSource(html, 'renderResolvedStoredTemplatePreview');
  assert.match(auditSource, /confirmedRows\.length/);
  assert.match(auditSource, /missingImages/);
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
        title: '문구류(마테, 메모지, 스티커)', sheetId: 528968736, sheetIndex: 0,
        status: 'CONFIRMED', headerRow: 1, dataStartRow: 2, columns: { key: 3, keyField: 'barcode', qty: 7 },
      }],
    },
    {
      bindings: [{ sheetId: 528968736, sheetName: '문구류(마테, 메모지, 스티커)', entityId: 'TEMP-GS', confirmedRole: 'CATEGORY_PRODUCT' }],
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
  const productsSource = functionSource(html, 'requestedMindobittoProducts');
  const upsertSource = functionSource(html, 'upsertRequestedMindobittoProduct');
  const ensureSource = functionSource(html, 'ensureRequestedMindobittoSetup');
  assert.match(productsSource, /8800333170126/);
  assert.match(productsSource, /8800333170133/);
  assert.match(productsSource, /8800333170003/);
  assert.match(productsSource, /no:2/);
  assert.match(upsertSource, /templateCellsByColumn:.*1:product\.no,2:product\.style,6:product\.price/);
  assert.match(ensureSource, /1QEjVfGnsC1-KY0eJcIY86mD7b-xmkNAtptoyucwfOHc/);
  assert.match(ensureSource, /mindobittoOrderMigration:\{version:3/);
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
