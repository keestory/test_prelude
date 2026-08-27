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
const migration = await readFile(
  new URL('../supabase/migrations/202608270001_prelude_workspace.sql', import.meta.url),
  'utf8',
);

test('Supabase workspace table blocks anon and scopes every policy to auth.uid()', () => {
  assert.match(migration, /alter table public\.prelude_workspaces enable row level security/);
  assert.match(migration, /revoke all on table public\.prelude_workspaces from anon/);
  assert.match(migration, /grant select, insert, update on table public\.prelude_workspaces to authenticated/);
  assert.doesNotMatch(migration, /grant delete/i);
  assert.equal((migration.match(/\(select auth\.uid\(\)\) = owner_id/g) || []).length, 4);
});

test('workspace save is revisioned, idempotent, and refuses last-write-wins', () => {
  assert.match(migration, /and revision = p_expected_revision/);
  assert.match(migration, /last_operation_id = p_operation_id/);
  assert.match(migration, /PRELUDE_WORKSPACE_CONFLICT/);
  assert.match(migration, /security invoker/);
});

test('the app gates operational data behind Supabase Auth and never resurrects reset local products', () => {
  assert.match(html, /id="mb-cloud-gate"/);
  assert.match(html, /id="mb-cloud-password"/);
  assert.match(html, /id="mb-cloud-login" type="button"/);
  assert.match(html, /signInWithPassword/);
  assert.match(html, /addEventListener\('click',submitPreludeLogin\)/);
  assert.match(html, /event\.key==='Enter'/);
  assert.doesNotMatch(html, /signInWithOtp/);
  assert.doesNotMatch(html, /password\.length&lt;8/);
  assert.match(html, /child\.setAttribute\('inert',''\)/);
  assert.match(html, /passwordInput\.value=''/);
  assert.match(html, /removeAttribute\('data-supabase-user'\)/);
  assert.match(html, /from\('prelude_workspaces'\)/);
  assert.match(html, /rpc\('save_prelude_workspace'/);
  assert.match(html, /function preludeEmptyWorkspaceStateRecord/);
  assert.match(html, /items:\[\],supplierOffers:\[\]/);
  assert.match(html, /source:'EMPTY_AFTER_CATALOG_RESET'/);
  assert.match(html, /preludeCloudReady=false;setPreludeCloudGate\('error'/);
});

test('raw Excel bytes stay local while operational metadata is in the remote snapshot', () => {
  const start = html.indexOf('function preludeWorkspaceStateRecord');
  const end = html.indexOf('function applyPreludeWorkspaceState', start);
  const source = html.slice(start, end);
  assert.match(source, /items:/);
  assert.match(source, /supplierOffers:/);
  assert.match(source, /movements:/);
  assert.match(source, /orders:/);
  assert.match(source, /suppliers:/);
  assert.doesNotMatch(source, /supplierTemplateMemory/);
  assert.doesNotMatch(source, /bytes:/);
});
