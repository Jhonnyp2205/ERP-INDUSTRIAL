-- =====================================================================
-- ERP INDUSTRIAL · 0009 · Vistas, informes y permisos de ejecución
-- Todas las vistas usan security_invoker: aplican el RLS de quien consulta.
-- =====================================================================

create or replace view public.v_stock with (security_invoker = true) as
select sb.id, sb.material_id, m.sku, m.name as material_name, u.code as unit_code,
  sb.warehouse_id, w.code as warehouse_code, w.name as warehouse_name,
  sb.location_id, lo.code as location_code,
  sb.lot_id, l.lot_code, l.exp_date, l.status as lot_status,
  sb.qty_on_hand, sb.qty_reserved,
  case when sb.lot_id is null or (l.status = 'disponible' and (l.exp_date is null or l.exp_date >= current_date))
       then sb.qty_on_hand - sb.qty_reserved else 0 end as qty_available,
  case when sb.lot_id is not null and (l.status <> 'disponible' or (l.exp_date is not null and l.exp_date < current_date))
       then sb.qty_on_hand else 0 end as qty_blocked,
  sb.updated_at
from public.stock_balances sb
join public.materials m on m.id = sb.material_id
join public.units_of_measure u on u.id = m.base_unit_id
join public.warehouses w on w.id = sb.warehouse_id
left join public.locations lo on lo.id = sb.location_id
left join public.lots l on l.id = sb.lot_id
where sb.qty_on_hand > 0 or sb.qty_reserved > 0;

create or replace view public.v_stock_in_transit with (security_invoker = true) as
select i.id as item_id, t.id as transfer_id, t.transfer_number, t.status,
  t.origin_warehouse_id, wo.name as origin_name, t.dest_warehouse_id, wd.name as dest_name,
  i.material_id, m.sku, m.name as material_name, i.lot_id, l.lot_code,
  i.qty_shipped, i.qty_received, i.qty_damaged, i.qty_missing,
  i.qty_shipped - i.qty_received as qty_in_transit, t.dispatched_at
from public.warehouse_transfer_items i
join public.warehouse_transfers t on t.id = i.transfer_id
join public.materials m on m.id = i.material_id
join public.warehouses wo on wo.id = t.origin_warehouse_id
join public.warehouses wd on wd.id = t.dest_warehouse_id
left join public.lots l on l.id = i.lot_id
where t.status in ('en_transito','recibido_parcial','con_diferencias') and i.qty_shipped - i.qty_received > 0;

create or replace view public.v_movements with (security_invoker = true) as
select mv.*, m.sku, m.name as material_name, w.code as warehouse_code, lo.code as location_code, l.lot_code,
  d.doc_number, t.transfer_number, p.full_name as user_name,
  mc.unit_cost, mc.total_cost, mc.method as valuation_method
from public.inventory_movements mv
join public.materials m on m.id = mv.material_id
join public.warehouses w on w.id = mv.warehouse_id
left join public.locations lo on lo.id = mv.location_id
left join public.lots l on l.id = mv.lot_id
left join public.inventory_documents d on d.id = mv.document_id
left join public.warehouse_transfers t on t.id = mv.transfer_id
left join public.profiles p on p.id = mv.user_id
left join public.movement_costs mc on mc.movement_id = mv.id;   -- costos visibles solo con permiso (RLS)

create or replace view public.v_valuation with (security_invoker = true) as
select m.id as material_id, m.sku, m.name, c.name as category, mc.qty, mc.value,
  case when mc.qty > 0 then round(mc.value / mc.qty, 6) end as unit_cost, mc.updated_at
from public.material_costs mc
join public.materials m on m.id = mc.material_id
left join public.categories c on c.id = m.category_id;

create or replace view public.v_pending_approvals with (security_invoker = true) as
select 'documento'::text as kind, d.id, d.doc_number as number, d.doc_type::text as subtype, d.status::text as status,
  d.warehouse_id, w.name as warehouse_name, d.created_by, p.full_name as created_by_name, d.created_at,
  '/inventario/documentos/' || d.id as link
from public.inventory_documents d join public.warehouses w on w.id = d.warehouse_id
left join public.profiles p on p.id = d.created_by
where d.status = 'pendiente'
union all
select 'traslado', t.id, t.transfer_number, 'traslado', t.status::text, t.origin_warehouse_id, w.name, t.created_by, p.full_name, t.created_at,
  '/traslados/' || t.id
from public.warehouse_transfers t join public.warehouses w on w.id = t.origin_warehouse_id
left join public.profiles p on p.id = t.created_by
where t.status in ('pendiente','preparado','con_diferencias');

