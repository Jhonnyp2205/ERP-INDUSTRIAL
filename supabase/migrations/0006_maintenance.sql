-- =====================================================================
-- ERP INDUSTRIAL · 0006 · Activos industriales y mantenimiento
-- =====================================================================
create type public.asset_status as enum ('operativo','en_mantenimiento','fuera_de_servicio','baja');

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  barcode text unique,
  name text not null,
  asset_type text,
  brand text,
  model text,
  serial_number text,
  warehouse_id uuid references public.warehouses(id),
  location_id uuid references public.locations(id),
  status public.asset_status not null default 'operativo',
  criticality text not null default 'media' check (criticality in ('baja','media','alta','critica')),
  purchase_date date,
  technical_data jsonb not null default '{}'::jsonb,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger assets_touch before update on public.assets for each row execute function public.touch_updated_at();
alter table public.serial_numbers add column asset_id uuid references public.assets(id);

create table public.maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id),
  name text not null,
  frequency_days int not null check (frequency_days > 0),
  lead_days int not null default 7 check (lead_days >= 0),   -- se genera la OT con esta anticipación
  tasks text,
  responsible_id uuid references public.profiles(id),
  last_done date,
  next_due date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  wo_number text not null unique,
  asset_id uuid not null references public.assets(id),
  plan_id uuid references public.maintenance_plans(id),
  wo_type text not null check (wo_type in ('preventivo','correctivo')),
  priority text not null default 'media' check (priority in ('baja','media','alta','critica')),
  status text not null default 'abierta' check (status in ('abierta','en_progreso','en_espera','completada','cancelada')),
  title text not null,
  description text,
  assigned_to uuid references public.profiles(id),
  requested_by uuid references public.profiles(id) default auth.uid(),
  scheduled_date date,
  started_at timestamptz,
  completed_at timestamptz,
  labor_hours numeric(10,2) not null default 0 check (labor_hours >= 0),
  labor_cost numeric(18,2) not null default 0 check (labor_cost >= 0),
  external_cost numeric(18,2) not null default 0 check (external_cost >= 0),
  result_notes text,
  created_at timestamptz not null default now()
);
create index on public.work_orders(asset_id, status);
alter table public.inventory_documents
  add constraint invdoc_wo_fk foreign key (work_order_id) references public.work_orders(id);

create table public.work_order_materials (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id),
  material_id uuid not null references public.materials(id),
  qty_base numeric(18,6) not null check (qty_base > 0),
  unit_cost numeric(18,6) not null,
  total_cost numeric(18,4) not null,
  movement_id uuid references public.inventory_movements(id),
  document_id uuid references public.inventory_documents(id),
  created_at timestamptz not null default now()
);
create trigger wom_immutable before update or delete on public.work_order_materials
  for each row execute function public.forbid_modification();

create table public.maintenance_logs (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id),
  work_order_id uuid references public.work_orders(id),
  log_date date not null default current_date,
  description text not null,
  performed_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create trigger assets_audit after insert or update or delete on public.assets for each row execute function public.audit_trigger();
create trigger mplans_audit after insert or update or delete on public.maintenance_plans for each row execute function public.audit_trigger();
create trigger wo_audit after insert or update on public.work_orders for each row execute function public.audit_trigger();

create or replace function public.can_access_asset(p_asset uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.assets a where a.id = p_asset
                 and (a.warehouse_id is null or public.has_warehouse_access(a.warehouse_id)) and public.is_active_user())
$$;

create or replace function public.can_manage_maintenance() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin','mantenimiento')
$$;

alter table public.assets enable row level security;
alter table public.maintenance_plans enable row level security;
alter table public.work_orders enable row level security;
alter table public.work_order_materials enable row level security;
alter table public.maintenance_logs enable row level security;

create policy assets_read on public.assets for select to authenticated
  using (public.is_active_user() and (warehouse_id is null or public.has_warehouse_access(warehouse_id)));
create policy assets_ins on public.assets for insert to authenticated
  with check (public.can_manage_maintenance() and (warehouse_id is null or public.has_warehouse_access(warehouse_id)));
create policy assets_upd on public.assets for update to authenticated
  using (public.can_manage_maintenance() and public.can_access_asset(id))
  with check (public.can_manage_maintenance() and (warehouse_id is null or public.has_warehouse_access(warehouse_id)));

