-- =====================================================================
-- ERP INDUSTRIAL · 0005 · Traslados entre almacenes
-- Flujo: borrador → pendiente → aprobado (reserva en origen) → preparado
--        → en_transito (sale del origen) → recibido_parcial / recibido / con_diferencias → cerrado
-- =====================================================================
create type public.transfer_status as enum
  ('borrador','pendiente','aprobado','preparado','en_transito','recibido_parcial','recibido','con_diferencias','cerrado','rechazado','anulado');

create table public.warehouse_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_number text not null unique,
  origin_warehouse_id uuid not null references public.warehouses(id),
  dest_warehouse_id uuid not null references public.warehouses(id),
  status public.transfer_status not null default 'borrador',
  notes text,
  carrier text,
  vehicle text,
  idempotency_key uuid unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  approved_by uuid references public.profiles(id), approved_at timestamptz,
  prepared_by uuid references public.profiles(id), prepared_at timestamptz,
  dispatched_by uuid references public.profiles(id), dispatched_at timestamptz,
  received_by uuid references public.profiles(id), received_at timestamptz,
  differences_declared_by uuid references public.profiles(id), differences_declared_at timestamptz,
  differences_approved_by uuid references public.profiles(id), differences_approved_at timestamptz, differences_notes text,
  closed_by uuid references public.profiles(id), closed_at timestamptz,
  rejected_by uuid references public.profiles(id), rejection_reason text,
  check (origin_warehouse_id <> dest_warehouse_id),
  check (approved_by is null or approved_by <> created_by),
  check (differences_approved_by is null or (differences_approved_by <> coalesce(received_by, '00000000-0000-0000-0000-000000000000')
                                             and differences_approved_by <> coalesce(differences_declared_by, '00000000-0000-0000-0000-000000000000')))
);
create index on public.warehouse_transfers(origin_warehouse_id, status);
create index on public.warehouse_transfers(dest_warehouse_id, status);

create table public.warehouse_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.warehouse_transfers(id) on delete cascade,
  line_no int not null,
  material_id uuid not null references public.materials(id),
  unit_id uuid not null references public.units_of_measure(id),
  qty numeric(18,6) not null check (qty > 0),
  qty_base numeric(18,6) not null check (qty_base > 0),
  origin_location_id uuid references public.locations(id),
  lot_id uuid references public.lots(id),
  notes text,
  unique (transfer_id, line_no)
);

-- Ítems físicos por lote/ubicación (generados por la asignación FEFO al aprobar)
create table public.warehouse_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.warehouse_transfers(id) on delete cascade,
  transfer_line_id uuid not null references public.warehouse_transfer_lines(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  lot_id uuid references public.lots(id),
  origin_location_id uuid references public.locations(id),
  dest_location_id uuid references public.locations(id),
  reservation_id uuid references public.stock_reservations(id),
  qty_planned numeric(18,6) not null check (qty_planned > 0),
  qty_prepared numeric(18,6) check (qty_prepared >= 0 and qty_prepared <= qty_planned),
  qty_shipped numeric(18,6) not null default 0 check (qty_shipped >= 0),
  qty_received numeric(18,6) not null default 0 check (qty_received >= 0),
  qty_damaged numeric(18,6) not null default 0 check (qty_damaged >= 0),
  qty_missing numeric(18,6) not null default 0 check (qty_missing >= 0),
  receive_notes text,
  check (qty_received + qty_damaged + qty_missing <= qty_shipped)
);
create index on public.warehouse_transfer_items(transfer_id);

alter table public.stock_reservations
  add constraint res_transfer_fk foreign key (transfer_id) references public.warehouse_transfers(id),
  add constraint res_tline_fk foreign key (transfer_line_id) references public.warehouse_transfer_lines(id);
alter table public.inventory_movements
  add constraint mov_transfer_fk foreign key (transfer_id) references public.warehouse_transfers(id),
  add constraint mov_titem_fk foreign key (transfer_item_id) references public.warehouse_transfer_items(id);

create trigger transfers_audit after insert or update on public.warehouse_transfers for each row execute function public.audit_trigger();
create trigger titems_audit after update on public.warehouse_transfer_items for each row execute function public.audit_trigger();

alter table public.warehouse_transfers enable row level security;
alter table public.warehouse_transfer_lines enable row level security;
alter table public.warehouse_transfer_items enable row level security;

