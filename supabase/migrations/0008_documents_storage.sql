-- =====================================================================
-- ERP INDUSTRIAL · 0008 · Documentos técnicos y Storage privado
-- Tabla única "documents" con FKs reales (exactamente una informada),
-- en lugar de material_documents / asset_documents separados.
-- =====================================================================
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  material_id uuid references public.materials(id),
  lot_id uuid references public.lots(id),
  asset_id uuid references public.assets(id),
  work_order_id uuid references public.work_orders(id),
  incident_id uuid references public.incidents(id),
  title text not null,
  doc_category text not null default 'otro'
    check (doc_category in ('ficha_tecnica','certificado','foto','manual','hoja_seguridad','inspeccion','otro')),
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  version int not null default 1,
  status text not null default 'vigente' check (status in ('vigente','reemplazado','eliminado')),
  replaces_id uuid references public.documents(id),
  replaced_by uuid references public.documents(id),
  is_controlled boolean not null default false,   -- documentos importantes: solo admin puede retirarlos
  uploaded_by uuid not null references public.profiles(id),
  uploaded_at timestamptz not null default now(),
  deleted_by uuid references public.profiles(id),
  deleted_at timestamptz,
  delete_reason text,
  check (num_nonnulls(material_id, lot_id, asset_id, work_order_id, incident_id) = 1)
);
create index on public.documents(material_id);
create index on public.documents(asset_id);
create index on public.documents(work_order_id);
create index on public.documents(incident_id);
create index on public.documents(lot_id);
create trigger documents_audit after insert or update on public.documents for each row execute function public.audit_trigger();

create or replace function public.document_entity(d public.documents) returns table(entity_type text, entity_id uuid)
language sql immutable as $$
  select case when d.material_id is not null then 'material' when d.lot_id is not null then 'lot'
              when d.asset_id is not null then 'asset' when d.work_order_id is not null then 'work_order' else 'incident' end,
         coalesce(d.material_id, d.lot_id, d.asset_id, d.work_order_id, d.incident_id)
$$;

create or replace function public.can_read_document(p_doc uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare d public.documents; e record;
begin
  select * into d from public.documents where id = p_doc;
  if not found then return false; end if;
  if d.status = 'eliminado' and not public.is_admin() then return false; end if;
  select * into e from public.document_entity(d);
  return public.can_access_entity(e.entity_type, e.entity_id);
end $$;

create or replace function public.can_upload_documents() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin','supervisor','mantenimiento','calidad')
$$;

alter table public.documents enable row level security;
create policy docs_read on public.documents for select to authenticated using (public.can_read_document(id));
-- Escritura solo por RPC (register_document / retire_document)

create or replace function public.register_document(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user(); v_id uuid; v_type text := p->>'entity_type'; v_eid uuid := (p->>'entity_id')::uuid;
  v_path text := p->>'storage_path'; v_old public.documents; v_ver int := 1;
begin
  if not public.can_upload_documents() then raise exception 'ERP: su rol no puede subir documentos' using errcode='42501'; end if;
  if v_type not in ('material','lot','asset','work_order','incident') then raise exception 'ERP: entidad no admitida'; end if;
  if not public.can_access_entity(v_type, v_eid) then raise exception 'ERP: sin acceso al registro' using errcode='42501'; end if;
  if v_path is null or v_path not like v_type || '/' || v_eid || '/%' then raise exception 'ERP: ruta de archivo inválida'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'erp-documents' and name = v_path and owner_id = v_uid::text) then
    raise exception 'ERP: el archivo no fue subido por usted o no existe';
  end if;
  if nullif(p->>'replaces_id','') is not null then
    select * into v_old from public.documents where id = (p->>'replaces_id')::uuid for update;
    if not found or v_old.status <> 'vigente' then raise exception 'ERP: el documento a reemplazar no está vigente'; end if;
    if (select entity_id from public.document_entity(v_old)) <> v_eid then raise exception 'ERP: el reemplazo debe ser del mismo registro'; end if;
    v_ver := v_old.version + 1;
  end if;
  insert into public.documents(material_id, lot_id, asset_id, work_order_id, incident_id, title, doc_category, storage_path,
    file_name, mime_type, size_bytes, version, replaces_id, is_controlled, uploaded_by)
  values (case when v_type='material' then v_eid end, case when v_type='lot' then v_eid end, case when v_type='asset' then v_eid end,
          case when v_type='work_order' then v_eid end, case when v_type='incident' then v_eid end,
          coalesce(nullif(p->>'title',''), p->>'file_name'), coalesce(nullif(p->>'doc_category',''),'otro'), v_path,
          p->>'file_name', p->>'mime_type', nullif(p->>'size_bytes','')::bigint, v_ver, v_old.id,
          coalesce((p->>'is_controlled')::boolean, coalesce(v_old.is_controlled, false)), v_uid)
  returning id into v_id;
  if v_old.id is not null then
    update public.documents set status = 'reemplazado', replaced_by = v_id where id = v_old.id;
  end if;
  return v_id;
end $$;

-- "Eliminar" = retirar (borrado lógico). El archivo se conserva para trazabilidad.
create or replace function public.retire_document(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.documents;
begin
  perform public.require_user();
  select * into d from public.documents where id = p_id for update;
  if not found or not public.can_read_document(p_id) then raise exception 'ERP: documento no encontrado'; end if;
  if d.status <> 'vigente' then raise exception 'ERP: el documento no está vigente'; end if;
  if d.is_controlled and not public.is_admin() then raise exception 'ERP: documento controlado: solo un administrador puede retirarlo' using errcode='42501'; end if;
  if not (public.is_admin() or (public.can_upload_documents() and d.uploaded_by = auth.uid())) then
    raise exception 'ERP: no autorizado' using errcode='42501';
  end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'ERP: indique el motivo'; end if;
  update public.documents set status = 'eliminado', deleted_by = auth.uid(), deleted_at = now(), delete_reason = p_reason where id = p_id;
end $$;

-- ---------- Storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('erp-documents', 'erp-documents', false, 26214400,
  array['application/pdf','image/jpeg','image/png','image/webp','image/gif',
        'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','text/csv'])
on conflict (id) do update set public = false;

-- Subir: solo roles autorizados, en carpeta entidad/id con acceso
create policy erp_docs_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'erp-documents'
    and public.can_upload_documents()
    and (storage.foldername(name))[1] in ('material','lot','asset','work_order','incident')
    and public.can_access_entity((storage.foldername(name))[1], ((storage.foldername(name))[2])::uuid)
  );

-- Leer/descargar (URL firmada): solo si existe un registro de documento visible para el usuario,
-- o si es un archivo propio aún no registrado (ventana de subida).
create policy erp_docs_select on storage.objects for select to authenticated
  using (
    bucket_id = 'erp-documents' and (
      exists (select 1 from public.documents d where d.storage_path = name and public.can_read_document(d.id))
      or (owner_id = auth.uid()::text and not exists (select 1 from public.documents d where d.storage_path = name))
    )
  );
-- Sin políticas UPDATE/DELETE: los archivos no se sobrescriben ni se borran desde el cliente.
