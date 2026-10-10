-- =====================================================================
-- ERP INDUSTRIAL · 0007 · Calidad, ambiente, limpieza, incidencias, notificaciones
-- =====================================================================
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text,
  link text,
  kind text not null default 'info',
  dedupe_key text not null default gen_random_uuid()::text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index on public.notifications(user_id, read_at, created_at desc);
alter table public.notifications enable row level security;
create policy notif_read on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notif_upd on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ---------- Incidencias ----------
create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  incident_number text not null unique,
  title text not null,
  description text,
  severity text not null default 'media' check (severity in ('baja','media','alta','critica')),
  status text not null default 'abierta' check (status in ('abierta','en_proceso','cerrada')),
  source_type text not null default 'manual' check (source_type in ('manual','medicion','limpieza','inventario','traslado','mantenimiento','inspeccion')),
  source_id uuid,
  warehouse_id uuid references public.warehouses(id),
  location_id uuid references public.locations(id),
  material_id uuid references public.materials(id),
  lot_id uuid references public.lots(id),
  asset_id uuid references public.assets(id),
  reported_by uuid references public.profiles(id) default auth.uid(),
  reported_at timestamptz not null default now(),
  root_cause text,
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  closing_notes text
);
create index on public.incidents(status, warehouse_id);

create table public.corrective_actions (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id),
  description text not null,
  responsible_id uuid references public.profiles(id),
  due_date date,
  status text not null default 'pendiente' check (status in ('pendiente','en_proceso','completada','verificada')),
  completed_at timestamptz,
  verified_by uuid references public.profiles(id),
  notes text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (verified_by is null or verified_by <> responsible_id)
);

create table public.record_notes (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('material','lot','asset','work_order','incident','inventory_document','transfer','stock_count','cleaning_task','measurement')),
  entity_id uuid not null,
  note text not null check (length(trim(note)) > 0),
  created_by uuid not null references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.record_notes(entity_type, entity_id);
create trigger notes_immutable before update or delete on public.record_notes for each row execute function public.forbid_modification();

-- ---------- Mediciones ambientales ----------
create table public.environmental_limits (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.locations(id),
  parameter text not null default 'temperatura',
  unit text not null default '°C',
  min_value numeric(10,3),
  max_value numeric(10,3),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (min_value is not null or max_value is not null),
  check (min_value is null or max_value is null or min_value < max_value),
  unique nulls not distinct (warehouse_id, location_id, parameter)
);

create table public.temperature_logs (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.locations(id),
  parameter text not null default 'temperatura',
  value numeric(10,3) not null,
  unit text not null default '°C',
  measured_at timestamptz not null default now(),
  recorded_by uuid not null references public.profiles(id) default auth.uid(),
  limit_min numeric(10,3),
  limit_max numeric(10,3),
  out_of_range boolean not null default false,
  incident_id uuid references public.incidents(id),
  notes text,
  created_at timestamptz not null default now()
);
create index on public.temperature_logs(warehouse_id, measured_at desc);

create or replace function public.temperature_log_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim public.environmental_limits;
begin
  new.recorded_by := auth.uid();
  if new.measured_at > now() + interval '5 minutes' then raise exception 'ERP: la fecha de medición no puede ser futura'; end if;
  if new.location_id is not null and not exists (select 1 from public.locations where id = new.location_id and warehouse_id = new.warehouse_id) then
    raise exception 'ERP: ubicación inválida';
  end if;
  select * into lim from public.environmental_limits
   where warehouse_id = new.warehouse_id and parameter = new.parameter and active
     and (location_id = new.location_id or location_id is null)
   order by location_id nulls last limit 1;
  if found then
    new.limit_min := lim.min_value; new.limit_max := lim.max_value; new.unit := lim.unit;
    new.out_of_range := (lim.min_value is not null and new.value < lim.min_value) or (lim.max_value is not null and new.value > lim.max_value);
  end if;
  new.incident_id := null;
  return new;
