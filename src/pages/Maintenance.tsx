import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Pencil, Plus, Printer } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { invalidateCatalog, useCatalog } from '../lib/catalogs';
import { fmtBOB, fmtDate, fmtDateTime, fmtQty } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, KV, Modal, PageHeader, Select, Spinner, TableWrap, Tabs, Textarea, useToast } from '../components/ui';
import { LocationSelect, UserSelect, WarehouseSelect } from '../components/Pickers';
import CrudTable from '../components/CrudTable';
import DocumentsPanel from '../components/DocumentsPanel';
import NotesPanel from '../components/NotesPanel';
import { printLabels } from '../components/labels';

const ASSET_STATUS = ['operativo', 'en_mantenimiento', 'fuera_de_servicio', 'baja'].map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));
const PRIORITY = ['baja', 'media', 'alta', 'critica'].map((s) => ({ value: s, label: s }));

export function AssetsPage() {
  const { perms, warehouses } = useAuth();
  const { data, loading, error, reload } = useAsync(() => run(supabase.from('assets').select('*, warehouse:warehouses(code), location:locations(code)').order('code')), []);
  const [edit, setEdit] = useState<Row | null>(null);
  const [q, setQ] = useState('');
  const rows = useMemo(() => (data ?? []).filter((a) => !q || [a.code, a.name, a.brand, a.model, a.serial_number].some((v) => v?.toLowerCase().includes(q.toLowerCase()))), [data, q]);
  return (
    <div>
      <PageHeader title="Activos industriales" subtitle="Equipos y maquinaria con su historial de mantenimiento."
        actions={perms.manageMaintenance && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ status: 'operativo', criticality: 'media', active: true, warehouse_id: warehouses[0]?.id ?? '' })}>Nuevo activo</Button>} />
      <Alert>{error}</Alert>
      <Card>
        <Input className="mb-3 max-w-xs" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        {loading ? <Spinner /> : !rows.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Código</th><th>Nombre</th><th>Marca / modelo</th><th>Serie</th><th>Ubicación</th><th>Criticidad</th><th>Estado</th></tr></thead>
            <tbody>{rows.map((a) => <tr key={a.id}><td><Link className="font-medium text-brand-700 hover:underline" to={`/activos/${a.id}`}>{a.code}</Link></td><td>{a.name}</td>
              <td>{[a.brand, a.model].filter(Boolean).join(' · ') || '—'}</td><td>{a.serial_number ?? '—'}</td><td>{a.warehouse?.code ?? '—'}{a.location && ` / ${a.location.code}`}</td>
              <td><Badge status={a.criticality} /></td><td><Badge status={a.status} /></td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>
      <AssetForm asset={edit} onClose={() => setEdit(null)} onSaved={() => { reload(); invalidateCatalog('assets'); }} />
    </div>
  );
}

function AssetForm({ asset, onClose, onSaved }: { asset: Row | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Row>({});
  const [prev, setPrev] = useState<Row | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (asset !== prev) { setPrev(asset); setF(asset ? { ...asset, tech: Object.entries(asset.technical_data ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n') } : {}); setErr(''); }
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (!f.code || !f.name) throw new Error('Código y nombre son obligatorios.');
      const technical_data = Object.fromEntries(String(f.tech ?? '').split('\n').map((l) => l.split(':')).filter((p) => p.length >= 2 && p[0].trim()).map(([k, ...v]) => [k.trim(), v.join(':').trim()]));
      const p = { code: f.code, barcode: f.barcode || null, name: f.name, asset_type: f.asset_type || null, brand: f.brand || null, model: f.model || null,
        serial_number: f.serial_number || null, warehouse_id: f.warehouse_id || null, location_id: f.location_id || null, status: f.status, criticality: f.criticality,
        purchase_date: f.purchase_date || null, technical_data, notes: f.notes || null, active: f.active !== false };
      if (f.id) await run(supabase.from('assets').update(p).eq('id', f.id)); else await run(supabase.from('assets').insert(p));
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!asset} wide title={f.id ? `Editar ${f.code}` : 'Nuevo activo'} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} onClick={save}>Guardar</Button></>}>
      <Alert>{err}</Alert>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Código *"><Input value={f.code ?? ''} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Código de barras"><Input value={f.barcode ?? ''} onChange={(e) => set('barcode', e.target.value)} /></Field>
        <Field label="Tipo"><Input value={f.asset_type ?? ''} onChange={(e) => set('asset_type', e.target.value)} placeholder="Compresor, montacargas…" /></Field>
        <Field label="Nombre *" className="sm:col-span-3"><Input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Marca"><Input value={f.brand ?? ''} onChange={(e) => set('brand', e.target.value)} /></Field>
        <Field label="Modelo"><Input value={f.model ?? ''} onChange={(e) => set('model', e.target.value)} /></Field>
        <Field label="N.º de serie"><Input value={f.serial_number ?? ''} onChange={(e) => set('serial_number', e.target.value)} /></Field>
        <Field label="Almacén"><WarehouseSelect value={f.warehouse_id ?? ''} onChange={(v) => { set('warehouse_id', v); set('location_id', ''); }} placeholder="Sin almacén" /></Field>
        <Field label="Ubicación"><LocationSelect warehouseId={f.warehouse_id} value={f.location_id ?? ''} onChange={(v) => set('location_id', v)} /></Field>
        <Field label="Fecha de compra"><Input type="date" value={f.purchase_date ?? ''} onChange={(e) => set('purchase_date', e.target.value)} /></Field>
        <Field label="Estado operativo"><Select value={f.status ?? 'operativo'} onChange={(e) => set('status', e.target.value)} options={ASSET_STATUS} /></Field>
        <Field label="Criticidad"><Select value={f.criticality ?? 'media'} onChange={(e) => set('criticality', e.target.value)} options={PRIORITY} /></Field>
        <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={f.active !== false} onChange={(e) => set('active', e.target.checked)} />Activo</label>
        <Field label="Datos técnicos (una línea por dato: Potencia: 15 kW)" className="sm:col-span-3"><Textarea rows={4} value={f.tech ?? ''} onChange={(e) => set('tech', e.target.value)} /></Field>
        <Field label="Notas" className="sm:col-span-3"><Textarea value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function AssetDetail() {
  const { id } = useParams();
  const { perms } = useAuth();
  const { data: a, loading, reload } = useAsync(() => run(supabase.from('assets').select('*, warehouse:warehouses(code,name), location:locations(code)').eq('id', id!).single()), [id]);
  const [tab, setTab] = useState('info');
  const [edit, setEdit] = useState<Row | null>(null);
  if (loading) return <Spinner />;
  if (!a) return <Empty>Activo no encontrado o sin acceso.</Empty>;
  return (
    <div>
      <PageHeader title={<>{a.code} <span className="font-normal text-slate-500">· {a.name}</span></>} subtitle={<><Badge status={a.status} /> <Badge status={a.criticality}>Criticidad {a.criticality}</Badge></>}
        actions={<>
          <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => printLabels([{ code: a.barcode || a.code, title: a.code, subtitle: a.name }])}>Etiqueta</Button>
          {perms.createWorkOrders && <Link to={`/mantenimiento/ordenes/nueva?asset=${a.id}`}><Button variant="secondary">Nueva OT</Button></Link>}
          {perms.manageMaintenance && <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(a)}>Editar</Button>}
        </>} />
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'info', label: 'Datos' }, { key: 'wo', label: 'Órdenes de trabajo' }, { key: 'plans', label: 'Planes preventivos' }, { key: 'log', label: 'Historial' }, { key: 'docs', label: 'Documentos' }, { key: 'notes', label: 'Observaciones' }]} />
      {tab === 'info' && <Card><KV items={[['Tipo', a.asset_type], ['Marca', a.brand], ['Modelo', a.model], ['N.º de serie', a.serial_number], ['Ubicación', a.warehouse ? `${a.warehouse.code}${a.location ? ' / ' + a.location.code : ''}` : '—'],
        ['Fecha de compra', fmtDate(a.purchase_date)], ['Notas', a.notes], ...Object.entries(a.technical_data ?? {}).map(([k, v]) => [k, String(v)] as [string, string])]} /></Card>}
      {tab === 'wo' && <WorkOrdersTable assetId={a.id} />}
      {tab === 'plans' && <Card><PlansTable assetId={a.id} /></Card>}
      {tab === 'log' && <MaintenanceLog assetId={a.id} />}
      {tab === 'docs' && <Card><DocumentsPanel entityType="asset" entityId={a.id} /></Card>}
      {tab === 'notes' && <Card><NotesPanel entityType="asset" entityId={a.id} /></Card>}
      <AssetForm asset={edit} onClose={() => setEdit(null)} onSaved={reload} />
    </div>
  );
}

