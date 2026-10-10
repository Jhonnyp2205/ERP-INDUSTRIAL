-- =====================================================================
-- ERP INDUSTRIAL · 0003 · Existencias, documentos, movimientos, costos
-- =====================================================================
create type public.doc_type as enum ('entrada','devolucion','salida','ajuste');
create type public.doc_status as enum ('borrador','pendiente','aprobado','confirmado','rechazado','anulado');
create type public.movement_type as enum
  ('entrada','devolucion','salida','ajuste_pos','ajuste_neg','traslado_salida','traslado_entrada','traslado_baja');
create type public.valuation_method as enum ('promedio','fifo');

-- Numeración correlativa
create table public.doc_counters (prefix text primary key, last_value bigint not null default 0);
alter table public.doc_counters enable row level security; -- sin políticas: solo funciones

create or replace function public._next_number(p_prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into public.doc_counters(prefix, last_value) values (p_prefix, 1)
  on conflict (prefix) do update set last_value = public.doc_counters.last_value + 1
  returning last_value into v;
  return p_prefix || '-' || to_char(current_date, 'YYYY') || '-' || lpad(v::text, 6, '0');
end $$;

-- Períodos contables (mensuales)
create table public.accounting_periods (
  period date primary key check (extract(day from period) = 1),
  status text not null default 'abierto' check (status in ('abierto','cerrado')),
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  notes text
);

-- Saldos
create table public.stock_balances (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id),
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.locations(id),
  lot_id uuid references public.lots(id),
  qty_on_hand numeric(18,6) not null default 0 check (qty_on_hand >= 0),
  qty_reserved numeric(18,6) not null default 0 check (qty_reserved >= 0),
  updated_at timestamptz not null default now(),
  check (qty_reserved <= qty_on_hand),
  unique nulls not distinct (material_id, warehouse_id, location_id, lot_id)
);
create index on public.stock_balances(warehouse_id, material_id);
create index on public.stock_balances(lot_id);

-- Documentos de inventario
create table public.inventory_documents (
  id uuid primary key default gen_random_uuid(),
  doc_number text not null unique,
  doc_type public.doc_type not null,
  status public.doc_status not null default 'borrador',
  warehouse_id uuid not null references public.warehouses(id),
  supplier_id uuid references public.suppliers(id),
  work_order_id uuid,          -- FK añadida en 0006
  stock_count_id uuid,         -- FK añadida abajo
  reference text,
  reason text,
  notes text,
  posting_date date,
  idempotency_key uuid unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  submitted_by uuid references public.profiles(id), submitted_at timestamptz,
  approved_by uuid references public.profiles(id), approved_at timestamptz,
  rejected_by uuid references public.profiles(id), rejected_at timestamptz, rejection_reason text,
  confirmed_by uuid references public.profiles(id), confirmed_at timestamptz,
  cancelled_by uuid references public.profiles(id), cancelled_at timestamptz, cancel_reason text,
  check (approved_by is null or approved_by <> created_by),
  check (doc_type <> 'ajuste' or length(trim(coalesce(reason,''))) > 0)
);
create index on public.inventory_documents(warehouse_id, status);
create index on public.inventory_documents(doc_type, created_at desc);

create table public.inventory_document_lines (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.inventory_documents(id) on delete cascade,
  line_no int not null,
  material_id uuid not null references public.materials(id),
  unit_id uuid not null references public.units_of_measure(id),
  qty numeric(18,6) not null check (qty > 0),
  qty_base numeric(18,6) not null check (qty_base > 0),
  direction smallint not null default 1 check (direction in (1,-1)), -- solo ajustes usan -1
  location_id uuid references public.locations(id),
  lot_id uuid references public.lots(id),
  lot_code text,
  mfg_date date,
  exp_date date,
  notes text,
  unique (document_id, line_no)
);
create index on public.inventory_document_lines(material_id);

-- Costos ingresados por línea (separados para RLS de costos)
create table public.document_line_costs (
  line_id uuid primary key references public.inventory_document_lines(id) on delete cascade,
  unit_cost numeric(18,6) not null check (unit_cost >= 0),       -- BOB por unidad de la línea
  unit_cost_base numeric(18,6) not null check (unit_cost_base >= 0) -- BOB por unidad base
);

-- Reservas / asignaciones FEFO
create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  balance_id uuid not null references public.stock_balances(id),
  material_id uuid not null references public.materials(id),
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.locations(id),
  lot_id uuid references public.lots(id),
  qty numeric(18,6) not null check (qty > 0),
  document_id uuid references public.inventory_documents(id),
  document_line_id uuid references public.inventory_document_lines(id),
  transfer_id uuid,
  transfer_line_id uuid,
  status text not null default 'activa' check (status in ('activa','consumida','liberada')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check (num_nonnulls(document_line_id, transfer_line_id) = 1)
);
create index on public.stock_reservations(document_id) where status = 'activa';
create index on public.stock_reservations(transfer_id) where status = 'activa';

-- Movimientos (inmutables)
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  posting_date date not null default current_date,
  movement_type public.movement_type not null,
  material_id uuid not null references public.materials(id),
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.locations(id),
  lot_id uuid references public.lots(id),
  qty numeric(18,6) not null check (qty <> 0),   -- en unidad base, con signo
  balance_after numeric(18,6),
  document_id uuid references public.inventory_documents(id),
  document_line_id uuid references public.inventory_document_lines(id),
  transfer_id uuid,
  transfer_item_id uuid,
  user_id uuid references public.profiles(id),
  notes text
);
create index on public.inventory_movements(material_id, created_at desc);
create index on public.inventory_movements(warehouse_id, created_at desc);
create index on public.inventory_movements(lot_id);
create trigger movements_immutable before update or delete on public.inventory_movements
  for each row execute function public.forbid_modification();

