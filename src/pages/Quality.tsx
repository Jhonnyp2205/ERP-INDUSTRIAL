import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Plus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCatalog } from '../lib/catalogs';
import { fmtDate, fmtDateTime } from '../lib/format';
import { downloadCSV } from '../lib/csv';
import { Alert, Badge, Button, Card, Empty, Field, Input, KV, Modal, PageHeader, Select, Spinner, TableWrap, Tabs, Textarea, useToast } from '../components/ui';
import { LocationSelect, UserSelect, WarehouseSelect } from '../components/Pickers';
import CrudTable from '../components/CrudTable';
import DocumentsPanel from '../components/DocumentsPanel';
import NotesPanel from '../components/NotesPanel';

const PARAMS = [{ value: 'temperatura', label: 'Temperatura' }, { value: 'humedad', label: 'Humedad relativa' }, { value: 'presion', label: 'Presión' }, { value: 'otro', label: 'Otro' }];

// ------------------------------ Mediciones ------------------------------
export function MeasurementsPage() {
  const { perms, warehouses } = useAuth();
  const locs = useCatalog('locations');
  const [tab, setTab] = useState('log');
  const [wh, setWh] = useState(warehouses[0]?.id ?? '');
  const [f, setF] = useState<Row>({ location_id: '', parameter: 'temperatura', value: '', measured_at: '', notes: '' });
  const [onlyOut, setOnlyOut] = useState(false);
  const t = useToast();
  const logs = useAsync(() => {
    let q = supabase.from('temperature_logs').select('*, location:locations(code), who:profiles!temperature_logs_recorded_by_fkey(full_name), incident:incidents(incident_number)').order('measured_at', { ascending: false }).limit(500);
    if (wh) q = q.eq('warehouse_id', wh);
    if (onlyOut) q = q.eq('out_of_range', true);
    return run(q);
  }, [wh, onlyOut]);
  const record = async () => {
    try {
      if (!wh || f.value === '') throw new Error('Indique almacén y valor.');
      await run(supabase.from('temperature_logs').insert({ warehouse_id: wh, location_id: f.location_id || null, parameter: f.parameter, value: Number(f.value),
        measured_at: f.measured_at ? new Date(f.measured_at).toISOString() : undefined, notes: f.notes || null }));
      setF({ ...f, value: '', notes: '', measured_at: '' }); logs.reload(); t.ok('Medición registrada.');
    } catch (e) { t.fail(e); }
  };
  return (
    <div>
      <PageHeader title="Temperatura y condiciones ambientales" subtitle="Registro manual. Los valores fuera de límite abren una incidencia y generan alertas internas." />
      {t.node}
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'log', label: 'Mediciones' }, { key: 'limits', label: 'Límites' }]} />
      {tab === 'log' && <>
        {perms.recordMeasurements && <Card title="Registrar medición" className="mb-4">
          <div className="grid items-end gap-2 md:grid-cols-6">
            <Field label="Almacén"><WarehouseSelect value={wh} onChange={setWh} /></Field>
            <Field label="Ubicación"><LocationSelect warehouseId={wh} value={f.location_id} onChange={(v) => setF({ ...f, location_id: v })} placeholder="General" /></Field>
            <Field label="Parámetro"><Select value={f.parameter} onChange={(e) => setF({ ...f, parameter: e.target.value })} options={PARAMS} /></Field>
            <Field label="Valor"><Input type="number" step="any" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && record()} /></Field>
            <Field label="Fecha/hora (vacío = ahora)"><Input type="datetime-local" value={f.measured_at} onChange={(e) => setF({ ...f, measured_at: e.target.value })} /></Field>
            <Button onClick={record}>Registrar</Button>
            <Input className="md:col-span-6" placeholder="Observación (opcional)" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
        </Card>}
        <Card title="Historial" actions={<>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyOut} onChange={(e) => setOnlyOut(e.target.checked)} />Solo fuera de rango</label>
          <Button variant="secondary" onClick={() => downloadCSV('mediciones', logs.data ?? [], [{ key: 'measured_at', label: 'Fecha' }, { key: 'parameter', label: 'Parámetro' }, { key: 'value', label: 'Valor' }, { key: 'unit', label: 'Unidad' }, { key: 'limit_min', label: 'Mín' }, { key: 'limit_max', label: 'Máx' }, { key: 'out_of_range', label: 'Fuera de rango' }])}>CSV</Button>
        </>} padded={false}>
          {!perms.recordMeasurements && <div className="p-3"><WarehouseSelect value={wh} onChange={setWh} /></div>}
          {logs.loading ? <Spinner /> : !logs.data?.length ? <Empty /> : (
            <TableWrap><table className="table"><thead><tr><th>Fecha y hora</th><th>Ubicación</th><th>Parámetro</th><th className="num">Valor</th><th>Límites</th><th>Estado</th><th>Responsable</th><th>Incidencia</th></tr></thead>
              <tbody>{logs.data.map((m) => <tr key={m.id} className={m.out_of_range ? 'bg-red-50' : ''}><td className="text-xs">{fmtDateTime(m.measured_at)}</td><td>{m.location?.code ?? 'General'}</td><td>{m.parameter}</td>
                <td className="num font-semibold">{m.value} {m.unit}</td><td className="text-xs">{m.limit_min ?? '—'} a {m.limit_max ?? '—'}</td>
                <td>{m.out_of_range ? <Badge tone="red">Fuera de rango</Badge> : <Badge tone="green">OK</Badge>}</td><td className="text-xs">{m.who?.full_name}</td>
                <td>{m.incident_id ? <Link className="text-brand-700" to={`/calidad/incidencias/${m.incident_id}`}>{m.incident?.incident_number}</Link> : '—'}</td></tr>)}</tbody></table></TableWrap>
          )}
        </Card>
      </>}
      {tab === 'limits' && <Card>
        <CrudTable table="environmental_limits" orderBy="created_at" canEdit={perms.manageQuality} defaults={{ parameter: 'temperatura', unit: '°C', active: true, warehouse_id: wh }}
          transform={(f) => ({ ...f, location_id: f.location_id || null })}
          columns={[
            { key: 'warehouse_id', label: 'Almacén', type: 'select', required: true, options: warehouses.map((w) => ({ value: w.id, label: w.code })) },
            { key: 'location_id', label: 'Ubicación', type: 'select', options: locs.map((l) => ({ value: l.id, label: l.code })), hint: 'Vacío = todo el almacén' },
            { key: 'parameter', label: 'Parámetro', type: 'select', options: PARAMS, required: true }, { key: 'unit', label: 'Unidad', required: true },
            { key: 'min_value', label: 'Mínimo', type: 'number' }, { key: 'max_value', label: 'Máximo', type: 'number' }, { key: 'active', label: 'Activo', type: 'bool' },
          ]} />
      </Card>}
    </div>
  );
}

