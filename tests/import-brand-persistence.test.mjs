import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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

function functionSource(source, name) {
  const starts = [source.indexOf(`function ${name}(`), source.indexOf(`async function ${name}(`)]
    .filter(index => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} source is incomplete`);
}

const raw = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const html = decodeSrcdoc(raw);
const migration = await readFile(
  new URL('../supabase/migrations/20260827070700_prelude_import_brand_observations.sql', import.meta.url),
  'utf8',
);
const validationMigration = await readFile(
  new URL('../supabase/migrations/20260827071444_validate_prelude_import_brand_observations.sql', import.meta.url),
  'utf8',
);

function brandCollector() {
  const context = {};
  vm.runInNewContext([
    functionSource(html, 'cleanText'),
    functionSource(html, 'normalizeBrandName'),
    functionSource(html, 'canonicalImportName'),
    functionSource(html, 'collectImportBrandObservations'),
  ].join('\n'), context);
  return context.collectImportBrandObservations;
}

function workbookBrandCollector() {
  const context = {
    importHeaderMap: sheet => sheet.header,
    workbookCellValue: (row, column) => row.getCell(column).value,
  };
  vm.runInNewContext([
    functionSource(html, 'cleanText'),
    functionSource(html, 'normalizeBrandName'),
    functionSource(html, 'canonicalImportName'),
    functionSource(html, 'collectImportBrandObservations'),
    functionSource(html, 'importBrandCellText'),
    functionSource(html, 'collectWorkbookBrandObservations'),
  ].join('\n'), context);
  return context.collectWorkbookBrandObservations;
}

test('brand observations normalize identity but preserve sanitized display variants and provenance', () => {
  const collect = brandCollector();
  const result = collect([
    { sourceBrandColumnPresent: true, sourceBrand: 'MILAN', sourceSheet: 'A', sourceBrandHeader: '브랜드' },
    { sourceBrandColumnPresent: true, sourceBrand: ' milan ', sourceSheet: 'A', sourceBrandHeader: '브랜드' },
    { sourceBrandColumnPresent: true, sourceBrand: 'Milan', sourceSheet: 'B', sourceBrandHeader: 'BRAND' },
    { sourceBrandColumnPresent: true, sourceBrand: '  ', sourceSheet: 'B', sourceBrandHeader: 'BRAND' },
  ]);

  assert.equal(result.columnPresent, true);
  assert.equal(result.blankCount, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].brandKey, 'milan');
  assert.equal(result.observations[0].rowCount, 3);
  assert.deepEqual([...result.observations[0].brandValues], ['MILAN', 'milan', 'Milan']);
  assert.deepEqual([...result.observations[0].sourceSheets], ['A', 'B']);
  assert.deepEqual([...result.observations[0].sourceHeaders], ['브랜드', 'BRAND']);
});

for (const supplierId of ['SUP-HUGIN', 'SUP-MINDOBITTO', 'SUP-DONGGI', 'SUP-GENERIC']) {
  test(`${supplierId} scans the workbook brand column independently from SKU eligibility`, () => {
    const collect = workbookBrandCollector();
    const rows = [
      { getCell: () => ({ value: '브랜드' }) },
      { getCell: () => ({ value: 'ＭＩＬＡＮ' }) },
      { getCell: () => ({ value: { richText: [{ text: 'New ' }, { text: 'Balance' }] } }) },
      { getCell: () => ({ value: { formula: 'A1' } }) },
      { getCell: () => ({ value: '브랜드' }) },
      { getCell: () => ({ value: { error: '#N/A' } }) },
      { getCell: () => ({ value: ' new   balance ' }) },
    ];
    const sheet = {
      name: '상품 외 시트',
      header: {
        row: 1,
        columns: [{ column: 4, raw: '브랜드', fieldKey: 'brand', conflict: false }],
      },
      eachRow: (_options, callback) => rows.forEach((row, index) => callback(row, index + 1)),
    };
    const result = collect({ worksheets: [sheet] }, supplierId);

    assert.equal(result.columnPresent, true);
    assert.equal(result.observations.length, 2);
    assert.equal(result.observations.find(entry => entry.brandKey === 'milan').rowCount, 1);
    assert.equal(result.observations.find(entry => entry.brandKey === 'new balance').rowCount, 2);
    assert.equal(result.observations.some(entry => /브랜드|\[object object\]/i.test(entry.brandValue)), false);
  });
}

test('sheet-name fallback is not recorded as a brand column observation', () => {
  const collect = brandCollector();
  const result = collect([
    { sourceBrandColumnPresent: false, sourceBrand: '', sourceSheet: 'MILAN', brand: 'MILAN' },
  ]);
  assert.equal(result.columnPresent, false);
  assert.equal(result.observations.length, 0);

  const genericRowsSource = functionSource(html, 'genericRowsForSheet');
  assert.match(genericRowsSource, /sourceBrandColumnPresent:!!sourceBrandColumn/);
  assert.match(genericRowsSource, /sourceBrand:sourceBrandRaw/);
  assert.match(genericRowsSource, /brandName=sourceBrandRaw\|\|normalizeBrandName\(sheet\.name\)/);
});

test('brand-only reuploads can be confirmed and use the atomic Supabase RPC', () => {
  const validationSource = functionSource(html, 'updateImportPreludeValidationUI');
  const commitSource = functionSource(html, 'commitProductImport');
  const saveSource = functionSource(html, 'commitPreludeWorkspaceState');

  assert.match(validationSource, /hasBrandHistory=pendingImportBrandObservations\.length>0/);
  assert.match(validationSource, /\(!pendingImportRows\.length&&!hasBrandHistory\)/);
  assert.doesNotMatch(commitSource, /!pendingImportRows\.length\|\|!pendingImportFile/);
  assert.match(saveSource, /save_prelude_workspace_with_brands/);
  assert.match(saveSource, /p_observations:brandImport\.observations/);
  assert.match(html, /currentImportBrandPayload\(supplier\.id\)/);
  assert.match(html, /await saveCatalogState\(\{brandImport:brandImport\}\)/);
  const saveCatalogSource = functionSource(html, 'saveCatalogState');
  assert.ok(
    saveCatalogSource.indexOf('await savePreludeWorkspaceRemote(null,options)') <
      saveCatalogSource.indexOf('return saveCatalogStateLocal()'),
    'brand imports must commit remotely before updating the local mirror',
  );
});

test('brand observations are append-only, user-scoped, and retry-idempotent', () => {
  assert.match(migration, /unique \(owner_id, supplier_id, import_id, brand_key\)/);
  assert.match(migration, /on conflict \(owner_id, supplier_id, import_id, brand_key\) do nothing/);
  assert.match(migration, /alter table public\.prelude_import_brand_observations enable row level security/);
  assert.match(migration, /grant select, insert on table public\.prelude_import_brand_observations to authenticated/);
  assert.doesNotMatch(migration, /grant (?:update|delete)/i);
  assert.equal((migration.match(/\(select auth\.uid\(\)\) = owner_id/g) || []).length, 2);
  assert.match(migration, /security invoker/);
  assert.match(migration, /from public\.save_prelude_workspace\(/);
  assert.match(migration, /revoke all on function public\.save_prelude_workspace_with_brands[\s\S]*from anon/);
});

test('the validation migration rejects partial brand saves before workspace mutation', () => {
  const validationIndex = validationMigration.indexOf('for v_observation in');
  const workspaceSaveIndex = validationMigration.indexOf('from public.save_prelude_workspace(');
  assert.ok(validationIndex >= 0 && validationIndex < workspaceSaveIndex);
  assert.match(validationMigration, /p_operation_id is distinct from p_import_id/);
  assert.match(validationMigration, /PRELUDE_BRAND_OBSERVATION_INVALID/);
  assert.match(validationMigration, /PRELUDE_BRAND_OBSERVATION_DUPLICATE/);
  assert.match(validationMigration, /jsonb_typeof\(v_observation -> 'brandValues'\) is distinct from 'array'/);
  assert.doesNotMatch(
    validationMigration.slice(workspaceSaveIndex),
    /where btrim\(coalesce\(observation\.value/,
  );
});
