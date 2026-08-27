create table public.prelude_import_brand_observations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  supplier_id text not null,
  import_id uuid not null,
  brand_key text not null,
  brand_value text not null,
  brand_values jsonb not null default '[]'::jsonb,
  row_count integer not null check (row_count > 0),
  source_sheets jsonb not null default '[]'::jsonb,
  source_headers jsonb not null default '[]'::jsonb,
  file_name text,
  file_size bigint check (file_size is null or file_size >= 0),
  file_last_modified bigint check (file_last_modified is null or file_last_modified >= 0),
  observed_at timestamptz not null default now(),
  constraint prelude_import_brand_observations_identity_key
    unique (owner_id, supplier_id, import_id, brand_key),
  constraint prelude_import_brand_observations_supplier_present
    check (btrim(supplier_id) <> '' and length(supplier_id) <= 128),
  constraint prelude_import_brand_observations_brand_key_present
    check (btrim(brand_key) <> '' and length(brand_key) <= 256),
  constraint prelude_import_brand_observations_brand_value_present
    check (btrim(brand_value) <> '' and length(brand_value) <= 512),
  constraint prelude_import_brand_observations_brand_values_array
    check (jsonb_typeof(brand_values) = 'array'),
  constraint prelude_import_brand_observations_source_sheets_array
    check (jsonb_typeof(source_sheets) = 'array'),
  constraint prelude_import_brand_observations_source_headers_array
    check (jsonb_typeof(source_headers) = 'array')
);

comment on table public.prelude_import_brand_observations is
  'Append-only brand column values observed in each confirmed PRELUDE product workbook upload.';

create index prelude_import_brand_observations_lookup_idx
  on public.prelude_import_brand_observations
  (owner_id, supplier_id, brand_key, observed_at desc);

alter table public.prelude_import_brand_observations enable row level security;

revoke all on table public.prelude_import_brand_observations from anon;
revoke all on table public.prelude_import_brand_observations from authenticated;
grant select, insert on table public.prelude_import_brand_observations to authenticated;

create policy "prelude owners can read their brand observations"
  on public.prelude_import_brand_observations
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "prelude owners can append their brand observations"
  on public.prelude_import_brand_observations
  for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create or replace function public.save_prelude_workspace_with_brands(
  p_expected_revision bigint,
  p_state jsonb,
  p_operation_id uuid,
  p_import_id uuid,
  p_supplier_id text,
  p_file_name text,
  p_file_size bigint,
  p_file_last_modified bigint,
  p_observations jsonb
)
returns public.prelude_workspaces
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace public.prelude_workspaces;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'PRELUDE_AUTH_REQUIRED';
  end if;

  if p_import_id is null then
    raise exception using errcode = '22023', message = 'PRELUDE_IMPORT_ID_REQUIRED';
  end if;

  if p_supplier_id is null or btrim(p_supplier_id) = '' or length(p_supplier_id) > 128 then
    raise exception using errcode = '22023', message = 'PRELUDE_SUPPLIER_ID_INVALID';
  end if;

  if p_observations is null or jsonb_typeof(p_observations) <> 'array' then
    raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATIONS_INVALID';
  end if;

  select *
  into v_workspace
  from public.save_prelude_workspace(
    p_expected_revision,
    p_state,
    p_operation_id
  );

  insert into public.prelude_import_brand_observations (
    owner_id,
    supplier_id,
    import_id,
    brand_key,
    brand_value,
    brand_values,
    row_count,
    source_sheets,
    source_headers,
    file_name,
    file_size,
    file_last_modified
  )
  select
    auth.uid(),
    p_supplier_id,
    p_import_id,
    btrim(observation.value ->> 'brandKey'),
    btrim(observation.value ->> 'brandValue'),
    coalesce(observation.value -> 'brandValues', '[]'::jsonb),
    (observation.value ->> 'rowCount')::integer,
    coalesce(observation.value -> 'sourceSheets', '[]'::jsonb),
    coalesce(observation.value -> 'sourceHeaders', '[]'::jsonb),
    nullif(left(coalesce(p_file_name, ''), 1024), ''),
    p_file_size,
    p_file_last_modified
  from pg_catalog.jsonb_array_elements(p_observations) as observation(value)
  where btrim(coalesce(observation.value ->> 'brandKey', '')) <> ''
    and length(btrim(observation.value ->> 'brandKey')) <= 256
    and btrim(coalesce(observation.value ->> 'brandValue', '')) <> ''
    and length(btrim(observation.value ->> 'brandValue')) <= 512
    and jsonb_typeof(coalesce(observation.value -> 'brandValues', '[]'::jsonb)) = 'array'
    and jsonb_typeof(coalesce(observation.value -> 'sourceSheets', '[]'::jsonb)) = 'array'
    and jsonb_typeof(coalesce(observation.value -> 'sourceHeaders', '[]'::jsonb)) = 'array'
    and (observation.value ->> 'rowCount') ~ '^[1-9][0-9]*$'
  on conflict (owner_id, supplier_id, import_id, brand_key) do nothing;

  return v_workspace;
end;
$$;

revoke all on function public.save_prelude_workspace_with_brands(
  bigint, jsonb, uuid, uuid, text, text, bigint, bigint, jsonb
) from public;
revoke all on function public.save_prelude_workspace_with_brands(
  bigint, jsonb, uuid, uuid, text, text, bigint, bigint, jsonb
) from anon;
grant execute on function public.save_prelude_workspace_with_brands(
  bigint, jsonb, uuid, uuid, text, text, bigint, bigint, jsonb
) to authenticated;