create or replace view public.v_work_order_costs with (security_invoker = true) as
select w.id, w.wo_number, w.asset_id, a.code as asset_code, a.name as asset_name, w.wo_type, w.status,
  w.labor_cost, w.external_cost,
  coalesce((select sum(total_cost) from public.work_order_materials x where x.work_order_id = w.id), 0) as materials_cost,
  w.labor_cost + w.external_cost + coalesce((select sum(total_cost) from public.work_order_materials x where x.work_order_id = w.id), 0) as total_cost,
  w.completed_at, w.created_at
from public.work_orders w join public.assets a on a.id = w.asset_id;

create or replace function public.dashboard_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_user();
  select jsonb_build_object(
    'pending_approvals', (select count(*) from public.inventory_documents d where d.status = 'pendiente' and public.can_approve_in(d.warehouse_id) and d.created_by <> auth.uid())
                       + (select count(*) from public.warehouse_transfers t where (t.status = 'pendiente' and public.can_approve_in(t.origin_warehouse_id) and t.created_by <> auth.uid())
                                                                          or (t.status = 'preparado' and public.can_approve_in(t.origin_warehouse_id))
                                                                          or (t.status = 'con_diferencias' and public.can_approve_in(t.dest_warehouse_id))),
    'lots_expiring', (select count(*) from public.v_lots l where l.effective_status = 'por_vencer'
                      and exists (select 1 from public.stock_balances sb where sb.lot_id = l.id and sb.qty_on_hand > 0 and public.has_warehouse_access(sb.warehouse_id))),
    'lots_blocked', (select count(distinct sb.lot_id) from public.stock_balances sb join public.lots l on l.id = sb.lot_id
                     where sb.qty_on_hand > 0 and l.status <> 'disponible' and public.has_warehouse_access(sb.warehouse_id)),
    'in_transit', (select count(distinct t.id) from public.warehouse_transfers t where t.status in ('en_transito','recibido_parcial','con_diferencias')
                   and (public.has_warehouse_access(t.origin_warehouse_id) or public.has_warehouse_access(t.dest_warehouse_id))),
    'open_work_orders', (select count(*) from public.work_orders w where w.status in ('abierta','en_progreso','en_espera') and public.can_access_asset(w.asset_id)),
    'overdue_work_orders', (select count(*) from public.work_orders w where w.status in ('abierta','en_progreso','en_espera') and w.scheduled_date < current_date and public.can_access_asset(w.asset_id)),
    'open_incidents', (select count(*) from public.incidents i where i.status <> 'cerrada' and public.can_access_incident(i.id)),
    'cleaning_pending', (select count(*) from public.cleaning_tasks c where c.status = 'pendiente' and public.has_warehouse_access(c.warehouse_id)),
    'out_of_range_7d', (select count(*) from public.temperature_logs t where t.out_of_range and t.measured_at > now() - interval '7 days' and public.has_warehouse_access(t.warehouse_id)),
    'inventory_value', case when public.can_view_costs() then (select coalesce(sum(value),0) from public.material_costs) end,
    'valuation_method', (select method from public.valuation_methods order by effective_from desc, id desc limit 1),
    'unread_notifications', (select count(*) from public.notifications n where n.user_id = auth.uid() and n.read_at is null)
  ) into v;
  return v;
end $$;

-- ---------- Permisos de ejecución ----------
-- 1) Nadie anónimo ejecuta funciones del ERP.
-- 2) Las funciones internas (prefijo "_") y de trigger no son invocables por clientes.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname, p.prorettype = 'trigger'::regtype as is_trigger
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname like '\_%' or f.is_trigger or f.proname in ('log_audit','audit_trigger','forbid_modification','touch_updated_at') then
      execute format('revoke execute on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- Defensa en profundidad: tablas que SOLO se escriben mediante funciones RPC
do $$
declare t text;
begin
  foreach t in array array['stock_balances','inventory_documents','inventory_document_lines','document_line_costs',
    'stock_reservations','inventory_movements','movement_costs','material_costs','cost_layers','valuation_methods',
    'valuation_change_requests','valuation_change_snapshots','stock_counts','stock_count_lines','accounting_periods',
    'doc_counters','warehouse_transfers','warehouse_transfer_lines','warehouse_transfer_items','work_order_materials',
    'cleaning_tasks','cleaning_task_checks','documents','audit_logs','profiles'] loop
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
  -- Registros que se crean pero nunca se modifican
  foreach t in array array['temperature_logs','record_notes','maintenance_logs'] loop
    execute format('revoke update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;
-- El administrador sí edita perfiles (nombre, rol, estado) bajo RLS + trigger de protección
grant update (full_name, role, active) on public.profiles to authenticated;

-- Las vistas no deben ser accesibles por anon
revoke all on public.v_stock, public.v_stock_in_transit, public.v_movements, public.v_valuation,
  public.v_pending_approvals, public.v_work_order_costs, public.v_lots from anon;
-- Tablas: anon sin acceso
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke all on public.%I from anon', t.tablename);
  end loop;
end $$;