function MaintenanceLog({ assetId }: { assetId: string }) {
  const { perms } = useAuth();
  const { data, reload } = useAsync(() => run(supabase.from('maintenance_logs').select('*, who:profiles(full_name), wo:work_orders(wo_number)').eq('asset_id', assetId).order('log_date', { ascending: false })), [assetId]);
  const [text, setText] = useState('');
  const t = useToast();
  return (
    <Card>
      {t.node}
      {perms.manageMaintenance && <div className="mb-4 flex gap-2"><Input placeholder="Registrar intervención o inspección…" value={text} onChange={(e) => setText(e.target.value)} />
        <Button disabled={!text.trim()} onClick={async () => { try { const { data: u } = await supabase.auth.getUser(); await run(supabase.from('maintenance_logs').insert({ asset_id: assetId, description: text.trim(), performed_by: u.user!.id })); setText(''); reload(); } catch (e) { t.fail(e); } }}>Registrar</Button></div>}
      {!data?.length ? <Empty>Sin historial.</Empty> : (
        <ul className="space-y-2">{data.map((l) => <li key={l.id} className="rounded-lg border border-slate-100 p-3 text-sm"><div className="text-xs text-slate-400">{fmtDate(l.log_date)} · {l.who?.full_name}{l.wo && ` · ${l.wo.wo_number}`}</div>{l.description}</li>)}</ul>
      )}
    </Card>
  );
}

