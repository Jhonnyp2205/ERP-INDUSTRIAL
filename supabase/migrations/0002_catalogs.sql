-- =====================================================================
-- ERP INDUSTRIAL · 0002 · Catálogos, materiales, unidades, lotes, series
-- =====================================================================
create type public.lot_status as enum ('disponible','cuarentena','bloqueado','vencido');

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.units_of_measure (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,          -- UND, CJ, KG, L ...
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tax_id text,
  contact text,
  phone text,
  email text,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check (length(trim(sku)) > 0),
  internal_code text unique,
  barcode text unique,
  name text not null,
  description text,
  category_id uuid references public.categories(id),
  base_unit_id uuid not null references public.units_of_measure(id),
  allow_fraction boolean not null default false,
  lot_controlled boolean not null default true,
  expiry_controlled boolean not null default true,
  serial_controlled boolean not null default false,
  quarantine_on_receipt boolean not null default false,   -- lotes nuevos entran en cuarentena
  expiry_alert_days int check (expiry_alert_days between 0 and 3650), -- null = valor de empresa
  min_stock numeric(18,6) not null default 0 check (min_stock >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not expiry_controlled or lot_controlled)
);
create index on public.materials(category_id);
create trigger materials_touch before update on public.materials for each row execute function public.touch_updated_at();

-- Conversiones explícitas: 1 unidad = factor unidades base
create table public.material_units (
  material_id uuid not null references public.materials(id) on delete cascade,
  unit_id uuid not null references public.units_of_measure(id),
  factor numeric(18,6) not null check (factor > 0),
  is_purchase boolean not null default false,
  is_consumption boolean not null default true,
  primary key (material_id, unit_id)
);

create or replace function public.ensure_base_unit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.material_units(material_id, unit_id, factor, is_purchase, is_consumption)
  values (new.id, new.base_unit_id, 1, true, true)
  on conflict (material_id, unit_id) do update set factor = 1;
  return new;
end $$;
create trigger materials_base_unit after insert or update of base_unit_id on public.materials
  for each row execute function public.ensure_base_unit();

create or replace function public.check_base_unit_factor() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.materials m where m.id = new.material_id and m.base_unit_id = new.unit_id) and new.factor <> 1 then
    raise exception 'ERP: la unidad base debe tener factor 1';
  end if;
  return new;
end $$;
create trigger material_units_check before insert or update on public.material_units
  for each row execute function public.check_base_unit_factor();

-- Convierte una cantidad a unidad base validando fracciones
create or replace function public.to_base_qty(p_material uuid, p_unit uuid, p_qty numeric) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v_factor numeric; v_frac boolean; v_base numeric;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'ERP: la cantidad debe ser mayor que cero'; end if;
  select mu.factor, m.allow_fraction into v_factor, v_frac
  from public.material_units mu join public.materials m on m.id = mu.material_id
  where mu.material_id = p_material and mu.unit_id = coalesce(p_unit, m.base_unit_id);
  if v_factor is null then raise exception 'ERP: la unidad indicada no está definida para el material'; end if;
  v_base := round(p_qty * v_factor, 6);
  if not v_frac and v_base <> trunc(v_base) then
    raise exception 'ERP: el material no admite fracciones (cantidad base resultante: %)', v_base;
  end if;
  return v_base;
end $$;

create table public.lots (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id),
  lot_code text not null check (length(trim(lot_code)) > 0),
  mfg_date date,
  exp_date date,
  status public.lot_status not null default 'disponible',
  status_reason text,
  supplier_id uuid references public.suppliers(id),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (material_id, lot_code),
  check (exp_date is null or mfg_date is null or exp_date >= mfg_date)
);
create index on public.lots(exp_date);

create table public.serial_numbers (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id),
  serial text not null,
  lot_id uuid references public.lots(id),
  warehouse_id uuid references public.warehouses(id),
  location_id uuid references public.locations(id),
  status text not null default 'en_stock' check (status in ('en_stock','asignado','en_transito','baja')),
  notes text,
  created_at timestamptz not null default now(),
  unique (material_id, serial)
);

