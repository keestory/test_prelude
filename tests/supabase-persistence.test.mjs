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
const sharedMigration = await readFile(
  new URL('../supabase/migrations/20260827092749_public_shared_workspace.sql', import.meta.url),
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
  assert.match(sharedMigration, /and revision = p_expected_revision/);
  assert.match(sharedMigration, /last_operation_id = p_operation_id/);
  assert.match(sharedMigration, /PRELUDE_WORKSPACE_CONFLICT/);
  assert.match(sharedMigration, /pg_catalog\.pg_column_size\(p_state\) > 10485760/);
});

test('the app opens the shared Supabase workspace without a login screen', () => {
  assert.match(html, /id="mb-cloud-gate"/);
  assert.match(html, /id="mb-cloud-title">&lt; PRELUDE 준비 중/);
  assert.doesNotMatch(html, /mb-cloud-login/);
  assert.doesNotMatch(html, /mb-cloud-email/);
  assert.doesNotMatch(html, /mb-cloud-password/);
  assert.doesNotMatch(html, /mb-cloud-logout/);
  assert.doesNotMatch(html, /signInWithPassword|signInWithOtp|signInAnonymously|getSession\(\)|onAuthStateChange/);
  assert.match(html, /child\.setAttribute\('inert',''\)/);
  assert.match(html, /rpc\('get_prelude_workspace'\)/);
  assert.match(html, /persistSession:false/);
  assert.match(html, /data-supabase-access/);
  assert.match(html, /rpcName=brandImport\?'save_prelude_workspace_with_brands':'save_prelude_workspace'/);
  assert.doesNotMatch(html, /function preludeEmptyWorkspaceStateRecord/);
  assert.doesNotMatch(html, /from\('prelude_workspaces'\)/);
  assert.match(html, /preludeCloudReady=false;setPreludeCloudGate\('error'/);
});

test('public access stays limited to validated singleton RPCs', () => {
  assert.match(sharedMigration, /access_mode in \('owner', 'public_shared'\)/);
  assert.match(sharedMigration, /PRELUDE_SHARED_WORKSPACE_REQUIRES_SINGLE_ROW/);
  assert.match(sharedMigration, /where access_mode = 'public_shared'/);
  assert.match(sharedMigration, /revoke all on table public\.prelude_workspaces from anon/);
  assert.match(sharedMigration, /revoke all on table public\.prelude_workspaces from authenticated/);
  assert.match(sharedMigration, /revoke all on table public\.prelude_import_brand_observations from anon/);
  assert.match(sharedMigration, /revoke all on table public\.prelude_import_brand_observations from authenticated/);
  assert.match(sharedMigration, /grant execute on function public\.get_prelude_workspace\(\) to anon, authenticated/);
  assert.match(sharedMigration, /grant execute on function public\.save_prelude_workspace\(bigint, jsonb, uuid\) to anon, authenticated/);
  assert.match(sharedMigration, /grant execute on function public\.save_prelude_workspace_with_brands\([\s\S]*?\) to anon, authenticated/);
  assert.match(sharedMigration, /security definer/);
  assert.doesNotMatch(sharedMigration, /grant (select|insert|update|delete).* to anon/i);
  assert.doesNotMatch(html, /service_role|sb_secret_/i);
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

test('anonymous shared state cannot trigger destructive browser-local purge', () => {
  assert.doesNotMatch(html, /id="prelude-local-purge"/);
  assert.doesNotMatch(html, /purge\.localTemplates|data-local-template-purge/);
  assert.match(sharedMigration, /state = state - 'purge'/);
  assert.match(sharedMigration, /p_state \? 'purge'/);
  assert.match(sharedMigration, /PRELUDE_REMOTE_PURGE_FORBIDDEN/);
});

test('anonymous brand observations are bounded and serialized with workspace writes', () => {
  assert.match(sharedMigration, /v_max_observations_per_import constant integer := 500/);
  assert.match(sharedMigration, /v_max_total_observations constant integer := 50000/);
  assert.match(sharedMigration, /where access_mode = 'public_shared'\s+for update/);
  assert.match(sharedMigration, /if v_workspace\.last_operation_id = p_operation_id then\s+return v_workspace;\s+end if;[\s\S]*?from public\.save_prelude_workspace/);
  assert.match(sharedMigration, /select count\(\*\)[\s\S]*?where owner_id = v_workspace\.owner_id/);
  assert.match(sharedMigration, /PRELUDE_BRAND_OBSERVATION_LIMIT_EXCEEDED/);
});