export function PlansTable({ assetId }: { assetId?: string }) {
  const { perms } = useAuth();
  const assets = useCatalog('assets');
  const users = useCatalog('profiles');
  return <CrudTable table="maintenance_plans" orderBy="next_due" canEdit={perms.manageMaintenance} filter={assetId ? (r) => r.asset_id === assetId : undefined}
    defaults={{ asset_id: assetId ?? '', active: true, lead_days: 7, frequency_days: 30, next_due: new Date().toISOString().slice(0, 10) }}
    columns={[
      { key: 'asset_id', label: 'Activo', type: 'select', required: true, options: assets.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })), hideInTable: !!assetId },
      { key: 'name', label: 'Plan', required: true }, { key: 'frequency_days', label: 'Frecuencia (días)', type: 'number', required: true },
      { key: 'lead_days', label: 'Anticipación OT (días)', type: 'number', hideInTable: true }, { key: 'next_due', label: 'Próxima fecha', type: 'date', required: true, render: (r) => <span className={r.next_due < new Date().toISOString().slice(0, 10) ? 'font-semibold text-red-600' : ''}>{fmtDate(r.next_due)}</span> },
      { key: 'last_done', label: 'Última ejecución', type: 'date', hideInForm: true, render: (r) => fmtDate(r.last_done) },
      { key: 'responsible_id', label: 'Responsable', type: 'select', options: users.filter((u) => ['mantenimiento', 'admin'].includes(u.role)).map((u) => ({ value: u.id, label: u.full_name || u.email })) },
      { key: 'tasks', label: 'Tareas', type: 'textarea', hideInTable: true }, { key: 'active', label: 'Activo', type: 'bool' },
    ]} />;
}

export function PlansPage() {
  return (
    <div>
      <PageHeader title="Planes de mantenimiento preventivo" subtitle="Las órdenes preventivas se generan automáticamente con la anticipación configurada." />
      <Card><PlansTable /></Card>
    </div>
  );
}

