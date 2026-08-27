alter table public.prelude_workspaces
  add column access_mode text not null default 'owner'
  constraint prelude_workspaces_access_mode_check
    check (access_mode in ('owner', 'public_shared'));

do $$
begin
  if (select count(*) from public.prelude_workspaces) <> 1 then
    raise exception using errcode = '55000', message = 'PRELUDE_SHARED_WORKSPACE_REQUIRES_SINGLE_ROW';
  end if;

  update public.prelude_workspaces
     set access_mode = 'public_shared',
         state = state - 'purge'
   where access_mode = 'owner';
end;
$$;

create unique index prelude_workspaces_public_shared_singleton_idx
  on public.prelude_workspaces (access_mode)
  where access_mode = 'public_shared';

comment on column public.prelude_workspaces.access_mode is
  'public_shared is the single PRELUDE workspace exposed only through validated RPCs.';

revoke all on table public.prelude_workspaces from anon;
revoke all on table public.prelude_workspaces from authenticated;
revoke all on table public.prelude_import_brand_observations from anon;
revoke all on table public.prelude_import_brand_observations from authenticated;

create or replace function public.get_prelude_workspace()
returns public.prelude_workspaces
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_workspace public.prelude_workspaces;
begin
  select *
    into v_workspace
    from public.prelude_workspaces
   where access_mode = 'public_shared';

  if v_workspace.id is null then
    raise exception using errcode = '55000', message = 'PRELUDE_SHARED_WORKSPACE_MISSING';
  end if;

  return v_workspace;
end;
$$;

revoke all on function public.get_prelude_workspace() from public;
revoke all on function public.get_prelude_workspace() from anon;
revoke all on function public.get_prelude_workspace() from authenticated;
grant execute on function public.get_prelude_workspace() to anon, authenticated;

create or replace function public.save_prelude_workspace(
  p_expected_revision bigint,
  p_state jsonb,
  p_operation_id uuid
)
returns public.prelude_workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace public.prelude_workspaces;
begin
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'PRELUDE_REVISION_INVALID';
  end if;

  if p_state is null or pg_catalog.jsonb_typeof(p_state) <> 'object'
     or pg_catalog.pg_column_size(p_state) > 10485760 then
    raise exception using errcode = '22023', message = 'PRELUDE_STATE_INVALID';
  end if;

  if p_state ? 'purge' then
    raise exception using errcode = '22023', message = 'PRELUDE_REMOTE_PURGE_FORBIDDEN';
  end if;

  if p_operation_id is null then
    raise exception using errcode = '22023', message = 'PRELUDE_OPERATION_ID_REQUIRED';
  end if;

  update public.prelude_workspaces
     set state = p_state,
         revision = revision + 1,
         last_operation_id = p_operation_id,
         updated_at = now()
   where access_mode = 'public_shared'
     and revision = p_expected_revision
  returning * into v_workspace;

  if v_workspace.id is null then
    select *
      into v_workspace
      from public.prelude_workspaces
     where access_mode = 'public_shared';

    if v_workspace.id is null then
      raise exception using errcode = '55000', message = 'PRELUDE_SHARED_WORKSPACE_MISSING';
    end if;

    if v_workspace.last_operation_id = p_operation_id then
      return v_workspace;
    end if;

    raise exception using errcode = '40001', message = 'PRELUDE_WORKSPACE_CONFLICT';
  end if;

  return v_workspace;
end;
$$;

revoke all on function public.save_prelude_workspace(bigint, jsonb, uuid) from public;
revoke all on function public.save_prelude_workspace(bigint, jsonb, uuid) from anon;
revoke all on function public.save_prelude_workspace(bigint, jsonb, uuid) from authenticated;
grant execute on function public.save_prelude_workspace(bigint, jsonb, uuid) to anon, authenticated;

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
security definer
set search_path = ''
as $$
declare
  v_workspace public.prelude_workspaces;
  v_observation jsonb;
  v_brand_key text;
  v_row_count_text text;
  v_seen_keys text[] := array[]::text[];
  v_total_observations bigint;
  v_max_observations_per_import constant integer := 500;
  v_max_total_observations constant integer := 50000;
