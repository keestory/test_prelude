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

test('draft and saved order rows carry product images into stored-template compilation', () => {
  const draftSource = functionSource(html, 'templateRowsFromDraft');
  const orderSource = functionSource(html, 'orderExportRows');
  const compileSource = functionSource(html, 'compileStoredTemplateSheet');
  assert.match(draftSource, /imageFileName:item&&item\.imageFileName/);
  assert.match(draftSource, /imageDataUrl:item&&item\.imageDataUrl/);
  assert.match(orderSource, /hasSnapshotImage=Object\.prototype\.hasOwnProperty\.call\(snapshot,'imageDataUrl'\)/);
  assert.match(orderSource, /imageDataUrl:hasSnapshotImage\?snapshot\.imageDataUrl/);
  assert.match(compileSource, /imageColumn=positiveTemplateInteger\(mapping\.columns\.image\)/);
  assert.match(compileSource, /!templateRowHasImage\(sheet,targetRowNumber,imageColumn\)/);
  assert.match(compileSource, /workbook\.addImage\(\{base64:preparedImage\.dataUrl/);
  assert.match(compileSource, /workbook\.__skippedImageCount=/);
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