// ------------------------------ Limpieza ------------------------------
export function CleaningPage() {
  const { perms, warehouses } = useAuth();
  const locs = useCatalog('locations');
  const [tab, setTab] = useState('tasks');
  const [status, setStatus] = useState('pendiente');
  const tasks = useAsync(() => {
    let q = supabase.from('cleaning_tasks').select('*, plan:cleaning_plans(name,checklist), warehouse:warehouses(code), location:locations(code), who:profiles!cleaning_tasks_completed_by_fkey(full_name)').order('due_date', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    return run(q);
  }, [status]);
  const [task, setTask] = useState<Row | null>(null);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; notes: string }>>({});
  const [notes, setNotes] = useState('');
  const t = useToast();
  const openTask = (x: Row) => { setTask(x); setNotes(''); setChecks(Object.fromEntries((x.plan?.checklist ?? []).map((i: string) => [i, { ok: true, notes: '' }]))); };
  return (
    <div>
      <PageHeader title="Planes y listas de limpieza" subtitle="Las tareas se generan según la frecuencia. Las vencidas sin ejecutar quedan como incumplidas." />
      {t.node}
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'tasks', label: 'Tareas' }, { key: 'plans', label: 'Planes' }]} />
      {tab === 'tasks' && <Card actions={<Button variant="secondary" onClick={async () => { try { await rpc('generate_alerts', { p_force: true }); tasks.reload(); } catch (e) { t.fail(e); } }}>Generar tareas del día</Button>}>
        <div className="mb-3 max-w-xs"><Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Todas" options={[{ value: 'pendiente', label: 'Pendientes' }, { value: 'incumplida', label: 'Incumplidas' }, { value: 'completada', label: 'Completadas' }]} /></div>
        {tasks.loading ? <Spinner /> : !tasks.data?.length ? <Empty>Sin tareas.</Empty> : (
          <TableWrap><table className="table"><thead><tr><th>Plan</th><th>Almacén / ubicación</th><th>Fecha</th><th>Estado</th><th>Realizada por</th><th /></tr></thead>
            <tbody>{tasks.data.map((x) => <tr key={x.id}><td>{x.plan?.name}</td><td>{x.warehouse?.code}{x.location && ` / ${x.location.code}`}</td><td>{fmtDate(x.due_date)}</td>
              <td><Badge status={x.status === 'pendiente' ? 'pendiente_tarea' : x.status}>{x.status}</Badge>{x.incident_id && <Link className="ml-1 text-xs text-red-600" to={`/calidad/incidencias/${x.incident_id}`}>incidencia</Link>}</td>
              <td className="text-xs">{x.who?.full_name}{x.completed_at && <div>{fmtDateTime(x.completed_at)}</div>}</td>
              <td className="text-right">{x.status !== 'completada' && perms.recordMeasurements && <Button variant="secondary" onClick={() => openTask(x)}>Ejecutar</Button>}</td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>}
      {tab === 'plans' && <Card>
        <CrudTable table="cleaning_plans" orderBy="name" canEdit={perms.manageQuality} defaults={{ active: true, frequency_days: 1, checklist: [], warehouse_id: warehouses[0]?.id, next_due: new Date().toISOString().slice(0, 10) }}
          transform={(f) => ({ ...f, location_id: f.location_id || null, responsible_id: f.responsible_id || null })}
          columns={[
            { key: 'warehouse_id', label: 'Almacén', type: 'select', required: true, options: warehouses.map((w) => ({ value: w.id, label: w.code })) },
            { key: 'location_id', label: 'Ubicación', type: 'select', options: locs.map((l) => ({ value: l.id, label: l.code })) },
            { key: 'name', label: 'Nombre', required: true }, { key: 'frequency_days', label: 'Frecuencia (días)', type: 'number', required: true },
            { key: 'next_due', label: 'Próxima', type: 'date', required: true, render: (r) => fmtDate(r.next_due) },
            { key: 'responsible_id', label: 'Responsable', type: 'custom', hideInTable: true, input: (v, set) => <UserSelect value={(v as string) ?? ''} onChange={set} /> },
            { key: 'checklist', label: 'Lista de comprobación (un punto por línea)', type: 'custom', required: true, render: (r) => `${r.checklist?.length ?? 0} puntos`,
              input: (v, set) => <Textarea rows={5} value={Array.isArray(v) ? v.join('\n') : ''} onChange={(e) => set(e.target.value.split('\n').map((x) => x.trimStart()).filter((x, i, a) => x || i === a.length - 1))} /> },
            { key: 'active', label: 'Activo', type: 'bool' },
          ]} />
      </Card>}
      <Modal open={!!task} title={`Ejecutar: ${task?.plan?.name}`} onClose={() => setTask(null)} footer={<><Button variant="secondary" onClick={() => setTask(null)}>Cancelar</Button>
        <Button icon={<Check className="h-4 w-4" />} onClick={async () => {
          try { await rpc('complete_cleaning_task', { p_task: task!.id, p_checks: Object.entries(checks).map(([item, v]) => ({ item, ok: v.ok, notes: v.notes || null })), p_notes: notes || null }); setTask(null); tasks.reload();
            t.ok(Object.values(checks).some((c) => !c.ok) ? 'Tarea registrada. Se abrió una incidencia por los puntos no conformes.' : 'Tarea completada.'); }
          catch (e) { t.fail(e); setTask(null); } }}>Registrar</Button></>}>
        <ul className="space-y-2">{Object.entries(checks).map(([item, v]) => (
          <li key={item} className="rounded-lg border border-slate-200 p-2">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{item}</span>
              <div className="flex gap-1">
                <button onClick={() => setChecks({ ...checks, [item]: { ...v, ok: true } })} className={`rounded px-2 py-1 text-xs ${v.ok ? 'bg-emerald-600 text-white' : 'bg-slate-100'}`}>Conforme</button>
                <button onClick={() => setChecks({ ...checks, [item]: { ...v, ok: false } })} className={`rounded px-2 py-1 text-xs ${!v.ok ? 'bg-red-600 text-white' : 'bg-slate-100'}`}>No conforme</button>
              </div></div>
            {!v.ok && <Input className="mt-2" placeholder="Describa el incumplimiento" value={v.notes} onChange={(e) => setChecks({ ...checks, [item]: { ...v, notes: e.target.value } })} />}
          </li>))}</ul>
        <Field label="Observaciones" className="mt-3"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

// ------------------------------ Incidencias ------------------------------
export function IncidentsPage() {
  const { perms } = useAuth();
  const [status, setStatus] = useState('abiertas');
  const { data, loading, error } = useAsync(() => {
    let q = supabase.from('incidents').select('*, warehouse:warehouses(code), reporter:profiles!incidents_reported_by_fkey(full_name)').order('reported_at', { ascending: false }).limit(500);
    if (status === 'abiertas') q = q.neq('status', 'cerrada'); else if (status) q = q.eq('status', status);
    return run(q);
  }, [status]);
  return (
    <div>
      <PageHeader title="Incidencias y acciones correctivas" actions={perms.reportIncidents && <Link to="/calidad/incidencias/nueva"><Button icon={<Plus className="h-4 w-4" />}>Reportar incidencia</Button></Link>} />
      <Alert>{error}</Alert>
      <Card>
        <div className="mb-3 max-w-xs"><Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'abiertas', label: 'Abiertas' }, { value: 'cerrada', label: 'Cerradas' }, { value: '', label: 'Todas' }]} /></div>
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Número</th><th>Título</th><th>Origen</th><th>Severidad</th><th>Estado</th><th>Almacén</th><th>Reportada</th></tr></thead>
            <tbody>{data.map((i) => <tr key={i.id}><td><Link className="font-medium text-brand-700 hover:underline" to={`/calidad/incidencias/${i.id}`}>{i.incident_number}</Link></td><td>{i.title}</td><td>{i.source_type}</td>
              <td><Badge status={i.severity} /></td><td><Badge status={i.status} /></td><td>{i.warehouse?.code ?? '—'}</td><td className="text-xs">{i.reporter?.full_name}<div>{fmtDateTime(i.reported_at)}</div></td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>
    </div>
  );
}

export function IncidentNew() {
  const nav = useNavigate();
  const { warehouses } = useAuth();
  const assets = useCatalog('assets');
  const mats = useCatalog('materials');
  const [f, setF] = useState<Row>({ title: '', description: '', severity: 'media', source_type: 'manual', warehouse_id: warehouses[0]?.id ?? '', location_id: '', asset_id: '', material_id: '' });
  const [err, setErr] = useState('');
  return (
    <div>
      <PageHeader title="Reportar incidencia" />
      <Alert>{err}</Alert>
      <Card>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Título *" className="md:col-span-3"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Descripción" className="md:col-span-3"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Severidad"><Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} options={['baja', 'media', 'alta', 'critica'].map((s) => ({ value: s, label: s }))} /></Field>
          <Field label="Origen"><Select value={f.source_type} onChange={(e) => setF({ ...f, source_type: e.target.value })} options={['manual', 'inventario', 'traslado', 'mantenimiento', 'inspeccion'].map((s) => ({ value: s, label: s }))} /></Field>
          <Field label="Almacén"><WarehouseSelect value={f.warehouse_id} onChange={(v) => setF({ ...f, warehouse_id: v, location_id: '' })} placeholder="—" /></Field>
          <Field label="Ubicación"><LocationSelect warehouseId={f.warehouse_id} value={f.location_id} onChange={(v) => setF({ ...f, location_id: v })} /></Field>
          <Field label="Activo"><Select value={f.asset_id} onChange={(e) => setF({ ...f, asset_id: e.target.value })} placeholder="—" options={assets.map((a) => ({ value: a.id, label: a.code }))} /></Field>
          <Field label="Material"><Select value={f.material_id} onChange={(e) => setF({ ...f, material_id: e.target.value })} placeholder="—" options={mats.map((m) => ({ value: m.id, label: m.sku }))} /></Field>
        </div>
        <div className="mt-4 flex justify-end"><Button onClick={async () => {
          try {
            if (!f.title.trim()) throw new Error('Indique el título.');
            const { data: u } = await supabase.auth.getUser();
            const r = await run(supabase.from('incidents').insert({ ...f, incident_number: '', reported_by: u.user!.id, warehouse_id: f.warehouse_id || null, location_id: f.location_id || null, asset_id: f.asset_id || null, material_id: f.material_id || null }).select('id').single()) as Row;
            nav(`/calidad/incidencias/${r.id}`, { replace: true });
          } catch (e) { setErr((e as Error).message); }
        }}>Registrar</Button></div>
      </Card>
    </div>
  );
}

export function IncidentDetail() {
  const { id } = useParams();
  const { perms, profile } = useAuth();
  const t = useToast();
  const inc = useAsync(() => run(supabase.from('incidents').select('*, warehouse:warehouses(code), location:locations(code), asset:assets(id,code), material:materials(id,sku), lot:lots(lot_code), reporter:profiles!incidents_reported_by_fkey(full_name), closer:profiles!incidents_closed_by_fkey(full_name)').eq('id', id!).single()), [id]);
  const acts = useAsync(() => run(supabase.from('corrective_actions').select('*, resp:profiles!corrective_actions_responsible_id_fkey(full_name), verifier:profiles!corrective_actions_verified_by_fkey(full_name)').eq('incident_id', id!).order('created_at')), [id]);
  const [tab, setTab] = useState('actions');
  const [na, setNa] = useState<Row | null>(null);
  const [closing, setClosing] = useState(false);
  const [rootCause, setRootCause] = useState('');
  const [closeNotes, setCloseNotes] = useState('');
  if (inc.loading) return <Spinner />;
  const i = inc.data;
  if (!i) return <Empty>Incidencia no encontrada o sin acceso.</Empty>;
  const open = i.status !== 'cerrada';
  const updAction = async (a: Row, patch: Row) => { try { await run(supabase.from('corrective_actions').update(patch).eq('id', a.id)); acts.reload(); } catch (e) { t.fail(e); } };
  return (
    <div>
      <PageHeader title={<>{i.incident_number} <Badge status={i.status} /></>} subtitle={i.title}
        actions={open && perms.manageQuality && <>
          {i.status === 'abierta' && <Button variant="secondary" onClick={async () => { await supabase.from('incidents').update({ status: 'en_proceso' }).eq('id', i.id); inc.reload(); }}>En proceso</Button>}
          <Button variant="success" onClick={() => setClosing(true)}>Cerrar incidencia</Button>
        </>} />
      {t.node}
      <Card className="mb-4"><KV items={[['Severidad', <Badge status={i.severity} />], ['Origen', i.source_type], ['Almacén', i.warehouse?.code], ['Ubicación', i.location?.code],
        ['Activo', i.asset ? <Link className="text-brand-700" to={`/activos/${i.asset.id}`}>{i.asset.code}</Link> : '—'], ['Material', i.material ? <Link className="text-brand-700" to={`/materiales/${i.material.id}`}>{i.material.sku}</Link> : '—'],
        ['Lote', i.lot?.lot_code], ['Reportada', `${i.reporter?.full_name ?? ''} · ${fmtDateTime(i.reported_at)}`], ['Descripción', i.description],
        ['Causa raíz', i.root_cause], ['Cierre', i.closed_at ? `${i.closer?.full_name} · ${fmtDateTime(i.closed_at)} · ${i.closing_notes}` : '—']]} /></Card>
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'actions', label: 'Acciones correctivas' }, { key: 'docs', label: 'Evidencias' }, { key: 'notes', label: 'Observaciones' }]} />
      {tab === 'actions' && <Card actions={open && (perms.manageQuality || perms.manageMaintenance) && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setNa({ description: '', responsible_id: '', due_date: '' })}>Acción</Button>}>
        {!acts.data?.length ? <Empty>Sin acciones correctivas.</Empty> : (
          <TableWrap><table className="table"><thead><tr><th>Acción</th><th>Responsable</th><th>Plazo</th><th>Estado</th><th>Verificación</th><th /></tr></thead>
            <tbody>{acts.data.map((a) => <tr key={a.id}><td>{a.description}</td><td>{a.resp?.full_name ?? '—'}</td><td>{fmtDate(a.due_date)}</td><td><Badge status={a.status} /></td><td className="text-xs">{a.verifier?.full_name ?? '—'}</td>
              <td className="whitespace-nowrap text-right">
                {open && ['pendiente', 'en_proceso'].includes(a.status) && (a.responsible_id === profile?.id || perms.manageQuality) && <Button variant="secondary" onClick={() => updAction(a, { status: 'completada', completed_at: new Date().toISOString() })}>Completar</Button>}
                {open && a.status === 'completada' && perms.manageQuality && a.responsible_id !== profile?.id && <Button variant="secondary" onClick={() => updAction(a, { status: 'verificada', verified_by: profile!.id })}>Verificar</Button>}
              </td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>}
      {tab === 'docs' && <Card><DocumentsPanel entityType="incident" entityId={i.id} /></Card>}
      {tab === 'notes' && <Card><NotesPanel entityType="incident" entityId={i.id} /></Card>}
      <Modal open={!!na} title="Nueva acción correctiva" onClose={() => setNa(null)} footer={<><Button variant="secondary" onClick={() => setNa(null)}>Cancelar</Button>
        <Button onClick={async () => { try { await run(supabase.from('corrective_actions').insert({ incident_id: i.id, description: na!.description, responsible_id: na!.responsible_id || null, due_date: na!.due_date || null })); setNa(null); acts.reload(); } catch (e) { t.fail(e); } }}>Guardar</Button></>}>
        {na && <div className="space-y-3">
          <Field label="Descripción"><Textarea value={na.description} onChange={(e) => setNa({ ...na, description: e.target.value })} /></Field>
          <Field label="Responsable"><UserSelect value={na.responsible_id} onChange={(v) => setNa({ ...na, responsible_id: v })} /></Field>
          <Field label="Plazo"><Input type="date" value={na.due_date} onChange={(e) => setNa({ ...na, due_date: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={closing} title="Cerrar incidencia" onClose={() => setClosing(false)} footer={<><Button variant="secondary" onClick={() => setClosing(false)}>Cancelar</Button>
        <Button variant="success" disabled={closeNotes.trim().length < 3} onClick={async () => {
          try { await rpc('close_incident', { p_id: i.id, p_notes: closeNotes, p_root_cause: rootCause || null }); setClosing(false); inc.reload(); } catch (e) { t.fail(e); setClosing(false); } }}>Cerrar</Button></>}>
        <div className="space-y-3">
          <Field label="Causa raíz"><Textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} /></Field>
          <Field label="Notas de cierre *"><Textarea value={closeNotes} onChange={(e) => setCloseNotes(e.target.value)} /></Field>
          <p className="text-xs text-slate-500">Todas las acciones correctivas deben estar completadas o verificadas.</p>
        </div>
      </Modal>
    </div>
  );
}
