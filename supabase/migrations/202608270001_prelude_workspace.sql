create table public.prelude_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'PRELUDE',
  state jsonb not null default '{}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  last_operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prelude_workspaces_owner_key unique (owner_id),
  constraint prelude_workspaces_state_object check (jsonb_typeof(state) = 'object')
);

comment on table public.prelude_workspaces is
  'Authenticated PRELUDE operator workspace. Raw XLSX template bytes remain in browser IndexedDB.';

alter table public.prelude_workspaces enable row level security;

revoke all on table public.prelude_workspaces from anon;
revoke all on table public.prelude_workspaces from authenticated;
grant select, insert, update on table public.prelude_workspaces to authenticated;

create policy "prelude owners can read their workspace"
  on public.prelude_workspaces
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "prelude owners can create their workspace"
  on public.prelude_workspaces
  for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "prelude owners can update their workspace"
  on public.prelude_workspaces
  for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create or replace function public.save_prelude_workspace(
  p_expected_revision bigint,
  p_state jsonb,
  p_operation_id uuid
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

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'PRELUDE_REVISION_INVALID';
  end if;

  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception using errcode = '22023', message = 'PRELUDE_STATE_INVALID';
  end if;

  if p_operation_id is null then
    raise exception using errcode = '22023', message = 'PRELUDE_OPERATION_ID_REQUIRED';
  end if;

  if p_expected_revision = 0 then
    insert into public.prelude_workspaces (
      owner_id,
      state,
      revision,
      last_operation_id,
      updated_at
    )
    values (
      auth.uid(),
      p_state,
      1,
      p_operation_id,
      now()
    )
    on conflict (owner_id) do nothing
    returning * into v_workspace;
  else
    update public.prelude_workspaces
       set state = p_state,
           revision = revision + 1,
           last_operation_id = p_operation_id,
           updated_at = now()
     where owner_id = auth.uid()
       and revision = p_expected_revision
    returning * into v_workspace;
  end if;

  if v_workspace.id is null then
    select *
      into v_workspace
      from public.prelude_workspaces
     where owner_id = auth.uid();

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
grant execute on function public.save_prelude_workspace(bigint, jsonb, uuid) to authenticated;
