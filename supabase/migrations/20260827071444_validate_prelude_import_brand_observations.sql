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
  v_observation jsonb;
  v_brand_key text;
  v_row_count_text text;
  v_seen_keys text[] := array[]::text[];
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'PRELUDE_AUTH_REQUIRED';
  end if;

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

  if p_observations is null or jsonb_typeof(p_observations) <> 'array' then
    raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATIONS_INVALID';
  end if;

  if jsonb_array_length(p_observations) > 10000 then
    raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATIONS_INVALID';
  end if;

  for v_observation in
    select observation.value
      from pg_catalog.jsonb_array_elements(p_observations) as observation(value)
  loop
    if jsonb_typeof(v_observation) <> 'object' then
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

    if jsonb_typeof(v_observation -> 'brandValues') is distinct from 'array'
       or jsonb_typeof(v_observation -> 'sourceSheets') is distinct from 'array'
       or jsonb_typeof(v_observation -> 'sourceHeaders') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_ARRAY_INVALID';
    end if;

    if jsonb_array_length(v_observation -> 'brandValues') < 1
       or jsonb_array_length(v_observation -> 'brandValues') > 100
       or jsonb_array_length(v_observation -> 'sourceSheets') > 100
       or jsonb_array_length(v_observation -> 'sourceHeaders') > 100 then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_ARRAY_INVALID';
    end if;

    if exists (
      select 1
        from pg_catalog.jsonb_array_elements(v_observation -> 'brandValues') as entry(value)
       where jsonb_typeof(entry.value) <> 'string'
          or btrim(entry.value #>> '{}') = ''
          or length(btrim(entry.value #>> '{}')) > 512
    ) or exists (
      select 1
        from pg_catalog.jsonb_array_elements(v_observation -> 'sourceSheets') as entry(value)
       where jsonb_typeof(entry.value) <> 'string'
          or length(btrim(entry.value #>> '{}')) > 512
    ) or exists (
      select 1
        from pg_catalog.jsonb_array_elements(v_observation -> 'sourceHeaders') as entry(value)
       where jsonb_typeof(entry.value) <> 'string'
          or length(btrim(entry.value #>> '{}')) > 512
    ) then
      raise exception using errcode = '22023', message = 'PRELUDE_BRAND_OBSERVATION_ARRAY_VALUE_INVALID';
    end if;
  end loop;

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
    observation.value -> 'brandValues',
    (observation.value ->> 'rowCount')::integer,
    observation.value -> 'sourceSheets',
    observation.value -> 'sourceHeaders',
    nullif(left(coalesce(p_file_name, ''), 1024), ''),
    p_file_size,
    p_file_last_modified
  from pg_catalog.jsonb_array_elements(p_observations) as observation(value)
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