-- Auditoría
create trigger categories_audit after insert or update or delete on public.categories for each row execute function public.audit_trigger();
create trigger uom_audit after insert or update or delete on public.units_of_measure for each row execute function public.audit_trigger();
create trigger suppliers_audit after insert or update or delete on public.suppliers for each row execute function public.audit_trigger();
create trigger materials_audit after insert or update or delete on public.materials for each row execute function public.audit_trigger();
create trigger material_units_audit after insert or update or delete on public.material_units for each row execute function public.audit_trigger();
create trigger lots_audit after insert or update or delete on public.lots for each row execute function public.audit_trigger();
create trigger serials_audit after insert or update or delete on public.serial_numbers for each row execute function public.audit_trigger();

-- RLS
alter table public.categories enable row level security;
alter table public.units_of_measure enable row level security;
alter table public.suppliers enable row level security;
alter table public.materials enable row level security;
alter table public.material_units enable row level security;
alter table public.lots enable row level security;
alter table public.serial_numbers enable row level security;

do $$
declare t text;
begin
  foreach t in array array['categories','units_of_measure','suppliers','materials','material_units','serial_numbers'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_active_user())', t||'_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_manage_catalogs())', t||'_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_manage_catalogs()) with check (public.can_manage_catalogs())', t||'_upd', t);
  end loop;
end $$;
-- Solo se pueden borrar conversiones (no hay borrado físico de maestros: se desactivan)
create policy material_units_del on public.material_units for delete to authenticated using (public.can_manage_catalogs());

create policy lots_read on public.lots for select to authenticated using (public.is_active_user());
create policy lots_ins on public.lots for insert to authenticated with check (public.can_manage_catalogs() and status in ('disponible','cuarentena'));
create policy lots_upd on public.lots for update to authenticated using (public.can_manage_catalogs()) with check (public.can_manage_catalogs());
-- El estado del lote solo cambia mediante set_lot_status()
revoke update on public.lots from authenticated;
grant update (mfg_date, exp_date, notes, supplier_id) on public.lots to authenticated;

-- Cambio de estado de lote (cuarentena requiere resolución autorizada)
create or replace function public.set_lot_status(p_lot uuid, p_status public.lot_status, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_old public.lot_status; v_exp date;
begin
  perform public.require_user();
  if not public.has_role('admin','supervisor','calidad') then
    raise exception 'ERP: no autorizado para cambiar el estado de lotes' using errcode='42501';
  end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'ERP: indique el motivo'; end if;
  select status, exp_date into v_old, v_exp from public.lots where id = p_lot for update;
  if not found then raise exception 'ERP: lote no encontrado'; end if;
  if p_status = 'disponible' and v_exp is not null and v_exp < current_date then
    raise exception 'ERP: un lote vencido no puede habilitarse';
  end if;
  update public.lots set status = p_status, status_reason = p_reason where id = p_lot;
  perform public.log_audit('lot_status', 'lots', p_lot::text,
    jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
end $$;

-- Vista de lotes con vida útil
create or replace view public.v_lots with (security_invoker = true) as
select l.*, m.sku, m.name as material_name,
  case when l.exp_date is not null and l.mfg_date is not null then l.exp_date - l.mfg_date end as shelf_life_days,
  case when l.exp_date is not null then l.exp_date - current_date end as remaining_days,
  case when l.exp_date is not null and l.mfg_date is not null and l.exp_date > l.mfg_date
       then round(100.0 * greatest(l.exp_date - current_date, 0) / (l.exp_date - l.mfg_date), 1) end as remaining_pct,
  coalesce(m.expiry_alert_days, (select default_expiry_alert_days from public.company_settings where id = 1)) as alert_days,
  case
    when l.status <> 'disponible' then l.status::text
    when l.exp_date is not null and l.exp_date < current_date then 'vencido'
    when l.exp_date is not null and l.exp_date - current_date <= coalesce(m.expiry_alert_days, (select default_expiry_alert_days from public.company_settings where id = 1)) then 'por_vencer'
    else 'disponible' end as effective_status
from public.lots l join public.materials m on m.id = l.material_id;