create table public.movement_costs (
  movement_id uuid primary key references public.inventory_movements(id),
  method public.valuation_method not null,
  unit_cost numeric(18,6) not null,
  total_cost numeric(18,4) not null
);
create trigger movement_costs_immutable before update or delete on public.movement_costs
  for each row execute function public.forbid_modification();

-- Valoración
create table public.material_costs (
  material_id uuid primary key references public.materials(id),
  qty numeric(18,6) not null default 0 check (qty >= 0),
  value numeric(18,4) not null default 0 check (value >= 0),
  updated_at timestamptz not null default now()
);

create table public.cost_layers (
  id bigserial primary key,
  material_id uuid not null references public.materials(id),
  received_at timestamptz not null default now(),
  source_movement_id uuid references public.inventory_movements(id),
  origin text not null default 'entrada' check (origin in ('entrada','ajuste','devolucion','cambio_metodo')),
  qty_in numeric(18,6) not null check (qty_in > 0),
  qty_remaining numeric(18,6) not null check (qty_remaining >= 0 and qty_remaining <= qty_in),
  unit_cost numeric(18,6) not null check (unit_cost >= 0),
  closed_reason text
);
create index on public.cost_layers(material_id, received_at, id) where qty_remaining > 0;

create table public.valuation_methods (
  id bigserial primary key,
  method public.valuation_method not null,
  effective_from timestamptz not null default now(),
  requested_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  request_id uuid,
  created_at timestamptz not null default now()
);
insert into public.valuation_methods(method, effective_from) values ('promedio', now());

create table public.valuation_change_requests (
  id uuid primary key default gen_random_uuid(),
  to_method public.valuation_method not null,
  effective_date date not null,
  reason text not null check (length(trim(reason)) >= 10),
  status text not null default 'pendiente' check (status in ('pendiente','aprobada','aplicada','rechazada','anulada')),
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_notes text,
  applied_at timestamptz,
  check (decided_by is null or decided_by <> requested_by)
);

create table public.valuation_change_snapshots (
  id bigserial primary key,
  request_id uuid not null references public.valuation_change_requests(id),
  material_id uuid not null references public.materials(id),
  method_from public.valuation_method not null,
  method_to public.valuation_method not null,
  qty numeric(18,6) not null,
  value_before numeric(18,4) not null,
  value_after numeric(18,4) not null,
  unit_cost_after numeric(18,6),
  created_at timestamptz not null default now()
);

-- Recuentos físicos
create table public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  count_number text not null unique,
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.locations(id),
  status text not null default 'abierto' check (status in ('abierto','cerrado','anulado')),
  notes text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  adjustment_document_id uuid references public.inventory_documents(id)
);
alter table public.inventory_documents
  add constraint inventory_documents_count_fk foreign key (stock_count_id) references public.stock_counts(id);

create table public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  location_id uuid references public.locations(id),
  lot_id uuid references public.lots(id),
  system_qty numeric(18,6) not null default 0,
  counted_qty numeric(18,6) check (counted_qty >= 0),
  counted_by uuid references public.profiles(id),
  counted_at timestamptz,
  notes text,
  unique nulls not distinct (count_id, material_id, location_id, lot_id)
);

-- Auditoría
create trigger invdocs_audit after insert or update on public.inventory_documents for each row execute function public.audit_trigger();
create trigger periods_audit after insert or update or delete on public.accounting_periods for each row execute function public.audit_trigger();
create trigger vcr_audit after insert or update on public.valuation_change_requests for each row execute function public.audit_trigger();
create trigger counts_audit after insert or update on public.stock_counts for each row execute function public.audit_trigger();

-- ---------- RLS (solo lectura para clientes; escritura vía RPC) ----------
alter table public.accounting_periods enable row level security;
alter table public.stock_balances enable row level security;
alter table public.inventory_documents enable row level security;
alter table public.inventory_document_lines enable row level security;
alter table public.document_line_costs enable row level security;
alter table public.stock_reservations enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.movement_costs enable row level security;
alter table public.material_costs enable row level security;
alter table public.cost_layers enable row level security;
alter table public.valuation_methods enable row level security;
alter table public.valuation_change_requests enable row level security;
alter table public.valuation_change_snapshots enable row level security;
alter table public.stock_counts enable row level security;
alter table public.stock_count_lines enable row level security;

create policy periods_read on public.accounting_periods for select to authenticated using (public.is_active_user());
create policy balances_read on public.stock_balances for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy docs_read on public.inventory_documents for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy lines_read on public.inventory_document_lines for select to authenticated
  using (exists (select 1 from public.inventory_documents d where d.id = document_id and public.has_warehouse_access(d.warehouse_id)));
create policy linecosts_read on public.document_line_costs for select to authenticated using (public.can_view_costs());
create policy res_read on public.stock_reservations for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy mov_read on public.inventory_movements for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy movcost_read on public.movement_costs for select to authenticated using (public.can_view_costs());
create policy matcost_read on public.material_costs for select to authenticated using (public.can_view_costs());
create policy layers_read on public.cost_layers for select to authenticated using (public.can_view_costs());
create policy vm_read on public.valuation_methods for select to authenticated using (public.is_active_user());
create policy vcr_read on public.valuation_change_requests for select to authenticated using (public.can_view_costs());
create policy vcs_read on public.valuation_change_snapshots for select to authenticated using (public.can_view_costs());
create policy counts_read on public.stock_counts for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy countlines_read on public.stock_count_lines for select to authenticated
  using (exists (select 1 from public.stock_counts c where c.id = count_id and public.has_warehouse_access(c.warehouse_id)));