begin
  if p_import_id is null or p_operation_id is distinct from p_import_id then
    raise exception using errcode = '22023', message = 'PRELUDE_IMPORT_OPERATION_ID_INVALID';
  end if;

  if p_supplier_id is null or btrim(p_supplier_id) = '' or length(p_supplier_id) > 128 then
    raise exception using errcode = '22023', message = 'PRELUDE_SUPPLIER_ID_INVALID';
  end if;

  if p_file_size is not null and p_file_size < 0
     or p_file_last_modified is not null and p_file_last_modified < 0 then
    raise exception using errcode = '22023', message = 'PRELUDE_IMPORT_FILE_METADATA_INVALID';
  end if;

  if p_observations is null or pg_catalog.jsonb_typeof(p_observations) <> 'array'
     or pg_catalog.jsonb_array_length(p_observations) > v_max_observations_per_import then
    raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATIONS_INVALID';
  end if;

  for v_observation in
    select observation.value
      from pg_catalog.jsonb_array_elements(p_observations) as observation(value)
  loop
    if pg_catalog.jsonb_typeof(v_observation) <> 'object' then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_INVALID';
    end if;

    v_brand_key := btrim(coalesce(v_observation ->> 'brandKey', ''));
    v_row_count_text := coalesce(v_observation ->> 'rowCount', '');

    if v_brand_key = '' or length(v_brand_key) > 256
       or btrim(coalesce(v_observation ->> 'brandValue', '')) = ''
       or length(btrim(v_observation ->> 'brandValue')) > 512
       or length(v_row_count_text) > 10
       or v_row_count_text !~ '^[1-9][0-9]*$'
       or v_row_count_text::numeric > 2147483647 then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_INVALID';
    end if;

    if v_brand_key = any(v_seen_keys) then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_DUPLICATE';
    end if;
    v_seen_keys := pg_catalog.array_append(v_seen_keys, v_brand_key);

    if pg_catalog.jsonb_typeof(v_observation -> 'brandValues') is distinct from 'array'
       or pg_catalog.jsonb_typeof(v_observation -> 'sourceSheets') is distinct from 'array'
       or pg_catalog.jsonb_typeof(v_observation -> 'sourceHeaders') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_ARRAY_INVALID';
    end if;

    if pg_catalog.jsonb_array_length(v_observation -> 'brandValues') < 1
       or pg_catalog.jsonb_array_length(v_observation -> 'brandValues') > 100
       or pg_catalog.jsonb_array_length(v_observation -> 'sourceSheets') > 100
       or pg_catalog.jsonb_array_length(v_observation -> 'sourceHeaders') > 100 then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_ARRAY_INVALID';
    end if;

    if exists (
      select 1
        from pg_catalog.jsonb_array_elements(v_observation -> 'brandValues') as entry(value)
       where pg_catalog.jsonb_typeof(entry.value) <> 'string'
          or btrim(entry.value #>> '{}') = ''
          or length(btrim(entry.value #>> '{}')) > 512
    ) or exists (
      select 1
        from pg_catalog.jsonb_array_elements(v_observation -> 'sourceSheets') as entry(value)
       where pg_catalog.jsonb_typeof(entry.value) <> 'string'
          or length(btrim(entry.value #>> '{}')) > 512
    ) or exists (
      select 1
        from pg_catalog.jsonb_array_elements(v_observation -> 'sourceHeaders') as entry(value)
       where pg_catalog.jsonb_typeof(entry.value) <> 'string'
          or length(btrim(entry.value #>> '{}')) > 512
    ) then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_ARRAY_VALUE_INVALID';
    end if;
  end loop;

  select *
    into v_workspace
    from public.prelude_workspaces
   where access_mode = 'public_shared'
     for update;

  if v_workspace.id is null then
    raise exception using errcode = '55000', message = 'PRELUDE_SHARED_WORKSPACE_MISSING';
  end if;

  if v_workspace.last_operation_id = p_operation_id then
    return v_workspace;
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
    v_workspace.owner_id,
    p_supplier_id,
    p_import_id,
    btrim(observation.value ->> 'brandKey'),
    btrim(observation.value ->> 'brandValue'),
    observation.value -> 'brandValues',
    (observation.value ->> 'rowCount')::integer,
    observation.value -> 'sourceSheets',
    observation.value -> 'sourceHeaders',
    nullif(left(coalesce(p_file_name, ''), 1024), ''),
    p_file_size,
    p_file_last_modified
  from pg_catalog.jsonb_array_elements(p_observations) as observation(value)
  on conflict (owner_id, supplier_id, import_id, brand_key) do nothing;

  select count(*)
    into v_total_observations
    from public.prelude_import_brand_observations
   where owner_id = v_workspace.owner_id;

  if v_total_observations > v_max_total_observations then
    raise exception using errcode = '54000', message = 'PRELUDE_BRAND_OBSERVATION_LIMIT_EXCEEDED';
  end if;

  return v_workspace;
end;
$$;

revoke all on function public.save_prelude_workspace_with_brands(
  bigint, jsonb, uuid, uuid, text, text, bigint, bigint, jsonb
) from public;
revoke all on function public.save_prelude_workspace_with_brands(
  bigint, jsonb, uuid, uuid, text, text, bigint, bigint, jsonb
) from anon;
revoke all on function public.save_prelude_workspace_with_brands(
  bigint, jsonb, uuid, uuid, text, text, bigint, bigint, jsonb
) from authenticated;
grant execute on function public.save_prelude_workspace_with_brands(
  bigint, jsonb, uuid, uuid, text, text, bigint, bigint, jsonb
) to anon, authenticated;