create policy tr_read on public.warehouse_transfers for select to authenticated
  using (public.has_warehouse_access(origin_warehouse_id) or public.has_warehouse_access(dest_warehouse_id));
create policy trl_read on public.warehouse_transfer_lines for select to authenticated
  using (exists (select 1 from public.warehouse_transfers t where t.id = transfer_id
     and (public.has_warehouse_access(t.origin_warehouse_id) or public.has_warehouse_access(t.dest_warehouse_id))));
create policy tri_read on public.warehouse_transfer_items for select to authenticated
  using (exists (select 1 from public.warehouse_transfers t where t.id = transfer_id
     and (public.has_warehouse_access(t.origin_warehouse_id) or public.has_warehouse_access(t.dest_warehouse_id))));

-- ---------------- Funciones ----------------
create or replace function public.save_transfer(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user(); v_id uuid := nullif(p->>'id','')::uuid;
  v_o uuid := (p->>'origin_warehouse_id')::uuid; v_d uuid := (p->>'dest_warehouse_id')::uuid;
  t public.warehouse_transfers; ln jsonb; i int := 0; m public.materials; v_unit uuid; v_loc uuid; v_lot uuid;
begin
  if not public.has_role('admin','supervisor','operador') then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
  if v_o is null or v_d is null or v_o = v_d then raise exception 'ERP: indique almacenes de origen y destino distintos'; end if;
  if not public.has_warehouse_access(v_o) then raise exception 'ERP: sin acceso al almacén de origen' using errcode='42501'; end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then raise exception 'ERP: agregue al menos una línea'; end if;

  if v_id is null then
    if nullif(p->>'idempotency_key','') is not null then
      select id into v_id from public.warehouse_transfers where idempotency_key = (p->>'idempotency_key')::uuid;
      if found then return v_id; end if;
    end if;
    insert into public.warehouse_transfers(transfer_number, origin_warehouse_id, dest_warehouse_id, notes, carrier, vehicle, idempotency_key, created_by)
    values (public._next_number('TRA'), v_o, v_d, p->>'notes', p->>'carrier', p->>'vehicle', nullif(p->>'idempotency_key','')::uuid, v_uid)
    returning id into v_id;
  else
    select * into t from public.warehouse_transfers where id = v_id for update;
    if not found or t.status <> 'borrador' then raise exception 'ERP: solo se editan traslados en borrador'; end if;
    if t.created_by <> v_uid and not public.is_admin() then raise exception 'ERP: solo el creador puede editar' using errcode='42501'; end if;
    update public.warehouse_transfers set origin_warehouse_id = v_o, dest_warehouse_id = v_d, notes = p->>'notes',
      carrier = p->>'carrier', vehicle = p->>'vehicle' where id = v_id;
    delete from public.warehouse_transfer_lines where transfer_id = v_id;
  end if;

  for ln in select * from jsonb_array_elements(p->'lines') loop
    i := i + 1;
    select * into m from public.materials where id = (ln->>'material_id')::uuid and active;
    if not found then raise exception 'ERP: línea %: material inválido', i; end if;
    v_unit := coalesce(nullif(ln->>'unit_id','')::uuid, m.base_unit_id);
    v_loc := nullif(ln->>'origin_location_id','')::uuid;
    v_lot := nullif(ln->>'lot_id','')::uuid;
    if v_loc is not null and not exists (select 1 from public.locations where id = v_loc and warehouse_id = v_o) then
      raise exception 'ERP: línea %: ubicación de origen inválida', i;
    end if;
    if v_lot is not null and not exists (select 1 from public.lots where id = v_lot and material_id = m.id) then
      raise exception 'ERP: línea %: lote inválido', i;
    end if;
    insert into public.warehouse_transfer_lines(transfer_id, line_no, material_id, unit_id, qty, qty_base, origin_location_id, lot_id, notes)
    values (v_id, i, m.id, v_unit, (ln->>'qty')::numeric, public.to_base_qty(m.id, v_unit, (ln->>'qty')::numeric), v_loc, v_lot, ln->>'notes');
  end loop;
  return v_id;
end $$;

create or replace function public.transfer_action(p_id uuid, p_action text, p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user(); t public.warehouse_transfers; ln record; it record; r record; b public.stock_balances;
  v_after numeric; v_mov uuid; v_cost numeric; x jsonb; v_rec numeric; v_dmg numeric; v_dest_loc uuid;
  v_pending numeric; v_issues numeric; v_reason text := p_payload->>'reason';
begin
  select * into t from public.warehouse_transfers where id = p_id for update;
  if not found or not (public.has_warehouse_access(t.origin_warehouse_id) or public.has_warehouse_access(t.dest_warehouse_id)) then
    raise exception 'ERP: traslado no encontrado';
  end if;

  if p_action = 'submit' then
    if t.status <> 'borrador' then raise exception 'ERP: el traslado no está en borrador'; end if;
    if t.created_by <> v_uid and not public.is_admin() then raise exception 'ERP: solo el creador puede enviarlo' using errcode='42501'; end if;
    update public.warehouse_transfers set status = 'pendiente', submitted_at = now() where id = p_id;
    perform public._notify_warehouse(t.origin_warehouse_id, array['admin','supervisor']::public.app_role[],
      'Traslado por aprobar: ' || t.transfer_number, null, '/traslados/' || p_id, 'aprobacion', 'tr-sub-' || p_id);

  elsif p_action = 'approve' then
    if t.status <> 'pendiente' then raise exception 'ERP: solo se aprueban traslados pendientes'; end if;
    if not public.can_approve_in(t.origin_warehouse_id) then raise exception 'ERP: no tiene permiso de aprobación en el origen' using errcode='42501'; end if;
    if t.created_by = v_uid then raise exception 'ERP: no puede aprobar un traslado creado por usted' using errcode='42501'; end if;
    for ln in select * from public.warehouse_transfer_lines where transfer_id = p_id order by line_no loop
      perform public._allocate(ln.material_id, t.origin_warehouse_id, ln.origin_location_id, ln.lot_id, ln.qty_base, null, null, p_id, ln.id);
    end loop;
    insert into public.warehouse_transfer_items(transfer_id, transfer_line_id, material_id, lot_id, origin_location_id, reservation_id, qty_planned)
    select p_id, s.transfer_line_id, s.material_id, s.lot_id, s.location_id, s.id, s.qty
      from public.stock_reservations s where s.transfer_id = p_id and s.status = 'activa';
    update public.warehouse_transfers set status = 'aprobado', approved_by = v_uid, approved_at = now() where id = p_id;
    perform public._notify_user(t.created_by, 'Traslado aprobado: ' || t.transfer_number, 'Puede prepararse', '/traslados/' || p_id, 'aprobacion', 'tr-apr-' || p_id);

  elsif p_action in ('reject','cancel') then
    if p_action = 'reject' then
      if t.status not in ('pendiente','aprobado','preparado') then raise exception 'ERP: estado no permite rechazo'; end if;
      if not public.can_approve_in(t.origin_warehouse_id) then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
    else
      if t.status in ('borrador','pendiente') then
        if t.created_by <> v_uid and not public.can_approve_in(t.origin_warehouse_id) then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
      elsif t.status in ('aprobado','preparado') then
        if not public.can_approve_in(t.origin_warehouse_id) then raise exception 'ERP: no autorizado' using errcode='42501'; end if;
      else raise exception 'ERP: un traslado despachado no se anula; registre diferencias y ciérrelo'; end if;
    end if;
    perform public._release_reservations(null, p_id);
    update public.warehouse_transfers set status = case when p_action = 'reject' then 'rechazado'::public.transfer_status else 'anulado' end,
      rejected_by = v_uid, rejection_reason = v_reason where id = p_id;

  elsif p_action = 'prepare' then
    -- payload: {items:[{item_id, qty_prepared}]}  (si se omite un ítem, se prepara lo planificado)
    if t.status <> 'aprobado' then raise exception 'ERP: el traslado debe estar aprobado'; end if;
    if not (public.has_warehouse_access(t.origin_warehouse_id) and public.has_role('admin','supervisor','operador')) then
      raise exception 'ERP: no autorizado en el origen' using errcode='42501';
    end if;
    update public.warehouse_transfer_items set qty_prepared = qty_planned where transfer_id = p_id;
    for x in select * from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb)) loop
      update public.warehouse_transfer_items set qty_prepared = (x->>'qty_prepared')::numeric
       where id = (x->>'item_id')::uuid and transfer_id = p_id;
    end loop;
    if not exists (select 1 from public.warehouse_transfer_items where transfer_id = p_id and qty_prepared > 0) then
      raise exception 'ERP: no hay cantidades preparadas';
    end if;
    update public.warehouse_transfers set status = 'preparado', prepared_by = v_uid, prepared_at = now() where id = p_id;

  elsif p_action = 'dispatch' then
    -- Despacho autorizado: supervisor/admin del origen
    if t.status <> 'preparado' then raise exception 'ERP: el traslado debe estar preparado'; end if;
    if not public.can_approve_in(t.origin_warehouse_id) then raise exception 'ERP: el despacho lo autoriza un supervisor del origen' using errcode='42501'; end if;
    perform public._assert_period_open(current_date);
    for it in select i.*, s.balance_id, s.qty as res_qty from public.warehouse_transfer_items i
                join public.stock_reservations s on s.id = i.reservation_id
               where i.transfer_id = p_id order by s.balance_id loop
      select * into b from public.stock_balances where id = it.balance_id for update;
      update public.stock_balances
         set qty_reserved = qty_reserved - it.res_qty, qty_on_hand = qty_on_hand - it.qty_prepared, updated_at = now()
       where id = b.id returning qty_on_hand into v_after;
      update public.stock_reservations set status = 'consumida', closed_at = now() where id = it.reservation_id;
      if it.qty_prepared > 0 then
        v_mov := public._insert_movement('traslado_salida', it.material_id, t.origin_warehouse_id, it.origin_location_id, it.lot_id,
                   -it.qty_prepared, v_after, null, null, p_id, it.id, 'Traslado ' || t.transfer_number);
        v_cost := coalesce(public._current_unit_cost(it.material_id), 0);
        insert into public.movement_costs(movement_id, method, unit_cost, total_cost)
        values (v_mov, (select method from public.valuation_methods order by effective_from desc, id desc limit 1), v_cost, round(v_cost * it.qty_prepared, 4));
        update public.warehouse_transfer_items set qty_shipped = it.qty_prepared where id = it.id;
      end if;
    end loop;
    update public.warehouse_transfers set status = 'en_transito', dispatched_by = v_uid, dispatched_at = now() where id = p_id;
    perform public._notify_warehouse(t.dest_warehouse_id, array['admin','supervisor','operador']::public.app_role[],
      'Traslado en camino: ' || t.transfer_number, 'Registre la recepción al llegar', '/traslados/' || p_id, 'traslado', 'tr-dis-' || p_id);

  elsif p_action = 'receive' then
    -- payload: {items:[{item_id, qty_received, qty_damaged, dest_location_id, notes}]}  (cantidades incrementales)
    if t.status not in ('en_transito','recibido_parcial') then raise exception 'ERP: el traslado no está en tránsito'; end if;
    if not (public.has_warehouse_access(t.dest_warehouse_id) and public.has_role('admin','supervisor','operador')) then
      raise exception 'ERP: no autorizado en el destino' using errcode='42501';
    end if;
    perform public._assert_period_open(current_date);
    for x in select * from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb)) loop
      select * into it from public.warehouse_transfer_items where id = (x->>'item_id')::uuid and transfer_id = p_id for update;
      if not found then raise exception 'ERP: ítem inválido'; end if;
      v_rec := coalesce((x->>'qty_received')::numeric, 0);
      v_dmg := coalesce((x->>'qty_damaged')::numeric, 0);
      if v_rec < 0 or v_dmg < 0 then raise exception 'ERP: cantidades negativas'; end if;
      if it.qty_received + it.qty_damaged + it.qty_missing + v_rec + v_dmg > it.qty_shipped then
        raise exception 'ERP: lo recibido supera lo despachado';
      end if;
      v_dest_loc := coalesce(nullif(x->>'dest_location_id','')::uuid, it.dest_location_id);
      if v_dest_loc is not null and not exists (select 1 from public.locations where id = v_dest_loc and warehouse_id = t.dest_warehouse_id) then
        raise exception 'ERP: ubicación de destino inválida';
      end if;
      if v_rec > 0 then
        b := public._lock_balance(it.material_id, t.dest_warehouse_id, v_dest_loc, it.lot_id);
        update public.stock_balances set qty_on_hand = qty_on_hand + v_rec, updated_at = now() where id = b.id returning qty_on_hand into v_after;
        v_mov := public._insert_movement('traslado_entrada', it.material_id, t.dest_warehouse_id, v_dest_loc, it.lot_id,
                   v_rec, v_after, null, null, p_id, it.id, 'Traslado ' || t.transfer_number);
        v_cost := coalesce(public._current_unit_cost(it.material_id), 0);
        insert into public.movement_costs(movement_id, method, unit_cost, total_cost)
        values (v_mov, (select method from public.valuation_methods order by effective_from desc, id desc limit 1), v_cost, round(v_cost * v_rec, 4));
      end if;
      update public.warehouse_transfer_items
         set qty_received = qty_received + v_rec, qty_damaged = qty_damaged + v_dmg, dest_location_id = v_dest_loc,
             receive_notes = coalesce(x->>'notes', receive_notes)
       where id = it.id;
    end loop;
    select sum(qty_shipped - qty_received - qty_damaged - qty_missing), sum(qty_damaged)
      into v_pending, v_issues from public.warehouse_transfer_items where transfer_id = p_id;
    update public.warehouse_transfers
       set status = case when v_pending > 0 then 'recibido_parcial'::public.transfer_status
                         when v_issues > 0 then 'con_diferencias' else 'recibido' end,
           received_by = v_uid, received_at = now(),
           differences_declared_by = case when v_pending = 0 and v_issues > 0 then v_uid else differences_declared_by end,
           differences_declared_at = case when v_pending = 0 and v_issues > 0 then now() else differences_declared_at end
     where id = p_id;

  elsif p_action = 'declare_differences' then
    -- Lo no recibido pasa a faltante; requiere aprobación
    if t.status not in ('recibido_parcial','en_transito') then raise exception 'ERP: estado inválido para declarar diferencias'; end if;
    if not (public.has_warehouse_access(t.dest_warehouse_id) and public.has_role('admin','supervisor','operador')) then
      raise exception 'ERP: no autorizado' using errcode='42501';
    end if;
    if length(trim(coalesce(v_reason,''))) < 3 then raise exception 'ERP: describa las diferencias'; end if;
    update public.warehouse_transfer_items set qty_missing = qty_shipped - qty_received - qty_damaged where transfer_id = p_id;
    update public.warehouse_transfers set status = 'con_diferencias', differences_declared_by = v_uid,
      differences_declared_at = now(), differences_notes = v_reason where id = p_id;
    perform public._notify_warehouse(t.dest_warehouse_id, array['admin','supervisor']::public.app_role[],
      'Diferencias en traslado ' || t.transfer_number, v_reason, '/traslados/' || p_id, 'aprobacion', 'tr-dif-' || p_id);

  elsif p_action = 'approve_differences' then
    if t.status <> 'con_diferencias' then raise exception 'ERP: el traslado no tiene diferencias pendientes'; end if;
    if not public.can_approve_in(t.dest_warehouse_id) then raise exception 'ERP: no tiene permiso de aprobación en el destino' using errcode='42501'; end if;
    if v_uid = t.received_by or v_uid = t.differences_declared_by then
      raise exception 'ERP: otra persona debe aprobar las diferencias' using errcode='42501';
    end if;
    perform public._assert_period_open(current_date);
    for it in select * from public.warehouse_transfer_items where transfer_id = p_id and qty_damaged + qty_missing > 0 for update loop
      v_mov := public._insert_movement('traslado_baja', it.material_id, t.dest_warehouse_id, null, it.lot_id,
                 -(it.qty_damaged + it.qty_missing), null, null, null, p_id, it.id,
                 'Baja por diferencias (dañado ' || it.qty_damaged || ', faltante ' || it.qty_missing || ')');
      perform public._cost_out(it.material_id, it.qty_damaged + it.qty_missing, v_mov);
    end loop;
    update public.warehouse_transfers set status = 'cerrado', differences_approved_by = v_uid, differences_approved_at = now(),
      differences_notes = coalesce(v_reason, differences_notes), closed_by = v_uid, closed_at = now() where id = p_id;

  elsif p_action = 'close' then
    if t.status <> 'recibido' then raise exception 'ERP: solo se cierran traslados recibidos completamente'; end if;
    if not (public.has_warehouse_access(t.dest_warehouse_id) and public.has_role('admin','supervisor','operador')) then
      raise exception 'ERP: no autorizado' using errcode='42501';
    end if;
    update public.warehouse_transfers set status = 'cerrado', closed_by = v_uid, closed_at = now() where id = p_id;
  else
    raise exception 'ERP: acción desconocida %', p_action;
  end if;
end $$;