function WorkOrdersTable({ assetId }: { assetId?: string }) {
  const [status, setStatus] = useState('abiertas');
  const { data, loading } = useAsync(() => {
    let q = supabase.from('v_work_order_costs').select('*').order('created_at', { ascending: false }).limit(500);
    if (assetId) q = q.eq('asset_id', assetId);
    if (status === 'abiertas') q = q.in('status', ['abierta', 'en_progreso', 'en_espera']);
    else if (status) q = q.eq('status', status);
    return run(q);
  }, [assetId, status]);
  const wo = useAsync(() => run(supabase.from('work_orders').select('id,title,priority,scheduled_date,assigned:profiles!work_orders_assigned_to_fkey(full_name)')), []);
  const extra = new Map((wo.data ?? []).map((w) => [w.id, w]));
  const { perms } = useAuth();
  return (
    <Card>
      <div className="mb-3 max-w-xs"><Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'abiertas', label: 'Abiertas' }, { value: 'completada', label: 'Completadas' }, { value: 'cancelada', label: 'Canceladas' }, { value: '', label: 'Todas' }]} /></div>
      {loading ? <Spinner /> : !data?.length ? <Empty /> : (
        <TableWrap><table className="table"><thead><tr><th>OT</th><th>Activo</th><th>Título</th><th>Tipo</th><th>Prioridad</th><th>Programada</th><th>Responsable</th><th>Estado</th>{perms.manageMaintenance || perms.viewCosts ? <th className="num">Costo</th> : null}</tr></thead>
          <tbody>{data.map((w) => {
            const x = extra.get(w.id) ?? {};
            const late = x.scheduled_date && x.scheduled_date < new Date().toISOString().slice(0, 10) && !['completada', 'cancelada'].includes(w.status);
            return <tr key={w.id}><td><Link className="font-medium text-brand-700 hover:underline" to={`/mantenimiento/ordenes/${w.id}`}>{w.wo_number}</Link></td><td>{w.asset_code}</td><td>{x.title}</td>
              <td>{w.wo_type}</td><td><Badge status={x.priority} /></td><td className={late ? 'font-semibold text-red-600' : ''}>{fmtDate(x.scheduled_date)}</td><td>{x.assigned?.full_name ?? '—'}</td><td><Badge status={w.status} /></td>
              {perms.manageMaintenance || perms.viewCosts ? <td className="num">{fmtBOB(w.total_cost)}</td> : null}</tr>;
          })}</tbody></table></TableWrap>
      )}
    </Card>
  );
}

export function WorkOrdersPage() {
  const { perms } = useAuth();
  return (
    <div>
      <PageHeader title="Órdenes de trabajo" subtitle="Correctivas y preventivas, con materiales, mano de obra y costos."
        actions={perms.createWorkOrders && <Link to="/mantenimiento/ordenes/nueva"><Button icon={<Plus className="h-4 w-4" />}>Nueva OT</Button></Link>} />
      <WorkOrdersTable />
    </div>
  );
}

