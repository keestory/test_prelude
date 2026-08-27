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

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must exist`);
  return html.slice(start, end);
}

test('OIMU 2단 헤더는 6행의 상품 식별자와 5행의 가격을 함께 사용한다', () => {
  const source = sourceBetween('function importHeaderMap', 'function importInteger');
  const importHeaderMap = new Function(
    'cleanText',
    'workbookCellValue',
    'mappedImportField',
    'excelColumnName',
    'normalizeImportHeader',
    'isProductImportExcludedQuantity',
    `${source}; return importHeaderMap;`,
  )(
    (value) => String(value ?? '').trim(),
    (row, column) => row.getCell(column).value,
    (_supplierId, _sheetName, rawLabel) => ({
      'Cat.1': 'category1',
      'Cat.2': 'category2',
      'Name(Ko)': 'name',
      Barcode: 'barcode',
      Picture: 'image',
      'size (W x L x Hmm)': 'size',
      가격: 'price',
      수량: 'ignore',
    })[rawLabel] || '',
    (column) => String.fromCharCode(64 + column),
    (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase(),
    (value) => value === '수량',
  );

  const rows = [
    ['OIMU Product List'],
    [],
    ['Date : '],
    [],
    ['No.', 'Cat.1', 'Cat.2', 'Picture', 'Product', '', '', '', '', '', '', '', '', '가격', '수량'],
    ['', '', '', '', 'Name(Ko)', 'Name(En)', 'Option\n(Ko/En)', 'Barcode', 'Material\n(Eng)', 'size (W x L x Hmm)', 'use', 'Origin', 'HScode', '', ''],
    [1, '독서', '책갈피', '', '식물채집 책갈피', 'Plant collecting bookmark', '풍선덩굴', 8809627681454, 'polyester', '50x137', 'bookmark', 'S.Korea', '6307.90.9000', 14000, ''],
  ];
  const sheet = {
    name: 'Sheet2',
    maxRow: rows.length,
    maxColumn: 15,
    getRow(rowNumber) {
      return {
        getCell(columnNumber) {
          return { value: rows[rowNumber - 1]?.[columnNumber - 1] ?? '' };
        },
      };
    },
  };

  const header = importHeaderMap(sheet, 'SUP-OIMU');
  assert.equal(header.row, 6);
  assert.equal(header.map.name, 5);
  assert.equal(header.map.category1, 2);
  assert.equal(header.map.category2, 3);
  assert.equal(header.map.barcode, 8);
  assert.equal(header.map.size, 10);
  assert.equal(header.map.price, 14);
  assert.equal(header.map.image, 4);
  assert.equal(header.columns.find((column) => column.column === 4).inheritedHeader, true);
  assert.equal(header.columns.find((column) => column.column === 2).raw, 'Cat.1');
  assert.equal(header.columns.find((column) => column.column === 3).raw, 'Cat.2');
  assert.equal(header.columns.find((column) => column.column === 10).raw, 'size (W x L x Hmm)');
  assert.equal(header.columns.find((column) => column.column === 2).inheritedHeader, true);
  assert.equal(header.columns.find((column) => column.column === 3).inheritedHeader, true);
  assert.equal(header.columns.find((column) => column.column === 14).raw, '가격');
  assert.equal(header.columns.find((column) => column.column === 14).inheritedHeader, true);
});

test('모호한 가격 헤더는 OIMU에서만 소비자가로 자동 연결한다', () => {
  const source = sourceBetween('function mappedImportField', 'function excelColumnName');
  const mappedImportField = new Function(
    'normalizeImportHeader',
    'savedImportField',
    'automaticImportField',
    'isProductImportExcludedQuantity',
    `${source}; return mappedImportField;`,
  )(
    (value) => String(value ?? '').trim().toLowerCase(),
    () => ({ saved: false, value: '' }),
    () => '',
    () => false,
  );

  assert.equal(mappedImportField('SUP-OIMU', 'Sheet2', '가격'), 'price');
  assert.equal(mappedImportField('SUP-GENERIC', 'Sheet2', '가격'), '');
});

test('수정 가능한 필수값 오류는 등록 제외와 구분하고 중복 사유를 제거한다', () => {
  assert.match(html, /row\.status==='invalid'\?'수정 필요':'등록 대상 아님'/);
  assert.match(html, /row\.reason!==warningNotes\.join\(', '\)/);
  assert.match(html, /retailPrice=Number\.isInteger\(row\.consumerPrice\).*?'값 오류'/);
});