end $$;
create trigger temperature_before before insert on public.temperature_logs for each row execute function public.temperature_log_before();

create or replace function public.temperature_log_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_inc uuid;
begin
  if new.out_of_range then
    insert into public.incidents(incident_number, title, description, severity, source_type, source_id, warehouse_id, location_id, reported_by)
    values (public._next_number('INC'), 'Medición fuera de rango: ' || new.parameter || ' ' || new.value || ' ' || new.unit,
            'Límites: ' || coalesce(new.limit_min::text,'—') || ' a ' || coalesce(new.limit_max::text,'—'),
            'alta', 'medicion', new.id, new.warehouse_id, new.location_id, new.recorded_by)
    returning id into v_inc;
    update public.temperature_logs set incident_id = v_inc where id = new.id;
    perform public._notify_warehouse(new.warehouse_id, array['admin','supervisor','calidad']::public.app_role[],
      'Alerta: ' || new.parameter || ' fuera de rango (' || new.value || ' ' || new.unit || ')',
      'Se abrió una incidencia', '/calidad/incidencias/' || v_inc, 'alerta', 'meas-' || new.id);
  end if;
  return null;
end $$;
create trigger temperature_after after insert on public.temperature_logs for each row execute function public.temperature_log_after();

-- Las mediciones son inmutables salvo el enlace a incidencia que pone el trigger
create or replace function public.temperature_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.value <> old.value or new.measured_at <> old.measured_at or new.warehouse_id <> old.warehouse_id then
    raise exception 'ERP: las mediciones no se modifican; registre una nota o una nueva medición';
  end if;
  return new;
end $$;
create trigger temperature_guard before update or delete on public.temperature_logs for each row execute function public.temperature_guard();

-- ---------- Limpieza ----------
create table public.cleaning_plans (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.locations(id),
  name text not null,
  frequency_days int not null check (frequency_days > 0),
  checklist text[] not null default '{}' check (cardinality(checklist) > 0),
  responsible_id uuid references public.profiles(id),
  next_due date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.cleaning_tasks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.cleaning_plans(id),
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.locations(id),
  due_date date not null,
  status text not null default 'pendiente' check (status in ('pendiente','completada','incumplida')),
  completed_by uuid references public.profiles(id),
  completed_at timestamptz,
  notes text,
  incident_id uuid references public.incidents(id),
  created_at timestamptz not null default now(),
  unique (plan_id, due_date)
);

create table public.cleaning_task_checks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.cleaning_tasks(id),
  item text not null,
  ok boolean not null,
  notes text,
  checked_by uuid references public.profiles(id),
  checked_at timestamptz not null default now()
);

-- ---------- Auditoría ----------
create trigger incidents_audit after insert or update on public.incidents for each row execute function public.audit_trigger();
create trigger cactions_audit after insert or update on public.corrective_actions for each row execute function public.audit_trigger();
create trigger envlim_audit after insert or update or delete on public.environmental_limits for each row execute function public.audit_trigger();
create trigger cplans_audit after insert or update or delete on public.cleaning_plans for each row execute function public.audit_trigger();

-- ---------- RLS ----------
alter table public.incidents enable row level security;
alter table public.corrective_actions enable row level security;
alter table public.record_notes enable row level security;
alter table public.environmental_limits enable row level security;
alter table public.temperature_logs enable row level security;
alter table public.cleaning_plans enable row level security;
alter table public.cleaning_tasks enable row level security;
alter table public.cleaning_task_checks enable row level security;

create or replace function public.can_access_incident(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.incidents i where i.id = p and public.is_active_user()
                 and (i.warehouse_id is null or public.has_warehouse_access(i.warehouse_id))
                 and (i.asset_id is null or public.can_access_asset(i.asset_id)))
$$;

create policy inc_read on public.incidents for select to authenticated using (public.can_access_incident(id));
create policy inc_ins on public.incidents for insert to authenticated
  with check (public.has_role('admin','supervisor','operador','mantenimiento','calidad')
              and (warehouse_id is null or public.has_warehouse_access(warehouse_id))
              and status = 'abierta' and reported_by = auth.uid());