export function WorkOrderNew() {
  const nav = useNavigate();
  const assets = useCatalog('assets');
  const params = new URLSearchParams(window.location.search);
  const [f, setF] = useState<Row>({ asset_id: params.get('asset') ?? '', wo_type: 'correctivo', priority: 'media', title: '', description: '', assigned_to: '', scheduled_date: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <PageHeader title="Nueva orden de trabajo" />
      <Alert>{err}</Alert>
      <Card>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Activo *" className="md:col-span-2"><Select value={f.asset_id} onChange={(e) => setF({ ...f, asset_id: e.target.value })} placeholder="—" options={assets.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))} /></Field>
          <Field label="Tipo"><Select value={f.wo_type} onChange={(e) => setF({ ...f, wo_type: e.target.value })} options={[{ value: 'correctivo', label: 'Correctivo' }, { value: 'preventivo', label: 'Preventivo' }]} /></Field>
          <Field label="Título *" className="md:col-span-3"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Descripción del problema / trabajo" className="md:col-span-3"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Prioridad"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} options={PRIORITY} /></Field>
          <Field label="Responsable"><UserSelect value={f.assigned_to} onChange={(v) => setF({ ...f, assigned_to: v })} roles={['mantenimiento', 'admin']} /></Field>
          <Field label="Fecha programada"><Input type="date" value={f.scheduled_date} onChange={(e) => setF({ ...f, scheduled_date: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => nav(-1)}>Cancelar</Button>
          <Button loading={busy} onClick={async () => {
            setBusy(true); setErr('');
            try {
              if (!f.asset_id || !f.title.trim()) throw new Error('Seleccione activo e indique el título.');
              const { data: u } = await supabase.auth.getUser();
              const r = await run(supabase.from('work_orders').insert({ ...f, wo_number: '', assigned_to: f.assigned_to || null, scheduled_date: f.scheduled_date || null, requested_by: u.user!.id }).select('id').single()) as Row;
              nav(`/mantenimiento/ordenes/${r.id}`, { replace: true });
            } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>Crear</Button>
        </div>
      </Card>
    </div>
  );
}

export function WorkOrderDetail() {
  const { id } = useParams();
  const { perms } = useAuth();
  const t = useToast();
  const wo = useAsync(() => run(supabase.from('work_orders').select('*, asset:assets(id,code,name,warehouse_id), assigned:profiles!work_orders_assigned_to_fkey(full_name), requester:profiles!work_orders_requested_by_fkey(full_name), plan:maintenance_plans(name)').eq('id', id!).single()), [id]);
  const cost = useAsync(() => run(supabase.from('v_work_order_costs').select('*').eq('id', id!).maybeSingle()), [id]);
  const mats = useAsync(() => run(supabase.from('work_order_materials').select('*, material:materials(sku,name)').eq('work_order_id', id!)), [id]);
  const docs = useAsync(() => run(supabase.from('inventory_documents').select('id,doc_number,status,created_at').eq('work_order_id', id!).order('created_at')), [id]);
  const [tab, setTab] = useState('info');
  const [done, setDone] = useState<Row | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  if (wo.loading) return <Spinner />;
  const w = wo.data;
  if (!w) return <Empty>Orden no encontrada o sin acceso.</Empty>;
  const open = !['completada', 'cancelada'].includes(w.status);
  const setStatus = async (status: string) => {
    try {
      await run(supabase.from('work_orders').update({ status, started_at: status === 'en_progreso' && !w.started_at ? new Date().toISOString() : w.started_at }).eq('id', w.id));
      if (status === 'en_progreso') await supabase.from('assets').update({ status: 'en_mantenimiento' }).eq('id', w.asset.id);
      wo.reload();
    } catch (e) { t.fail(e); }
  };
  const showCosts = perms.manageMaintenance || perms.viewCosts;
  return (
    <div>
      <PageHeader title={<>{w.wo_number} <Badge status={w.status} /></>} subtitle={<><Link className="text-brand-700" to={`/activos/${w.asset.id}`}>{w.asset.code} — {w.asset.name}</Link> · {w.wo_type} · prioridad {w.priority}</>}
        actions={perms.manageMaintenance && open && <>
          {w.status === 'abierta' && <Button variant="secondary" onClick={() => setStatus('en_progreso')}>Iniciar</Button>}
          {w.status === 'en_progreso' && <Button variant="secondary" onClick={() => setStatus('en_espera')}>En espera</Button>}
          {w.status === 'en_espera' && <Button variant="secondary" onClick={() => setStatus('en_progreso')}>Reanudar</Button>}
          <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit({ ...w })}>Editar</Button>
          <Link to={`/inventario/salidas/nuevo?ot=${w.id}`}><Button variant="secondary">Solicitar materiales</Button></Link>
          <Button variant="success" icon={<Check className="h-4 w-4" />} onClick={() => setDone({ notes: '', labor_hours: w.labor_hours, labor_cost: w.labor_cost, external_cost: w.external_cost })}>Completar</Button>
          <Button variant="ghost" onClick={() => setStatus('cancelada')}>Cancelar OT</Button>
        </>} />
      {t.node}
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'info', label: 'Datos' }, { key: 'mat', label: 'Materiales y costos' }, { key: 'docs', label: 'Documentos' }, { key: 'notes', label: 'Observaciones' }]} />
      {tab === 'info' && <Card><KV items={[['Título', w.title], ['Descripción', w.description], ['Plan', w.plan?.name], ['Solicitado por', w.requester?.full_name], ['Responsable', w.assigned?.full_name],
        ['Programada', fmtDate(w.scheduled_date)], ['Inicio', fmtDateTime(w.started_at)], ['Fin', fmtDateTime(w.completed_at)], ['Horas', fmtQty(w.labor_hours)], ['Resultado', w.result_notes]]} /></Card>}
      {tab === 'mat' && <div className="space-y-4">
        {showCosts && cost.data && <Card><KV items={[['Mano de obra', fmtBOB(cost.data.labor_cost)], ['Servicios externos', fmtBOB(cost.data.external_cost)], ['Materiales', fmtBOB(cost.data.materials_cost)], ['Total', <b>{fmtBOB(cost.data.total_cost)}</b>]]} /></Card>}
        <Card title="Salidas de inventario vinculadas" padded={false}>
          {!docs.data?.length ? <Empty>Sin solicitudes de material.</Empty> : <TableWrap><table className="table"><tbody>{docs.data.map((d) => <tr key={d.id}><td><Link className="text-brand-700" to={`/inventario/documentos/${d.id}`}>{d.doc_number}</Link></td><td><Badge status={d.status} /></td><td className="text-xs">{fmtDateTime(d.created_at)}</td></tr>)}</tbody></table></TableWrap>}
        </Card>
        <Card title="Materiales consumidos" padded={false}>
          {!mats.data?.length ? <Empty>Se registran al confirmar las salidas.</Empty> : <TableWrap><table className="table"><thead><tr><th>Material</th><th className="num">Cantidad</th>{showCosts && <><th className="num">Costo unit.</th><th className="num">Total</th></>}</tr></thead>
            <tbody>{mats.data.map((m) => <tr key={m.id}><td>{m.material?.sku} — {m.material?.name}</td><td className="num">{fmtQty(m.qty_base)}</td>{showCosts && <><td className="num">{fmtBOB(m.unit_cost)}</td><td className="num">{fmtBOB(m.total_cost)}</td></>}</tr>)}</tbody></table></TableWrap>}
        </Card>
      </div>}
      {tab === 'docs' && <Card><DocumentsPanel entityType="work_order" entityId={w.id} /></Card>}
      {tab === 'notes' && <Card><NotesPanel entityType="work_order" entityId={w.id} /></Card>}
      <Modal open={!!done} title="Completar orden de trabajo" onClose={() => setDone(null)} footer={<><Button variant="secondary" onClick={() => setDone(null)}>Cancelar</Button>
        <Button variant="success" onClick={async () => { try { await rpc('complete_work_order', { p_id: w.id, p_notes: done!.notes, p_labor_hours: Number(done!.labor_hours || 0), p_labor_cost: Number(done!.labor_cost || 0), p_external_cost: Number(done!.external_cost || 0) }); setDone(null); wo.reload(); cost.reload(); t.ok('OT completada; historial y plan actualizados.'); } catch (e) { t.fail(e); setDone(null); } }}>Completar</Button></>}>
        {done && <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Trabajo realizado *" className="sm:col-span-3"><Textarea value={done.notes} onChange={(e) => setDone({ ...done, notes: e.target.value })} /></Field>
          <Field label="Horas"><Input type="number" min={0} step="any" value={done.labor_hours} onChange={(e) => setDone({ ...done, labor_hours: e.target.value })} /></Field>
          <Field label="Mano de obra BOB"><Input type="number" min={0} step="any" value={done.labor_cost} onChange={(e) => setDone({ ...done, labor_cost: e.target.value })} /></Field>
          <Field label="Externos BOB"><Input type="number" min={0} step="any" value={done.external_cost} onChange={(e) => setDone({ ...done, external_cost: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!edit} title="Editar OT" onClose={() => setEdit(null)} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button>
        <Button onClick={async () => { try { await run(supabase.from('work_orders').update({ title: edit!.title, description: edit!.description, priority: edit!.priority, assigned_to: edit!.assigned_to || null, scheduled_date: edit!.scheduled_date || null, labor_hours: Number(edit!.labor_hours || 0), labor_cost: Number(edit!.labor_cost || 0), external_cost: Number(edit!.external_cost || 0) }).eq('id', w.id)); setEdit(null); wo.reload(); cost.reload(); } catch (e) { t.fail(e); } }}>Guardar</Button></>}>
        {edit && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Título" className="sm:col-span-2"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
          <Field label="Descripción" className="sm:col-span-2"><Textarea value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <Field label="Prioridad"><Select value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} options={PRIORITY} /></Field>
          <Field label="Responsable"><UserSelect value={edit.assigned_to ?? ''} onChange={(v) => setEdit({ ...edit, assigned_to: v })} roles={['mantenimiento', 'admin']} /></Field>
          <Field label="Programada"><Input type="date" value={edit.scheduled_date ?? ''} onChange={(e) => setEdit({ ...edit, scheduled_date: e.target.value })} /></Field>
          <Field label="Horas"><Input type="number" value={edit.labor_hours} onChange={(e) => setEdit({ ...edit, labor_hours: e.target.value })} /></Field>
          <Field label="Mano de obra BOB"><Input type="number" value={edit.labor_cost} onChange={(e) => setEdit({ ...edit, labor_cost: e.target.value })} /></Field>
          <Field label="Externos BOB"><Input type="number" value={edit.external_cost} onChange={(e) => setEdit({ ...edit, external_cost: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