create policy mplans_read on public.maintenance_plans for select to authenticated using (public.can_access_asset(asset_id));
create policy mplans_ins on public.maintenance_plans for insert to authenticated with check (public.can_manage_maintenance() and public.can_access_asset(asset_id));
create policy mplans_upd on public.maintenance_plans for update to authenticated
  using (public.can_manage_maintenance() and public.can_access_asset(asset_id)) with check (public.can_manage_maintenance() and public.can_access_asset(asset_id));

create policy wo_read on public.work_orders for select to authenticated using (public.can_access_asset(asset_id));
create policy wo_ins on public.work_orders for insert to authenticated
  with check (public.can_access_asset(asset_id) and public.has_role('admin','mantenimiento','supervisor','operador','calidad')
              and status = 'abierta' and labor_cost = 0 and external_cost = 0);
create policy wo_upd on public.work_orders for update to authenticated
  using (public.can_manage_maintenance() and public.can_access_asset(asset_id) and status not in ('completada','cancelada'))
  with check (public.can_manage_maintenance() and public.can_access_asset(asset_id) and status <> 'completada');

create policy wom_read on public.work_order_materials for select to authenticated
  using (public.can_access_asset((select asset_id from public.work_orders w where w.id = work_order_id))
         and (public.can_view_costs() or public.has_role('mantenimiento')));
create policy mlogs_read on public.maintenance_logs for select to authenticated using (public.can_access_asset(asset_id));
create policy mlogs_ins on public.maintenance_logs for insert to authenticated
  with check (public.can_manage_maintenance() and public.can_access_asset(asset_id) and performed_by = auth.uid());

-- Número automático de OT
create or replace function public.wo_set_number() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.wo_number is null or new.wo_number = '' then new.wo_number := public._next_number('OT'); end if;
  return new;
end $$;
create trigger wo_number before insert on public.work_orders for each row execute function public.wo_set_number();

create or replace function public.complete_work_order(p_id uuid, p_notes text, p_labor_hours numeric, p_labor_cost numeric, p_external_cost numeric)
returns void language plpgsql security definer set search_path = public as $$
declare w public.work_orders;
begin
  perform public.require_user();
  select * into w from public.work_orders where id = p_id for update;
  if not found or not public.can_access_asset(w.asset_id) or not public.can_manage_maintenance() then
    raise exception 'ERP: no autorizado' using errcode='42501';
  end if;
  if w.status in ('completada','cancelada') then raise exception 'ERP: la OT ya está cerrada'; end if;
  if length(trim(coalesce(p_notes,''))) < 3 then raise exception 'ERP: describa el trabajo realizado'; end if;
  update public.work_orders set status = 'completada', completed_at = now(), result_notes = p_notes,
    labor_hours = coalesce(p_labor_hours, labor_hours), labor_cost = coalesce(p_labor_cost, labor_cost),
    external_cost = coalesce(p_external_cost, external_cost), started_at = coalesce(started_at, now())
  where id = p_id;
  insert into public.maintenance_logs(asset_id, work_order_id, description, performed_by)
  values (w.asset_id, p_id, w.wo_number || ' — ' || p_notes, auth.uid());
  if w.plan_id is not null then
    update public.maintenance_plans set last_done = current_date, next_due = current_date + frequency_days where id = w.plan_id;
  end if;
  update public.assets set status = 'operativo' where id = w.asset_id and status = 'en_mantenimiento';
end $$;

create or replace function public._generate_preventive_work_orders() returns int
language plpgsql security definer set search_path = public as $$
declare p record; n int := 0;
begin
  for p in select mp.*, a.name as asset_name from public.maintenance_plans mp join public.assets a on a.id = mp.asset_id
            where mp.active and a.active and a.status <> 'baja' and mp.next_due - mp.lead_days <= current_date
              and not exists (select 1 from public.work_orders w where w.plan_id = mp.id and w.status not in ('completada','cancelada')) loop
    insert into public.work_orders(asset_id, plan_id, wo_type, title, description, assigned_to, requested_by, scheduled_date)
    values (p.asset_id, p.id, 'preventivo', p.name || ' — ' || p.asset_name, p.tasks, p.responsible_id, null, p.next_due);
    n := n + 1;
  end loop;
  return n;
end $$;
