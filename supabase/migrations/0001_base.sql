-- =====================================================================
-- ERP INDUSTRIAL · 0001 · Base: roles, perfiles, almacenes, auditoría
-- =====================================================================
-- gen_random_uuid() es nativo en PostgreSQL 13+ (no requiere extensiones)

-- ---------- Tipos ----------
create type public.app_role as enum ('admin','supervisor','operador','mantenimiento','calidad','consulta');

-- ---------- Configuración de empresa (fila única) ----------
create table public.company_settings (
  id smallint primary key default 1 check (id = 1),
  company_name text not null default 'Mi Empresa',
  tax_id text,
  address text,
  currency text not null default 'BOB' check (currency = 'BOB'),
  default_expiry_alert_days int not null default 30 check (default_expiry_alert_days between 0 and 3650),
  updated_at timestamptz not null default now()
);
insert into public.company_settings (id) values (1);

-- ---------- Perfiles ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text not null default '',
  role public.app_role not null default 'consulta',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Almacenes y ubicaciones ----------
create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(trim(code)) > 0),
  name text not null,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id),
  code text not null,
  name text not null,
  barcode text unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (warehouse_id, code)
);
create index on public.locations(warehouse_id);

create table public.user_warehouse_access (
  user_id uuid not null references public.profiles(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, warehouse_id)
);

-- ---------- Funciones de autorización ----------
create or replace function public.current_app_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = 'admin', false)
$$;

create or replace function public.has_role(variadic roles public.app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = any(roles), false)
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_app_role() is not null
$$;

create or replace function public.has_warehouse_access(wh uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_active_user() and exists (
    select 1 from public.user_warehouse_access a where a.user_id = auth.uid() and a.warehouse_id = wh))
$$;

create or replace function public.can_approve_in(wh uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.has_role('supervisor') and public.has_warehouse_access(wh))
$$;

create or replace function public.can_view_costs() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin','supervisor')
$$;

create or replace function public.can_manage_catalogs() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin','supervisor')
$$;

-- Lanza error si no hay usuario activo; devuelve su id
create or replace function public.require_user() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_active_user() then
    raise exception 'ERP: sesión no válida o usuario inactivo' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

-- ---------- Auditoría ----------
create table public.audit_logs (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  table_name text,
  record_id text,
  old_data jsonb,
  new_data jsonb,
  context jsonb
);
create index on public.audit_logs(at desc);
create index on public.audit_logs(table_name, record_id);

create or replace function public.log_audit(p_action text, p_table text, p_record text, p_context jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_logs(user_id, action, table_name, record_id, context)
  values (auth.uid(), p_action, p_table, p_record, p_context)
$$;
revoke execute on function public.log_audit(text,text,text,jsonb) from public, anon, authenticated;

create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  v_id := coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'id', null);
  insert into public.audit_logs(user_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), lower(tg_op), tg_table_name, v_id,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create or replace function public.forbid_modification() returns trigger
language plpgsql as $$
begin
  raise exception 'ERP: los registros de % son inmutables', tg_table_name using errcode = '42501';
end $$;

create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.forbid_modification();

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ---------- Protección de perfiles (anti elevación de privilegios) ----------
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() nulo = service_role (función de servidor) o migraciones
  if auth.uid() is null then return new; end if;
  if (new.role is distinct from old.role or new.active is distinct from old.active or new.email is distinct from old.email) then
    if not public.is_admin() then
      raise exception 'ERP: no tiene permiso para cambiar roles o estado de usuarios' using errcode = '42501';
    end if;
    if new.id = auth.uid() and (new.role <> 'admin' or not new.active) then
      raise exception 'ERP: un administrador no puede quitarse a sí mismo el rol ni desactivarse' using errcode = '42501';
    end if;
  end if;
  if new.id <> old.id then raise exception 'ERP: id inmutable'; end if;
  return new;
end $$;
create trigger profiles_protect before update on public.profiles
  for each row execute function public.protect_profile();
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function public.audit_trigger();

-- Alta automática de perfil. El rol inicial SOLO se toma de app_metadata
-- (que únicamente puede escribir el servidor), nunca de user_metadata.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role public.app_role := 'consulta';
begin
  begin
    v_role := coalesce((new.raw_app_meta_data->>'role')::public.app_role, 'consulta');
  exception when others then v_role := 'consulta';
  end;
  insert into public.profiles(id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_app_meta_data->>'full_name', new.raw_user_meta_data->>'full_name', ''), v_role)
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create trigger warehouses_audit after insert or update or delete on public.warehouses
  for each row execute function public.audit_trigger();
create trigger locations_audit after insert or update or delete on public.locations
  for each row execute function public.audit_trigger();
create trigger uwa_audit after insert or update or delete on public.user_warehouse_access
  for each row execute function public.audit_trigger();
create trigger settings_audit after update on public.company_settings
  for each row execute function public.audit_trigger();

-- ---------- RLS ----------
alter table public.company_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.warehouses enable row level security;
alter table public.locations enable row level security;
alter table public.user_warehouse_access enable row level security;
alter table public.audit_logs enable row level security;

create policy settings_read on public.company_settings for select to authenticated using (public.is_active_user());
create policy settings_admin on public.company_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active_user());
-- Solo el admin modifica perfiles; el propio usuario edita su nombre mediante RPC update_my_name
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy wh_read on public.warehouses for select to authenticated using (public.is_active_user());
create policy wh_admin on public.warehouses for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy loc_read on public.locations for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy loc_write on public.locations for insert to authenticated
  with check (public.can_manage_catalogs() and public.has_warehouse_access(warehouse_id));
create policy loc_update on public.locations for update to authenticated
  using (public.can_manage_catalogs() and public.has_warehouse_access(warehouse_id))
  with check (public.can_manage_catalogs() and public.has_warehouse_access(warehouse_id));

create policy uwa_read on public.user_warehouse_access for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy uwa_admin on public.user_warehouse_access for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy audit_read on public.audit_logs for select to authenticated using (public.is_admin());

-- Cambiar el propio nombre (sin tocar rol)
create or replace function public.update_my_name(p_full_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_user();
  if length(trim(coalesce(p_full_name,''))) = 0 then raise exception 'ERP: nombre requerido'; end if;
  update public.profiles set full_name = trim(p_full_name) where id = auth.uid();
end $$;
