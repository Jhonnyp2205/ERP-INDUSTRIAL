-- =====================================================================
-- ERP INDUSTRIAL · 0004 · Funciones transaccionales de inventario
-- Toda escritura de existencias, movimientos y costos pasa por aquí.
-- Funciones con prefijo "_" son internas (sin EXECUTE para clientes).
-- =====================================================================

-- ---------------- Utilidades internas ----------------
create or replace function public._assert_period_open(p_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.accounting_periods
             where period = date_trunc('month', p_date)::date and status = 'cerrado') then
    raise exception 'ERP: el período % está cerrado', to_char(p_date, 'MM/YYYY');
  end if;
end $$;

create or replace function public._current_method() returns public.valuation_method
language plpgsql security definer set search_path = public as $$
begin
  perform public._apply_due_valuation_changes();
  return (select method from public.valuation_methods order by effective_from desc, id desc limit 1);
end $$;

create or replace function public._lock_balance(p_mat uuid, p_wh uuid, p_loc uuid, p_lot uuid)
returns public.stock_balances
language plpgsql security definer set search_path = public as $$
declare r public.stock_balances;
begin
  insert into public.stock_balances(material_id, warehouse_id, location_id, lot_id)
  values (p_mat, p_wh, p_loc, p_lot)
  on conflict (material_id, warehouse_id, location_id, lot_id) do nothing;
  select * into r from public.stock_balances
   where material_id = p_mat and warehouse_id = p_wh
     and location_id is not distinct from p_loc and lot_id is not distinct from p_lot
   for update;
  return r;
end $$;