create policy inc_upd on public.incidents for update to authenticated
  using (public.has_role('admin','supervisor','calidad','mantenimiento') and public.can_access_incident(id) and status <> 'cerrada')
  with check (public.has_role('admin','supervisor','calidad','mantenimiento') and status <> 'cerrada');
-- El cierre se hace con close_incident()

create policy ca_read on public.corrective_actions for select to authenticated using (public.can_access_incident(incident_id));
create policy ca_ins on public.corrective_actions for insert to authenticated
  with check (public.has_role('admin','supervisor','calidad','mantenimiento') and public.can_access_incident(incident_id) and verified_by is null);
create policy ca_upd on public.corrective_actions for update to authenticated
  using (public.can_access_incident(incident_id) and (responsible_id = auth.uid() or public.has_role('admin','supervisor','calidad')))
  with check (public.can_access_incident(incident_id) and (verified_by is null or verified_by = auth.uid()));

create or replace function public.can_access_entity(p_type text, p_id uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_active_user() then return false; end if;
  return case p_type
    when 'material' then true
    when 'lot' then true
    when 'asset' then public.can_access_asset(p_id)
    when 'work_order' then exists (select 1 from public.work_orders w where w.id = p_id and public.can_access_asset(w.asset_id))
    when 'incident' then public.can_access_incident(p_id)
    when 'inventory_document' then exists (select 1 from public.inventory_documents d where d.id = p_id and public.has_warehouse_access(d.warehouse_id))
    when 'transfer' then exists (select 1 from public.warehouse_transfers t where t.id = p_id and (public.has_warehouse_access(t.origin_warehouse_id) or public.has_warehouse_access(t.dest_warehouse_id)))
    when 'stock_count' then exists (select 1 from public.stock_counts c where c.id = p_id and public.has_warehouse_access(c.warehouse_id))
    when 'cleaning_task' then exists (select 1 from public.cleaning_tasks c where c.id = p_id and public.has_warehouse_access(c.warehouse_id))
    when 'measurement' then exists (select 1 from public.temperature_logs t where t.id = p_id and public.has_warehouse_access(t.warehouse_id))
    else false end;
end $$;

create policy notes_read on public.record_notes for select to authenticated using (public.can_access_entity(entity_type, entity_id));
create policy notes_ins on public.record_notes for insert to authenticated
  with check (created_by = auth.uid() and not public.has_role('consulta') and public.can_access_entity(entity_type, entity_id));

create policy envlim_read on public.environmental_limits for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy envlim_write on public.environmental_limits for all to authenticated
  using (public.has_role('admin','supervisor','calidad') and public.has_warehouse_access(warehouse_id))
  with check (public.has_role('admin','supervisor','calidad') and public.has_warehouse_access(warehouse_id));

create policy temp_read on public.temperature_logs for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy temp_ins on public.temperature_logs for insert to authenticated
  with check (public.has_role('admin','supervisor','operador','calidad','mantenimiento') and public.has_warehouse_access(warehouse_id));

create policy cplans_read on public.cleaning_plans for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy cplans_write on public.cleaning_plans for all to authenticated
  using (public.has_role('admin','supervisor','calidad') and public.has_warehouse_access(warehouse_id))
  with check (public.has_role('admin','supervisor','calidad') and public.has_warehouse_access(warehouse_id));
create policy ctasks_read on public.cleaning_tasks for select to authenticated using (public.has_warehouse_access(warehouse_id));
create policy cchecks_read on public.cleaning_task_checks for select to authenticated
  using (exists (select 1 from public.cleaning_tasks t where t.id = task_id and public.has_warehouse_access(t.warehouse_id)));

-- ---------- Funciones ----------
create or replace function public.incident_set_number() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.incident_number is null or new.incident_number = '' then new.incident_number := public._next_number('INC'); end if;
  return new;
end $$;
create trigger incident_number before insert on public.incidents for each row execute function public.incident_set_number();

create or replace function public.close_incident(p_id uuid, p_notes text, p_root_cause text) returns void
language plpgsql security definer set search_path = public as $$
declare i public.incidents;
begin
  perform public.require_user();
  select * into i from public.incidents where id = p_id for update;
  if not found or not public.can_access_incident(p_id) or not public.has_role('admin','supervisor','calidad') then
    raise exception 'ERP: no autorizado' using errcode='42501';
  end if;
  if i.status = 'cerrada' then raise exception 'ERP: la incidencia ya está cerrada'; end if;
  if exists (select 1 from public.corrective_actions where incident_id = p_id and status not in ('completada','verificada')) then
    raise exception 'ERP: hay acciones correctivas sin completar';
  end if;
  if length(trim(coalesce(p_notes,''))) < 3 then raise exception 'ERP: indique notas de cierre'; end if;
  update public.incidents set status = 'cerrada', closed_by = auth.uid(), closed_at = now(), closing_notes = p_notes,
    root_cause = coalesce(p_root_cause, root_cause) where id = p_id;
end $$;

create or replace function public.complete_cleaning_task(p_task uuid, p_checks jsonb, p_notes text) returns void
language plpgsql security definer set search_path = public as $$
declare t public.cleaning_tasks; pl public.cleaning_plans; x jsonb; v_fail int := 0; v_inc uuid; v_items int;
begin
  perform public.require_user();
  select * into t from public.cleaning_tasks where id = p_task for update;
  if not found or not public.has_warehouse_access(t.warehouse_id) or not public.has_role('admin','supervisor','operador','calidad','mantenimiento') then
    raise exception 'ERP: no autorizado' using errcode='42501';
  end if;
  if t.status = 'completada' then raise exception 'ERP: la tarea ya fue completada'; end if;
  select * into pl from public.cleaning_plans where id = t.plan_id;
  if jsonb_typeof(p_checks) <> 'array' then raise exception 'ERP: lista de comprobación inválida'; end if;
  select count(distinct value->>'item') into v_items from jsonb_array_elements(p_checks) where value->>'item' = any(pl.checklist);
  if v_items < cardinality(pl.checklist) then raise exception 'ERP: complete todos los puntos de la lista'; end if;
  for x in select * from jsonb_array_elements(p_checks) loop
    insert into public.cleaning_task_checks(task_id, item, ok, notes, checked_by)
    values (p_task, x->>'item', (x->>'ok')::boolean, x->>'notes', auth.uid());
    if not (x->>'ok')::boolean then v_fail := v_fail + 1; end if;
  end loop;
  if v_fail > 0 then
    insert into public.incidents(incident_number, title, description, severity, source_type, source_id, warehouse_id, location_id, reported_by)
    values (public._next_number('INC'), 'Incumplimiento de limpieza: ' || pl.name, v_fail || ' punto(s) no conformes. ' || coalesce(p_notes,''),
            'media', 'limpieza', p_task, t.warehouse_id, t.location_id, auth.uid())
    returning id into v_inc;
  end if;
  update public.cleaning_tasks set status = 'completada', completed_by = auth.uid(), completed_at = now(),
    notes = p_notes, incident_id = v_inc where id = p_task;
  update public.cleaning_plans set next_due = greatest(next_due, current_date + frequency_days) where id = t.plan_id;
end $$;

-- ---------- Generación de alertas (idempotente, con límite de frecuencia) ----------
alter table public.company_settings add column last_alerts_run timestamptz;

create or replace function public.generate_alerts(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_last timestamptz; r record; v_exp int := 0; v_low int := 0; v_wo int := 0; v_ct int := 0; v_miss int := 0; v_vencidos int := 0;
begin
  -- Usuario autenticado del ERP, o tarea programada (pg_cron) ejecutada por el dueño de la base
  if auth.uid() is not null then
    perform public.require_user();
  elsif session_user not in ('postgres', 'supabase_admin') then
    raise exception 'ERP: no autorizado' using errcode = '42501';
  end if;
  select last_alerts_run into v_last from public.company_settings where id = 1 for update;
  if not p_force and v_last is not null and v_last > now() - interval '30 minutes' then
    return jsonb_build_object('skipped', true, 'last_run', v_last);
  end if;
  update public.company_settings set last_alerts_run = now() where id = 1;

  -- 1) Lotes vencidos pasan a estado "vencido"
  for r in select id from public.lots where status in ('disponible','cuarentena') and exp_date < current_date for update loop
    update public.lots set status = 'vencido', status_reason = 'Vencimiento automático' where id = r.id;
    v_vencidos := v_vencidos + 1;
  end loop;

  -- 2) Lotes por vencer con existencias
  for r in select distinct l.id, l.lot_code, l.exp_date, m.sku, sb.warehouse_id
             from public.v_lots l join public.stock_balances sb on sb.lot_id = l.id and sb.qty_on_hand > 0
             join public.materials m on m.id = l.material_id
            where l.effective_status = 'por_vencer' loop
    perform public._notify_warehouse(r.warehouse_id, array['admin','supervisor','calidad']::public.app_role[],
      'Lote por vencer: ' || r.sku || ' / ' || r.lot_code, 'Vence el ' || to_char(r.exp_date, 'DD/MM/YYYY'),
      '/lotes', 'vencimiento', 'exp-' || r.id || '-' || r.warehouse_id);
    v_exp := v_exp + 1;
  end loop;

  -- 3) Stock bajo mínimo
  for r in select m.id, m.sku, m.name, m.min_stock, coalesce(sum(sb.qty_on_hand),0) as qty
             from public.materials m left join public.stock_balances sb on sb.material_id = m.id
            where m.active and m.min_stock > 0 group by m.id having coalesce(sum(sb.qty_on_hand),0) < m.min_stock loop
    perform public._notify_warehouse(null, array['admin','supervisor']::public.app_role[],
      'Stock bajo mínimo: ' || r.sku, r.name || ' — existencia ' || r.qty || ' / mínimo ' || r.min_stock,
      '/materiales/' || r.id, 'stock', 'low-' || r.id || '-' || current_date);
    v_low := v_low + 1;
  end loop;

  -- 4) Mantenimiento preventivo
  v_wo := public._generate_preventive_work_orders();

  -- 5) Limpieza: generar tareas e identificar incumplimientos
  insert into public.cleaning_tasks(plan_id, warehouse_id, location_id, due_date)
  select id, warehouse_id, location_id, next_due from public.cleaning_plans
   where active and next_due <= current_date
     and not exists (select 1 from public.cleaning_tasks t where t.plan_id = cleaning_plans.id and t.status = 'pendiente')
  on conflict (plan_id, due_date) do nothing;
  get diagnostics v_ct = row_count;
  for r in update public.cleaning_tasks set status = 'incumplida'
            where status = 'pendiente' and due_date < current_date returning id, plan_id, warehouse_id, due_date loop
    perform public._notify_warehouse(r.warehouse_id, array['admin','supervisor','calidad']::public.app_role[],
      'Limpieza incumplida', 'Tarea del ' || to_char(r.due_date, 'DD/MM/YYYY'), '/calidad/limpieza', 'alerta', 'clean-miss-' || r.id);
    -- Nueva tarea para hoy
    insert into public.cleaning_tasks(plan_id, warehouse_id, location_id, due_date)
    select id, warehouse_id, location_id, current_date from public.cleaning_plans where id = r.plan_id and active
    on conflict (plan_id, due_date) do nothing;
    v_miss := v_miss + 1;
  end loop;

  return jsonb_build_object('lotes_vencidos', v_vencidos, 'por_vencer', v_exp, 'stock_bajo', v_low,
    'ot_preventivas', v_wo, 'tareas_limpieza', v_ct, 'limpiezas_incumplidas', v_miss);
end $$;