create or replace function public._insert_movement(
  p_type public.movement_type, p_mat uuid, p_wh uuid, p_loc uuid, p_lot uuid, p_qty numeric,
  p_balance_after numeric, p_doc uuid, p_line uuid, p_transfer uuid, p_item uuid, p_notes text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.inventory_movements(movement_type, material_id, warehouse_id, location_id, lot_id, qty,
    balance_after, document_id, document_line_id, transfer_id, transfer_item_id, user_id, notes, posting_date)
  values (p_type, p_mat, p_wh, p_loc, p_lot, p_qty, p_balance_after, p_doc, p_line, p_transfer, p_item,
    auth.uid(), p_notes, current_date)
  returning id into v_id;
  return v_id;
end $$;

-- Entrada de costo (promedio y FIFO)
create or replace function public._cost_in(p_mat uuid, p_qty numeric, p_unit_cost numeric, p_movement uuid, p_origin text)
returns void language plpgsql security definer set search_path = public as $$
declare v_method public.valuation_method := public._current_method();
begin
  if p_unit_cost is null or p_unit_cost < 0 then raise exception 'ERP: costo unitario inválido'; end if;
  insert into public.material_costs(material_id) values (p_mat) on conflict do nothing;
  update public.material_costs
     set qty = qty + p_qty, value = value + round(p_qty * p_unit_cost, 4), updated_at = now()
   where material_id = p_mat;
  if v_method = 'fifo' then
    insert into public.cost_layers(material_id, source_movement_id, origin, qty_in, qty_remaining, unit_cost)
    values (p_mat, p_movement, p_origin, p_qty, p_qty, p_unit_cost);
  end if;
  insert into public.movement_costs(movement_id, method, unit_cost, total_cost)
  values (p_movement, v_method, p_unit_cost, round(p_qty * p_unit_cost, 4));
end $$;

-- Salida de costo; devuelve el costo unitario aplicado
create or replace function public._cost_out(p_mat uuid, p_qty numeric, p_movement uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_method public.valuation_method := public._current_method();
  mc public.material_costs;
  v_total numeric := 0; v_rem numeric := p_qty; v_take numeric; l record;
begin
  select * into mc from public.material_costs where material_id = p_mat for update;
  if not found or mc.qty < p_qty then
    raise exception 'ERP: inconsistencia de valoración (cantidad valorizada insuficiente)';
  end if;
  if v_method = 'promedio' then
    v_total := case when mc.qty - p_qty = 0 then mc.value
                    else round(mc.value / mc.qty * p_qty, 4) end;
  else
    for l in select id, qty_remaining, unit_cost from public.cost_layers
              where material_id = p_mat and qty_remaining > 0
              order by received_at, id for update loop
      v_take := least(l.qty_remaining, v_rem);
      update public.cost_layers set qty_remaining = qty_remaining - v_take where id = l.id;
      v_total := v_total + round(v_take * l.unit_cost, 4);
      v_rem := v_rem - v_take;
      exit when v_rem <= 0;
    end loop;
    if v_rem > 0 then raise exception 'ERP: inconsistencia de capas FIFO'; end if;
    if mc.qty - p_qty = 0 then v_total := mc.value; end if;
  end if;
  v_total := least(v_total, mc.value);
  update public.material_costs set qty = qty - p_qty, value = value - v_total, updated_at = now()
   where material_id = p_mat;
  if p_movement is not null then
    insert into public.movement_costs(movement_id, method, unit_cost, total_cost)
    values (p_movement, v_method, round(v_total / p_qty, 6), v_total);
  end if;
  return round(v_total / p_qty, 6);
end $$;

-- Costo unitario vigente (para devoluciones, ajustes positivos y traslados informativos)
create or replace function public._current_unit_cost(p_mat uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v numeric;
begin
  select case when qty > 0 then round(value / qty, 6) end into v from public.material_costs where material_id = p_mat;
  if v is null then
    select mc.unit_cost into v from public.movement_costs mc
      join public.inventory_movements m on m.id = mc.movement_id
     where m.material_id = p_mat order by m.created_at desc limit 1;
  end if;
  return v;
end $$;

-- Asignación FEFO + reserva. FEFO decide QUÉ lote físico sale; el costo lo decide el método de valoración.
create or replace function public._allocate(p_mat uuid, p_wh uuid, p_loc uuid, p_lot uuid, p_qty numeric,
  p_doc uuid, p_line uuid, p_transfer uuid, p_tline uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_rem numeric := p_qty; v_take numeric; b record; v_sku text;
begin
  for b in
    select sb.id, sb.location_id, sb.lot_id, sb.qty_on_hand - sb.qty_reserved as avail
      from public.stock_balances sb
      left join public.lots l on l.id = sb.lot_id
     where sb.material_id = p_mat and sb.warehouse_id = p_wh
       and (p_loc is null or sb.location_id = p_loc)
       and (p_lot is null or sb.lot_id = p_lot)
       and sb.qty_on_hand - sb.qty_reserved > 0
       and (sb.lot_id is null or (l.status = 'disponible' and (l.exp_date is null or l.exp_date >= current_date)))
     order by l.exp_date asc nulls last, l.created_at asc nulls last, sb.id
     for update of sb
  loop
    v_take := least(b.avail, v_rem);
    update public.stock_balances set qty_reserved = qty_reserved + v_take, updated_at = now() where id = b.id;
    insert into public.stock_reservations(balance_id, material_id, warehouse_id, location_id, lot_id, qty,
      document_id, document_line_id, transfer_id, transfer_line_id)
    values (b.id, p_mat, p_wh, b.location_id, b.lot_id, v_take, p_doc, p_line, p_transfer, p_tline);
    v_rem := v_rem - v_take;
    exit when v_rem <= 0;
  end loop;
  if v_rem > 0 then
    select sku into v_sku from public.materials where id = p_mat;
    raise exception 'ERP: existencias disponibles insuficientes para % (faltan % en unidad base). Los lotes vencidos, bloqueados o en cuarentena no se usan.', v_sku, v_rem;
  end if;
end $$;

create or replace function public._release_reservations(p_doc uuid, p_transfer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id, balance_id, qty from public.stock_reservations
            where status = 'activa' and ((p_doc is not null and document_id = p_doc) or (p_transfer is not null and transfer_id = p_transfer))
            order by balance_id for update loop
    update public.stock_balances set qty_reserved = qty_reserved - r.qty, updated_at = now() where id = r.balance_id;
    update public.stock_reservations set status = 'liberada', closed_at = now() where id = r.id;
  end loop;
end $$;

create or replace function public._doc_prefix(t public.doc_type) returns text language sql immutable as $$
  select case t when 'entrada' then 'ENT' when 'devolucion' then 'DEV' when 'salida' then 'SAL' else 'AJU' end
$$;

-- ---------------- Guardar borrador ----------------
create or replace function public.save_inventory_document(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_id uuid := nullif(p->>'id','')::uuid;
  v_type public.doc_type := (p->>'doc_type')::public.doc_type;
  v_wh uuid := (p->>'warehouse_id')::uuid;
  d public.inventory_documents;
  ln jsonb; i int := 0;
  m public.materials;
  v_unit uuid; v_qty numeric; v_base numeric; v_dir smallint; v_loc uuid; v_lot uuid; v_lot_code text;
  v_line uuid; v_cost numeric;
begin
  if v_type is null or v_wh is null then raise exception 'ERP: tipo y almacén son obligatorios'; end if;
  if not public.has_warehouse_access(v_wh) then raise exception 'ERP: sin acceso al almacén' using errcode='42501'; end if;
  if (v_type in ('entrada','devolucion','ajuste') and not public.has_role('admin','supervisor','operador'))
     or (v_type = 'salida' and not public.has_role('admin','supervisor','operador','mantenimiento')) then
    raise exception 'ERP: su rol no puede crear este tipo de documento' using errcode='42501';
  end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    raise exception 'ERP: el documento debe tener al menos una línea';
  end if;

  if v_id is null then
    if nullif(p->>'idempotency_key','') is not null then
      select id into v_id from public.inventory_documents where idempotency_key = (p->>'idempotency_key')::uuid;
      if found then return v_id; end if;
    end if;
    insert into public.inventory_documents(doc_number, doc_type, warehouse_id, supplier_id, work_order_id,
      reference, reason, notes, idempotency_key, created_by)
    values (public._next_number(public._doc_prefix(v_type)), v_type, v_wh, nullif(p->>'supplier_id','')::uuid,
      nullif(p->>'work_order_id','')::uuid, p->>'reference', p->>'reason', p->>'notes',
      nullif(p->>'idempotency_key','')::uuid, v_uid)
    returning id into v_id;
  else
    select * into d from public.inventory_documents where id = v_id for update;
    if not found then raise exception 'ERP: documento no encontrado'; end if;
    -- Borrador: lo edita su creador. Entradas/devoluciones pendientes: las completa (p. ej. con costos)
    -- un supervisor del almacén antes de confirmarlas.
    if not (
      (d.status = 'borrador' and (d.created_by = v_uid or public.is_admin()))
      or (d.status in ('borrador','pendiente') and d.doc_type in ('entrada','devolucion') and public.can_approve_in(d.warehouse_id))
    ) then
      raise exception 'ERP: el documento no se puede editar en su estado actual o no es suyo' using errcode='42501';
    end if;
    if d.doc_type <> v_type or d.warehouse_id <> v_wh then raise exception 'ERP: no se puede cambiar tipo ni almacén'; end if;
    update public.inventory_documents set supplier_id = nullif(p->>'supplier_id','')::uuid,
      work_order_id = nullif(p->>'work_order_id','')::uuid,
      reference = p->>'reference', reason = p->>'reason', notes = p->>'notes'
    where id = v_id;
    delete from public.inventory_document_lines where document_id = v_id;
  end if;

  for ln in select * from jsonb_array_elements(p->'lines') loop
    i := i + 1;
    select * into m from public.materials where id = (ln->>'material_id')::uuid;
    if not found or not m.active then raise exception 'ERP: línea %: material inexistente o inactivo', i; end if;
    v_unit := coalesce(nullif(ln->>'unit_id','')::uuid, m.base_unit_id);
    v_qty := (ln->>'qty')::numeric;
    v_base := public.to_base_qty(m.id, v_unit, v_qty);
    v_dir := coalesce((ln->>'direction')::smallint, 1);
    if v_type <> 'ajuste' and v_dir <> 1 then raise exception 'ERP: línea %: dirección inválida', i; end if;
    v_loc := nullif(ln->>'location_id','')::uuid;
    if v_loc is not null and not exists (select 1 from public.locations where id = v_loc and warehouse_id = v_wh and active) then
      raise exception 'ERP: línea %: la ubicación no pertenece al almacén', i;
    end if;
    v_lot := nullif(ln->>'lot_id','')::uuid;
    v_lot_code := nullif(trim(coalesce(ln->>'lot_code','')),'');
    if v_lot is not null and not exists (select 1 from public.lots where id = v_lot and material_id = m.id) then
      raise exception 'ERP: línea %: el lote no corresponde al material', i;
    end if;
    if v_lot is null and v_lot_code is not null then
      select id into v_lot from public.lots where material_id = m.id and lot_code = v_lot_code;
    end if;
    if (v_type in ('entrada','devolucion') or (v_type = 'ajuste' and v_dir = 1)) and m.lot_controlled then
      if v_lot is null and v_lot_code is null then raise exception 'ERP: línea %: el material % requiere lote', i, m.sku; end if;
      if v_lot is null and m.expiry_controlled and nullif(ln->>'exp_date','') is null then
        raise exception 'ERP: línea %: indique la fecha de vencimiento del lote nuevo', i;
      end if;
    end if;
    if not m.lot_controlled then v_lot := null; v_lot_code := null; end if;

    insert into public.inventory_document_lines(document_id, line_no, material_id, unit_id, qty, qty_base, direction,
      location_id, lot_id, lot_code, mfg_date, exp_date, notes)
    values (v_id, i, m.id, v_unit, v_qty, v_base, v_dir, v_loc, v_lot, v_lot_code,
      nullif(ln->>'mfg_date','')::date, nullif(ln->>'exp_date','')::date, ln->>'notes')
    returning id into v_line;

    v_cost := nullif(ln->>'unit_cost','')::numeric;
    if v_cost is not null then
      if not public.can_view_costs() then raise exception 'ERP: su rol no puede registrar costos' using errcode='42501'; end if;
      if v_cost < 0 then raise exception 'ERP: línea %: costo negativo', i; end if;
      insert into public.document_line_costs(line_id, unit_cost, unit_cost_base)
      values (v_line, v_cost, round(v_cost * v_qty / v_base, 6));
    end if;
  end loop;
  return v_id;
end $$;

-- ---------------- Notificación a aprobadores (tabla en 0007) ----------------
create or replace function public._notify_warehouse(p_wh uuid, p_roles public.app_role[], p_title text, p_body text,
  p_link text, p_kind text, p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications(user_id, title, body, link, kind, dedupe_key)
  select p.id, p_title, p_body, p_link, p_kind, p_key
    from public.profiles p
   where p.active and p.role = any(p_roles)
     and (p.role = 'admin' or p_wh is null or exists (select 1 from public.user_warehouse_access a where a.user_id = p.id and a.warehouse_id = p_wh))
     and p.id is distinct from auth.uid()
  on conflict (user_id, dedupe_key) do nothing;
end $$;

create or replace function public._notify_user(p_user uuid, p_title text, p_body text, p_link text, p_kind text, p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications(user_id, title, body, link, kind, dedupe_key)
  select p_user, p_title, p_body, p_link, p_kind, p_key where p_user is not null and p_user is distinct from auth.uid()
  on conflict (user_id, dedupe_key) do nothing;
end $$;

-- ---------------- Flujo ----------------
create or replace function public.submit_inventory_document(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.inventory_documents; v_uid uuid := public.require_user();
begin
  select * into d from public.inventory_documents where id = p_id for update;
  if not found or not public.has_warehouse_access(d.warehouse_id) then raise exception 'ERP: documento no encontrado'; end if;
  if d.status <> 'borrador' then raise exception 'ERP: el documento no está en borrador'; end if;
  if d.created_by <> v_uid and not public.is_admin() then raise exception 'ERP: solo el creador puede enviarlo' using errcode='42501'; end if;
  update public.inventory_documents set status = 'pendiente', submitted_by = v_uid, submitted_at = now() where id = p_id;
  perform public._notify_warehouse(d.warehouse_id, array['admin','supervisor']::public.app_role[],
    case when d.doc_type in ('salida','ajuste') then 'Aprobación pendiente: ' else 'Confirmación pendiente: ' end || d.doc_number,
    initcap(d.doc_type::text) || ' enviada para revisión', '/inventario/documentos/' || d.id, 'aprobacion', 'doc-sub-' || d.id);
end $$;

create or replace function public.approve_inventory_document(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.inventory_documents; v_uid uuid := public.require_user(); ln record;
begin
  select * into d from public.inventory_documents where id = p_id for update;
  if not found or not public.has_warehouse_access(d.warehouse_id) then raise exception 'ERP: documento no encontrado'; end if;
  if d.doc_type not in ('salida','ajuste') then raise exception 'ERP: este tipo de documento no requiere aprobación'; end if;
  if d.status <> 'pendiente' then raise exception 'ERP: solo se aprueban documentos pendientes (estado actual: %)', d.status; end if;
  if not public.can_approve_in(d.warehouse_id) then raise exception 'ERP: no tiene permiso de aprobación en este almacén' using errcode='42501'; end if;
  if d.created_by = v_uid then raise exception 'ERP: no puede aprobar un documento creado por usted' using errcode='42501'; end if;

  for ln in select * from public.inventory_document_lines
             where document_id = p_id and (d.doc_type = 'salida' or direction = -1) order by line_no loop
    perform public._allocate(ln.material_id, d.warehouse_id, ln.location_id, ln.lot_id, ln.qty_base, p_id, ln.id, null, null);
  end loop;
  update public.inventory_documents set status = 'aprobado', approved_by = v_uid, approved_at = now() where id = p_id;
  perform public._notify_user(d.created_by, 'Aprobado: ' || d.doc_number, 'Listo para confirmar', '/inventario/documentos/' || d.id, 'aprobacion', 'doc-apr-' || d.id);
end $$;

create or replace function public.reject_inventory_document(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.inventory_documents; v_uid uuid := public.require_user();
begin
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'ERP: indique el motivo del rechazo'; end if;
  select * into d from public.inventory_documents where id = p_id for update;
  if not found or not public.has_warehouse_access(d.warehouse_id) then raise exception 'ERP: documento no encontrado'; end if;
  if d.status not in ('pendiente','aprobado') then raise exception 'ERP: estado no permite rechazo'; end if;
  if not public.can_approve_in(d.warehouse_id) then raise exception 'ERP: no tiene permiso de aprobación' using errcode='42501'; end if;
  perform public._release_reservations(p_id, null);
  update public.inventory_documents set status = 'rechazado', rejected_by = v_uid, rejected_at = now(), rejection_reason = p_reason where id = p_id;
  perform public._notify_user(d.created_by, 'Rechazado: ' || d.doc_number, p_reason, '/inventario/documentos/' || d.id, 'aprobacion', 'doc-rej-' || d.id);
end $$;

create or replace function public.cancel_inventory_document(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.inventory_documents; v_uid uuid := public.require_user();
begin
  select * into d from public.inventory_documents where id = p_id for update;
  if not found or not public.has_warehouse_access(d.warehouse_id) then raise exception 'ERP: documento no encontrado'; end if;
  if d.status in ('borrador','pendiente') then
    if d.created_by <> v_uid and not public.can_approve_in(d.warehouse_id) then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
  elsif d.status = 'aprobado' then
    if not public.can_approve_in(d.warehouse_id) then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
  else
    raise exception 'ERP: un documento % no se puede anular; use un ajuste compensatorio', d.status;
  end if;
  perform public._release_reservations(p_id, null);
  update public.inventory_documents set status = 'anulado', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = p_reason where id = p_id;
end $$;

create or replace function public.confirm_inventory_document(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  d public.inventory_documents; v_uid uuid := public.require_user();
  ln record; m public.materials; r record; b public.stock_balances;
  v_lot uuid; v_cost numeric; v_mov uuid; v_after numeric; v_lstatus public.lot_status; v_lexp date;
  v_mtype public.movement_type;
begin
  select * into d from public.inventory_documents where id = p_id for update;
  if not found or not public.has_warehouse_access(d.warehouse_id) then raise exception 'ERP: documento no encontrado'; end if;
  perform public._assert_period_open(current_date);

  if d.doc_type = 'entrada' then
    if d.status not in ('borrador','pendiente') then raise exception 'ERP: la entrada no se puede confirmar en estado %', d.status; end if;
    if not public.has_role('admin','supervisor') then raise exception 'ERP: solo admin o supervisor confirman entradas (requiere costos)' using errcode='42501'; end if;
  elsif d.doc_type = 'devolucion' then
    if d.status not in ('borrador','pendiente') then raise exception 'ERP: estado inválido'; end if;
    if not public.has_role('admin','supervisor','operador') then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
  else
    if d.status <> 'aprobado' then raise exception 'ERP: el documento debe estar aprobado antes de confirmarse'; end if;
    if not public.has_role('admin','supervisor','operador','mantenimiento') then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
    if public.has_role('mantenimiento') and (d.doc_type <> 'salida' or d.work_order_id is null) then
      raise exception 'ERP: mantenimiento solo confirma salidas de órdenes de trabajo' using errcode='42501';
    end if;
  end if;

  -- Entradas, devoluciones y ajustes positivos
  for ln in select l.*, c.unit_cost_base from public.inventory_document_lines l
              left join public.document_line_costs c on c.line_id = l.id
             where l.document_id = p_id and l.direction = 1 and d.doc_type <> 'salida'
             order by l.line_no loop
    select * into m from public.materials where id = ln.material_id;
    v_lot := ln.lot_id;
    if v_lot is null and ln.lot_code is not null then
      insert into public.lots(material_id, lot_code, mfg_date, exp_date, status, supplier_id, created_by)
      values (m.id, ln.lot_code, ln.mfg_date, ln.exp_date,
              case when m.quarantine_on_receipt and d.doc_type = 'entrada' then 'cuarentena'::public.lot_status else 'disponible' end,
              d.supplier_id, v_uid)
      on conflict (material_id, lot_code) do nothing;
      select id into v_lot from public.lots where material_id = m.id and lot_code = ln.lot_code;
    end if;
    if m.lot_controlled and v_lot is null then raise exception 'ERP: línea %: falta lote', ln.line_no; end if;

    if d.doc_type = 'entrada' then
      v_cost := ln.unit_cost_base;
      if v_cost is null then raise exception 'ERP: línea %: falta el costo unitario', ln.line_no; end if;
      v_mtype := 'entrada';
    else
      v_cost := coalesce(ln.unit_cost_base, public._current_unit_cost(m.id));
      if v_cost is null then raise exception 'ERP: línea %: no hay costo de referencia; indique el costo unitario', ln.line_no; end if;
      v_mtype := case when d.doc_type = 'devolucion' then 'devolucion'::public.movement_type else 'ajuste_pos' end;
    end if;

    b := public._lock_balance(m.id, d.warehouse_id, ln.location_id, v_lot);
    update public.stock_balances set qty_on_hand = qty_on_hand + ln.qty_base, updated_at = now()
     where id = b.id returning qty_on_hand into v_after;
    v_mov := public._insert_movement(v_mtype, m.id, d.warehouse_id, ln.location_id, v_lot, ln.qty_base, v_after,
                                     p_id, ln.id, null, null, d.reason);
    perform public._cost_in(m.id, ln.qty_base, v_cost, v_mov,
      case v_mtype when 'entrada' then 'entrada' when 'devolucion' then 'devolucion' else 'ajuste' end);
  end loop;

  -- Salidas y ajustes negativos: consumen sus reservas
  for r in select * from public.stock_reservations where document_id = p_id and status = 'activa' order by balance_id for update loop
    select * into b from public.stock_balances where id = r.balance_id for update;
    if r.lot_id is not null then
      select status, exp_date into v_lstatus, v_lexp from public.lots where id = r.lot_id;
      if v_lstatus <> 'disponible' or (v_lexp is not null and v_lexp < current_date) then
        raise exception 'ERP: un lote reservado ya no está habilitado (estado %, vence %). Anule y genere un nuevo documento.', v_lstatus, v_lexp;
      end if;
    end if;
    update public.stock_balances set qty_on_hand = qty_on_hand - r.qty, qty_reserved = qty_reserved - r.qty, updated_at = now()
     where id = b.id returning qty_on_hand into v_after;
    v_mov := public._insert_movement(case when d.doc_type = 'salida' then 'salida'::public.movement_type else 'ajuste_neg' end,
       r.material_id, r.warehouse_id, r.location_id, r.lot_id, -r.qty, v_after, p_id, r.document_line_id, null, null, d.reason);
    v_cost := public._cost_out(r.material_id, r.qty, v_mov);
    update public.stock_reservations set status = 'consumida', closed_at = now() where id = r.id;
    if d.work_order_id is not null then
      insert into public.work_order_materials(work_order_id, material_id, qty_base, unit_cost, total_cost, movement_id, document_id)
      values (d.work_order_id, r.material_id, r.qty, v_cost, round(v_cost * r.qty, 4), v_mov, p_id);
    end if;
  end loop;

  -- Control: cada línea de salida quedó consumida por completo
  if exists (
    select 1 from public.inventory_document_lines l
     where l.document_id = p_id and (d.doc_type = 'salida' or l.direction = -1)
       and l.qty_base <> coalesce((select sum(qty) from public.stock_reservations s
                                    where s.document_line_id = l.id and s.status = 'consumida'), 0)) then
    raise exception 'ERP: las reservas no cubren las cantidades del documento';
  end if;

  update public.inventory_documents set status = 'confirmado', confirmed_by = v_uid, confirmed_at = now(), posting_date = current_date
   where id = p_id;
end $$;

-- ---------------- Recuentos físicos ----------------
create or replace function public.create_stock_count(p_wh uuid, p_loc uuid, p_notes text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_uid uuid := public.require_user();
begin
  if not public.has_warehouse_access(p_wh) or not public.has_role('admin','supervisor','operador') then
    raise exception 'ERP: no autorizado' using errcode='42501';
  end if;
  if p_loc is not null and not exists (select 1 from public.locations where id = p_loc and warehouse_id = p_wh) then
    raise exception 'ERP: la ubicación no pertenece al almacén';
  end if;
  insert into public.stock_counts(count_number, warehouse_id, location_id, notes, created_by)
  values (public._next_number('REC'), p_wh, p_loc, p_notes, v_uid) returning id into v_id;
  insert into public.stock_count_lines(count_id, material_id, location_id, lot_id, system_qty)
  select v_id, material_id, location_id, lot_id, qty_on_hand from public.stock_balances
   where warehouse_id = p_wh and (p_loc is null or location_id = p_loc) and qty_on_hand > 0;
  return v_id;
end $$;

create or replace function public.save_count_line(p_count uuid, p_material uuid, p_location uuid, p_lot uuid,
  p_counted numeric, p_notes text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.stock_counts; v_uid uuid := public.require_user(); m public.materials; v_sys numeric;
begin
  select * into c from public.stock_counts where id = p_count;
  if not found or not public.has_warehouse_access(c.warehouse_id) or not public.has_role('admin','supervisor','operador') then
    raise exception 'ERP: no autorizado' using errcode='42501';
  end if;
  if c.status <> 'abierto' then raise exception 'ERP: el recuento no está abierto'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'ERP: cantidad contada inválida'; end if;
  select * into m from public.materials where id = p_material;
  if not found then raise exception 'ERP: material no encontrado'; end if;
  if not m.allow_fraction and p_counted <> trunc(p_counted) then raise exception 'ERP: el material no admite fracciones'; end if;
  if m.lot_controlled and p_lot is null then raise exception 'ERP: indique el lote'; end if;
  if p_location is not null and not exists (select 1 from public.locations where id = p_location and warehouse_id = c.warehouse_id) then
    raise exception 'ERP: ubicación inválida';
  end if;
  select qty_on_hand into v_sys from public.stock_balances
   where material_id = p_material and warehouse_id = c.warehouse_id
     and location_id is not distinct from p_location and lot_id is not distinct from p_lot;
  insert into public.stock_count_lines(count_id, material_id, location_id, lot_id, system_qty, counted_qty, counted_by, counted_at, notes)
  values (p_count, p_material, p_location, p_lot, coalesce(v_sys,0), p_counted, v_uid, now(), p_notes)
  on conflict (count_id, material_id, location_id, lot_id)
  do update set counted_qty = excluded.counted_qty, counted_by = excluded.counted_by, counted_at = now(), notes = excluded.notes;
end $$;

create or replace function public.close_stock_count(p_count uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c public.stock_counts; v_uid uuid := public.require_user(); v_doc uuid; l record; i int := 0; v_cur numeric; v_diff numeric; v_pending int;
begin
  select * into c from public.stock_counts where id = p_count for update;
  if not found or not public.has_warehouse_access(c.warehouse_id) or not public.has_role('admin','supervisor') then
    raise exception 'ERP: no autorizado' using errcode='42501';
  end if;
  if c.status <> 'abierto' then raise exception 'ERP: el recuento no está abierto'; end if;
  select count(*) into v_pending from public.stock_count_lines where count_id = p_count and counted_qty is null;
  if v_pending > 0 then raise exception 'ERP: hay % líneas sin contar', v_pending; end if;

  for l in select cl.*, m.base_unit_id from public.stock_count_lines cl join public.materials m on m.id = cl.material_id
            where cl.count_id = p_count order by m.sku loop
    select coalesce(qty_on_hand,0) into v_cur from public.stock_balances
     where material_id = l.material_id and warehouse_id = c.warehouse_id
       and location_id is not distinct from l.location_id and lot_id is not distinct from l.lot_id;
    v_diff := l.counted_qty - coalesce(v_cur,0);
    if v_diff <> 0 then
      if v_doc is null then
        insert into public.inventory_documents(doc_number, doc_type, status, warehouse_id, stock_count_id, reason, created_by, submitted_by, submitted_at)
        values (public._next_number('AJU'), 'ajuste', 'pendiente', c.warehouse_id, p_count,
                'Diferencias del recuento ' || c.count_number, v_uid, v_uid, now())
        returning id into v_doc;
      end if;
      i := i + 1;
      insert into public.inventory_document_lines(document_id, line_no, material_id, unit_id, qty, qty_base, direction, location_id, lot_id, notes)
      values (v_doc, i, l.material_id, l.base_unit_id, abs(v_diff), abs(v_diff), sign(v_diff)::smallint, l.location_id, l.lot_id,
              'Sistema ' || coalesce(v_cur,0) || ' / contado ' || l.counted_qty);
    end if;
  end loop;
  update public.stock_counts set status = 'cerrado', closed_by = v_uid, closed_at = now(), adjustment_document_id = v_doc where id = p_count;
  if v_doc is not null then
    perform public._notify_warehouse(c.warehouse_id, array['admin','supervisor']::public.app_role[],
      'Ajuste por recuento pendiente', c.count_number, '/inventario/documentos/' || v_doc, 'aprobacion', 'doc-sub-' || v_doc);
  end if;
  return v_doc;
end $$;

create or replace function public.cancel_stock_count(p_count uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.stock_counts;
begin
  perform public.require_user();
  select * into c from public.stock_counts where id = p_count for update;
  if not found or not public.can_approve_in(c.warehouse_id) then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
  if c.status <> 'abierto' then raise exception 'ERP: el recuento no está abierto'; end if;
  update public.stock_counts set status = 'anulado', closed_by = auth.uid(), closed_at = now() where id = p_count;
end $$;

-- ---------------- Períodos ----------------
create or replace function public.close_period(p_period date) returns void
language plpgsql security definer set search_path = public as $$
declare v date := date_trunc('month', p_period)::date;
begin
  perform public.require_user();
  if not public.is_admin() then raise exception 'ERP: solo administradores' using errcode='42501'; end if;
  if v >= date_trunc('month', current_date)::date then raise exception 'ERP: solo se cierran meses ya terminados'; end if;
  insert into public.accounting_periods(period, status, closed_by, closed_at) values (v, 'cerrado', auth.uid(), now())
  on conflict (period) do update set status = 'cerrado', closed_by = auth.uid(), closed_at = now();
end $$;

create or replace function public.reopen_period(p_period date, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_user();
  if not public.is_admin() then raise exception 'ERP: solo administradores' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,''))) < 10 then raise exception 'ERP: justifique la reapertura (mín. 10 caracteres)'; end if;
  update public.accounting_periods set status = 'abierto', notes = p_reason where period = date_trunc('month', p_period)::date;
  perform public.log_audit('reopen_period', 'accounting_periods', p_period::text, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------- Cambio de método de valoración ----------------
create or replace function public._apply_due_valuation_changes() returns void
language plpgsql security definer set search_path = public as $$
declare req record; v_from public.valuation_method; mc record; v_unit numeric;
begin
  for req in select * from public.valuation_change_requests
              where status = 'aprobada' and effective_date <= current_date
              order by effective_date, requested_at for update loop
    select method into v_from from public.valuation_methods order by effective_from desc, id desc limit 1;
    if v_from <> req.to_method then
      for mc in select * from public.material_costs order by material_id for update loop
        v_unit := case when mc.qty > 0 then round(mc.value / mc.qty, 6) end;
        update public.cost_layers set qty_remaining = 0, closed_reason = 'cambio_metodo ' || req.id
         where material_id = mc.material_id and qty_remaining > 0;
        if req.to_method = 'fifo' and mc.qty > 0 then
          insert into public.cost_layers(material_id, origin, qty_in, qty_remaining, unit_cost)
          values (mc.material_id, 'cambio_metodo', mc.qty, mc.qty, v_unit);
        end if;
        insert into public.valuation_change_snapshots(request_id, material_id, method_from, method_to, qty, value_before, value_after, unit_cost_after)
        values (req.id, mc.material_id, v_from, req.to_method, mc.qty, mc.value, mc.value, v_unit);
      end loop;
      insert into public.valuation_methods(method, effective_from, requested_by, approved_by, request_id)
      values (req.to_method, now(), req.requested_by, req.decided_by, req.id);
    end if;
    update public.valuation_change_requests set status = 'aplicada', applied_at = now() where id = req.id;
    perform public.log_audit('valuation_change_applied', 'valuation_change_requests', req.id::text,
      jsonb_build_object('from', v_from, 'to', req.to_method));
  end loop;
end $$;

create or replace function public.request_valuation_change(p_to public.valuation_method, p_effective date, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.require_user();
  if not public.is_admin() then raise exception 'ERP: solo administradores' using errcode='42501'; end if;
  if p_effective < current_date then raise exception 'ERP: la fecha de vigencia no puede ser pasada'; end if;
  if p_to = (select method from public.valuation_methods order by effective_from desc, id desc limit 1) then
    raise exception 'ERP: ese ya es el método activo';
  end if;
  if exists (select 1 from public.valuation_change_requests where status in ('pendiente','aprobada')) then
    raise exception 'ERP: ya existe una solicitud de cambio en curso';
  end if;
  insert into public.valuation_change_requests(to_method, effective_date, reason, requested_by)
  values (p_to, p_effective, p_reason, auth.uid()) returning id into v_id;
  perform public._notify_warehouse(null, array['admin']::public.app_role[], 'Solicitud de cambio de método de valoración',
    'Requiere aprobación de otro administrador', '/configuracion', 'aprobacion', 'vcr-' || v_id);
  return v_id;
end $$;

create or replace function public.decide_valuation_change(p_id uuid, p_approve boolean, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.valuation_change_requests;
begin
  perform public.require_user();
  if not public.is_admin() then raise exception 'ERP: solo administradores' using errcode='42501'; end if;
  select * into r from public.valuation_change_requests where id = p_id for update;
  if not found or r.status <> 'pendiente' then raise exception 'ERP: solicitud no pendiente'; end if;
  if r.requested_by = auth.uid() then raise exception 'ERP: otro administrador debe decidir esta solicitud' using errcode='42501'; end if;
  update public.valuation_change_requests
     set status = case when p_approve then 'aprobada' else 'rechazada' end,
         decided_by = auth.uid(), decided_at = now(), decision_notes = p_notes
   where id = p_id;
  if p_approve then perform public._apply_due_valuation_changes(); end if;
end $$;

create or replace function public.cancel_valuation_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_user();
  if not public.is_admin() then raise exception 'ERP: solo administradores' using errcode='42501'; end if;
  update public.valuation_change_requests set status = 'anulada' where id = p_id and status in ('pendiente','aprobada');
  if not found then raise exception 'ERP: la solicitud no se puede anular'; end if;
end $$;
