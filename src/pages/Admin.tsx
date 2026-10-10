import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, UserPlus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { invalidateCatalog } from '../lib/catalogs';
import { fmtBOB, fmtDate, fmtDateTime, ROLE_LABEL } from '../lib/format';
import { downloadCSV } from '../lib/csv';
import { Alert, Badge, Button, Card, Empty, Field, Input, KV, Modal, PageHeader, Select, Spinner, TableWrap, Tabs, Textarea, useToast } from '../components/ui';
import { DOC_CATEGORIES, openDocument } from '../components/DocumentsPanel';
import { InTransit, KardexReport } from './Stock';

const ROLES = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }));

/** Llama a la función de servidor (Netlify) con el token del usuario actual. */
async function adminApi(body: Row) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/.netlify/functions/admin-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'La función de administración no respondió. ¿Está desplegada en Netlify?');
  return json;
}

// ------------------------------ Usuarios ------------------------------
export function UsersPage() {
  const { profile } = useAuth();
  const t = useToast();
  const users = useAsync(() => run(supabase.from('profiles').select('*').order('full_name')), []);
  const access = useAsync(() => run(supabase.from('user_warehouse_access').select('*')), []);
  const whs = useAsync(() => run(supabase.from('warehouses').select('*').order('code')), []);
  const [invite, setInvite] = useState<Row | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const accessOf = (uid: string) => (access.data ?? []).filter((a) => a.user_id === uid).map((a) => a.warehouse_id);

  const saveEdit = async () => {
    setBusy(true);
    try {
      const u = (users.data ?? []).find((x) => x.id === edit!.id)!;
      if (u.role !== edit!.role || u.active !== edit!.active || u.full_name !== edit!.full_name) {
        await adminApi({ action: 'update', user_id: edit!.id, role: edit!.role, active: edit!.active, full_name: edit!.full_name });
      }
      const before = new Set(accessOf(edit!.id));
      const after = new Set<string>(edit!.warehouses);
      const add = [...after].filter((w) => !before.has(w)).map((w) => ({ user_id: edit!.id, warehouse_id: w }));
      const del = [...before].filter((w) => !after.has(w));
      if (add.length) await run(supabase.from('user_warehouse_access').insert(add));
      if (del.length) await run(supabase.from('user_warehouse_access').delete().eq('user_id', edit!.id).in('warehouse_id', del));
      setEdit(null); users.reload(); access.reload(); invalidateCatalog('profiles'); t.ok('Usuario actualizado.');
    } catch (e) { t.fail(e); } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="Usuarios, roles y permisos" subtitle="Altas y cambios de rol se hacen en el servidor (función segura). Ningún usuario puede elevar sus propios privilegios."
        actions={<Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setInvite({ email: '', full_name: '', role: 'operador', warehouses: [], mode: 'invite', password: '' })}>Invitar usuario</Button>} />
      {t.node}
      <Card padded={false}>
        {users.loading ? <Spinner /> : (
          <TableWrap><table className="table"><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Almacenes</th><th>Estado</th><th /></tr></thead>
            <tbody>{(users.data ?? []).map((u) => (
              <tr key={u.id}><td className="font-medium">{u.full_name || '—'}</td><td>{u.email}</td><td>{ROLE_LABEL[u.role]}</td>
                <td className="text-xs">{u.role === 'admin' ? 'Todos' : accessOf(u.id).map((w) => (whs.data ?? []).find((x) => x.id === w)?.code).join(', ') || <span className="text-amber-600">ninguno</span>}</td>
                <td><Badge tone={u.active ? 'green' : 'slate'}>{u.active ? 'Activo' : 'Inactivo'}</Badge></td>
                <td className="text-right"><Button variant="secondary" onClick={() => setEdit({ ...u, warehouses: accessOf(u.id) })}>Editar</Button></td></tr>))}
            </tbody></table></TableWrap>
        )}
      </Card>

      <Modal open={!!invite} title="Invitar usuario" onClose={() => setInvite(null)} footer={<><Button variant="secondary" onClick={() => setInvite(null)}>Cancelar</Button>
        <Button loading={busy} onClick={async () => {
          setBusy(true);
          try {
            await adminApi({ action: invite!.mode === 'invite' ? 'invite' : 'create', email: invite!.email, full_name: invite!.full_name, role: invite!.role, warehouse_ids: invite!.warehouses, password: invite!.mode === 'create' ? invite!.password : undefined });
            setInvite(null); users.reload(); access.reload(); invalidateCatalog('profiles');
            t.ok(invite!.mode === 'invite' ? 'Invitación enviada por correo.' : 'Usuario creado.');
          } catch (e) { t.fail(e); setInvite(null); } finally { setBusy(false); }
        }}>{invite?.mode === 'invite' ? 'Enviar invitación' : 'Crear usuario'}</Button></>}>
        {invite && <div className="space-y-3">
          <Field label="Correo"><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
          <Field label="Nombre completo"><Input value={invite.full_name} onChange={(e) => setInvite({ ...invite, full_name: e.target.value })} /></Field>
          <Field label="Rol"><Select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} options={ROLES} /></Field>
          <WarehouseChecks all={whs.data ?? []} value={invite.warehouses} onChange={(v) => setInvite({ ...invite, warehouses: v })} disabled={invite.role === 'admin'} />
          <Field label="Método">
            <Select value={invite.mode} onChange={(e) => setInvite({ ...invite, mode: e.target.value })} options={[{ value: 'invite', label: 'Enviar invitación por correo (Supabase Auth)' }, { value: 'create', label: 'Crear con contraseña temporal' }]} />
          </Field>
          {invite.mode === 'create' && <Field label="Contraseña temporal (mín. 10)" hint="Entréguela de forma segura; el usuario debe cambiarla en Mi perfil."><Input value={invite.password} onChange={(e) => setInvite({ ...invite, password: e.target.value })} /></Field>}
        </div>}
      </Modal>

      <Modal open={!!edit} title={`Editar ${edit?.email}`} onClose={() => setEdit(null)} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button loading={busy} onClick={saveEdit}>Guardar</Button></>}>
        {edit && <div className="space-y-3">
          <Field label="Nombre"><Input value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} /></Field>
          <Field label="Rol"><Select disabled={edit.id === profile?.id} value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} options={ROLES} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={edit.id === profile?.id} checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Activo (desactivar bloquea el acceso)</label>
          <WarehouseChecks all={whs.data ?? []} value={edit.warehouses} onChange={(v) => setEdit({ ...edit, warehouses: v })} disabled={edit.role === 'admin'} />
          {edit.id === profile?.id && <p className="text-xs text-slate-500">No puede cambiar su propio rol ni desactivarse.</p>}
        </div>}
      </Modal>
    </div>
  );
}

function WarehouseChecks({ all, value, onChange, disabled }: { all: Row[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div>
      <span className="label">Almacenes autorizados</span>
      {disabled ? <p className="text-sm text-slate-500">El administrador accede a todos.</p> : (
        <div className="grid grid-cols-2 gap-1">{all.map((w) => (
          <label key={w.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.includes(w.id)} onChange={(e) => onChange(e.target.checked ? [...value, w.id] : value.filter((x) => x !== w.id))} />{w.code} — {w.name}</label>
        ))}</div>
      )}
    </div>
  );
}

// ------------------------------ Configuración ------------------------------
export function SettingsPage() {
  const { profile } = useAuth();
  const t = useToast();
  const [tab, setTab] = useState('company');
  const settings = useAsync(() => run(supabase.from('company_settings').select('*').eq('id', 1).single()), []);
  const methods = useAsync(() => run(supabase.from('valuation_methods').select('*, req:profiles!valuation_methods_requested_by_fkey(full_name), app:profiles!valuation_methods_approved_by_fkey(full_name)').order('effective_from', { ascending: false })), []);
  const reqs = useAsync(() => run(supabase.from('valuation_change_requests').select('*, requester:profiles!valuation_change_requests_requested_by_fkey(full_name), decider:profiles!valuation_change_requests_decided_by_fkey(full_name)').order('requested_at', { ascending: false })), []);
  const periods = useAsync(() => run(supabase.from('accounting_periods').select('*').order('period', { ascending: false })), []);
  const [s, setS] = useState<Row | null>(null);
  const [vr, setVr] = useState<Row | null>(null);
  const [period, setPeriod] = useState('');
  if (settings.data && !s) setS(settings.data);
  const current = methods.data?.[0]?.method;
  return (
    <div>
      <PageHeader title="Configuración de la empresa" />
      {t.node}
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'company', label: 'Empresa' }, { key: 'valuation', label: 'Valoración' }, { key: 'periods', label: 'Períodos' }]} />
      {tab === 'company' && s && <Card>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Razón social"><Input value={s.company_name ?? ''} onChange={(e) => setS({ ...s, company_name: e.target.value })} /></Field>
          <Field label="NIT"><Input value={s.tax_id ?? ''} onChange={(e) => setS({ ...s, tax_id: e.target.value })} /></Field>
          <Field label="Dirección" className="md:col-span-2"><Input value={s.address ?? ''} onChange={(e) => setS({ ...s, address: e.target.value })} /></Field>
          <Field label="Moneda base"><Input value="BOB — Boliviano" disabled /></Field>
          <Field label="Alerta de vencimiento por defecto (días)"><Input type="number" min={0} value={s.default_expiry_alert_days} onChange={(e) => setS({ ...s, default_expiry_alert_days: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={async () => { try { const r = await rpc<Row>('generate_alerts', { p_force: true }); t.ok('Alertas generadas: ' + Object.entries(r).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')); } catch (e) { t.fail(e); } }}>Generar alertas ahora</Button>
          <Button onClick={async () => { try { await run(supabase.from('company_settings').update({ company_name: s.company_name, tax_id: s.tax_id, address: s.address, default_expiry_alert_days: Number(s.default_expiry_alert_days) }).eq('id', 1)); t.ok('Guardado.'); } catch (e) { t.fail(e); } }}>Guardar</Button>
        </div>
      </Card>}
      {tab === 'valuation' && <div className="space-y-4">
        <Card title="Método global de valoración" actions={<Button onClick={() => setVr({ to_method: current === 'fifo' ? 'promedio' : 'fifo', effective_date: new Date().toISOString().slice(0, 10), reason: '' })}>Solicitar cambio</Button>}>
          <KV items={[['Método activo', <b>{current === 'fifo' ? 'FIFO (primero en entrar, primero en salir)' : 'Promedio ponderado'}</b>], ['Vigente desde', fmtDateTime(methods.data?.[0]?.effective_from)]]} />
          <Alert kind="info">El cambio requiere la aprobación de <b>otro administrador</b>. Se aplica desde la fecha de vigencia sin modificar costos históricos: cada movimiento conserva el costo y el método con que se valorizó. Al aplicarse se guarda una foto de reconciliación por material. Valide el tratamiento contable con su responsable financiero.</Alert>
        </Card>
        <Card title="Solicitudes" padded={false}>
          {!reqs.data?.length ? <Empty /> : <TableWrap><table className="table"><thead><tr><th>Nuevo método</th><th>Vigencia</th><th>Motivo</th><th>Solicitó</th><th>Estado</th><th>Decidió</th><th /></tr></thead>
            <tbody>{reqs.data.map((r) => <tr key={r.id}><td>{r.to_method}</td><td>{fmtDate(r.effective_date)}</td><td className="max-w-xs text-xs">{r.reason}</td><td className="text-xs">{r.requester?.full_name}<div>{fmtDateTime(r.requested_at)}</div></td>
              <td><Badge status={r.status} /></td><td className="text-xs">{r.decider?.full_name ?? '—'}{r.decision_notes && <div>{r.decision_notes}</div>}</td>
              <td className="whitespace-nowrap text-right">{r.status === 'pendiente' && r.requested_by !== profile?.id && <>
                <Button variant="success" onClick={async () => { try { await rpc('decide_valuation_change', { p_id: r.id, p_approve: true, p_notes: 'Aprobado' }); reqs.reload(); methods.reload(); t.ok('Cambio aprobado.'); } catch (e) { t.fail(e); } }}>Aprobar</Button>
                <Button variant="ghost" onClick={async () => { try { await rpc('decide_valuation_change', { p_id: r.id, p_approve: false, p_notes: 'Rechazado' }); reqs.reload(); } catch (e) { t.fail(e); } }}>Rechazar</Button></>}
                {['pendiente', 'aprobada'].includes(r.status) && <Button variant="ghost" onClick={async () => { try { await rpc('cancel_valuation_change', { p_id: r.id }); reqs.reload(); } catch (e) { t.fail(e); } }}>Anular</Button>}
                {r.status === 'aplicada' && <ReconciliationLink id={r.id} />}
              </td></tr>)}</tbody></table></TableWrap>}
        </Card>
        <Card title="Historial de métodos" padded={false}>
          <TableWrap><table className="table"><thead><tr><th>Método</th><th>Desde</th><th>Solicitó</th><th>Aprobó</th></tr></thead>
            <tbody>{(methods.data ?? []).map((m) => <tr key={m.id}><td>{m.method}</td><td>{fmtDateTime(m.effective_from)}</td><td>{m.req?.full_name ?? 'Configuración inicial'}</td><td>{m.app?.full_name ?? '—'}</td></tr>)}</tbody></table></TableWrap>
        </Card>
      </div>}
      {tab === 'periods' && <Card title="Cierre de períodos mensuales">
        <p className="mb-3 text-sm text-slate-500">Un período cerrado no admite movimientos con fecha en ese mes. Solo se cierran meses terminados.</p>
        <div className="mb-4 flex max-w-md gap-2"><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <Button disabled={!period} onClick={async () => { try { await rpc('close_period', { p_period: period + '-01' }); periods.reload(); t.ok('Período cerrado.'); } catch (e) { t.fail(e); } }}>Cerrar período</Button></div>
        {!periods.data?.length ? <Empty>No hay períodos cerrados.</Empty> : <TableWrap><table className="table"><thead><tr><th>Período</th><th>Estado</th><th>Cerrado</th><th>Notas</th><th /></tr></thead>
          <tbody>{periods.data.map((p) => <tr key={p.period}><td>{p.period.slice(0, 7)}</td><td><Badge status={p.status === 'cerrado' ? 'cerrado' : 'abierto'} /></td><td className="text-xs">{fmtDateTime(p.closed_at)}</td><td className="text-xs">{p.notes}</td>
            <td className="text-right">{p.status === 'cerrado' && <Button variant="ghost" onClick={async () => { const r = prompt('Justificación de la reapertura (mín. 10 caracteres):'); if (!r) return; try { await rpc('reopen_period', { p_period: p.period, p_reason: r }); periods.reload(); } catch (e) { t.fail(e); } }}>Reabrir</Button>}</td></tr>)}</tbody></table></TableWrap>}
      </Card>}
      <Modal open={!!vr} title="Solicitar cambio de método de valoración" onClose={() => setVr(null)} footer={<><Button variant="secondary" onClick={() => setVr(null)}>Cancelar</Button>
        <Button disabled={(vr?.reason ?? '').trim().length < 10} onClick={async () => { try { await rpc('request_valuation_change', { p_to: vr!.to_method, p_effective: vr!.effective_date, p_reason: vr!.reason }); setVr(null); reqs.reload(); t.ok('Solicitud registrada. Otro administrador debe aprobarla.'); } catch (e) { t.fail(e); setVr(null); } }}>Solicitar</Button></>}>
        {vr && <div className="space-y-3">
          <Field label="Nuevo método"><Select value={vr.to_method} onChange={(e) => setVr({ ...vr, to_method: e.target.value })} options={[{ value: 'promedio', label: 'Promedio ponderado' }, { value: 'fifo', label: 'FIFO' }].filter((o) => o.value !== current)} /></Field>
          <Field label="Fecha de vigencia"><Input type="date" min={new Date().toISOString().slice(0, 10)} value={vr.effective_date} onChange={(e) => setVr({ ...vr, effective_date: e.target.value })} /></Field>
          <Field label="Justificación (mín. 10 caracteres)"><Textarea value={vr.reason} onChange={(e) => setVr({ ...vr, reason: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}

function ReconciliationLink({ id }: { id: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  return <>
    <Button variant="ghost" onClick={async () => setRows(await run(supabase.from('valuation_change_snapshots').select('*, material:materials(sku,name)').eq('request_id', id)) as Row[])}>Reconciliación</Button>
    <Modal open={!!rows} wide title="Reconciliación del cambio de método" onClose={() => setRows(null)}>
      <TableWrap><table className="table"><thead><tr><th>Material</th><th className="num">Cantidad</th><th className="num">Valor antes</th><th className="num">Valor después</th><th className="num">Costo unit.</th></tr></thead>
        <tbody>{(rows ?? []).map((r) => <tr key={r.id}><td>{r.material?.sku}</td><td className="num">{r.qty}</td><td className="num">{fmtBOB(r.value_before)}</td><td className="num">{fmtBOB(r.value_after)}</td><td className="num">{fmtBOB(r.unit_cost_after)}</td></tr>)}</tbody></table></TableWrap>
    </Modal>
  </>;
}

// ------------------------------ Auditoría ------------------------------
export function AuditPage() {
  const [table, setTable] = useState('');
  const [from, setFrom] = useState(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [sel, setSel] = useState<Row | null>(null);
  const users = useAsync(() => run(supabase.from('profiles').select('id,full_name,email')), []);
  const { data, loading } = useAsync(() => {
    let q = supabase.from('audit_logs').select('*').gte('at', from).order('at', { ascending: false }).limit(1000);
    if (table) q = q.eq('table_name', table);
    return run(q);
  }, [table, from]);
  const name = (id: string) => (users.data ?? []).find((u) => u.id === id)?.full_name ?? (id ? id.slice(0, 8) : 'sistema');
  const tables = useMemo(() => [...new Set((data ?? []).map((r) => r.table_name).filter(Boolean))].sort(), [data]);
  return (
    <div>
      <PageHeader title="Auditoría" subtitle="Registro inmutable de cambios y acciones críticas." />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Select className="max-w-xs" value={table} onChange={(e) => setTable(e.target.value)} placeholder="Todas las tablas" options={tables.map((t) => ({ value: t, label: t }))} />
          <Input className="max-w-[180px]" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => downloadCSV('auditoria', (data ?? []).map((r) => ({ ...r, user: name(r.user_id), old_data: JSON.stringify(r.old_data), new_data: JSON.stringify(r.new_data), context: JSON.stringify(r.context) })),
            [{ key: 'at', label: 'Fecha' }, { key: 'user', label: 'Usuario' }, { key: 'action', label: 'Acción' }, { key: 'table_name', label: 'Tabla' }, { key: 'record_id', label: 'Registro' }, { key: 'context', label: 'Contexto' }, { key: 'old_data', label: 'Antes' }, { key: 'new_data', label: 'Después' }])}>CSV</Button>
        </div>
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Tabla</th><th>Registro</th><th /></tr></thead>
            <tbody>{data.map((r) => <tr key={r.id}><td className="whitespace-nowrap text-xs">{fmtDateTime(r.at)}</td><td>{name(r.user_id)}</td><td><Badge tone={r.action === 'delete' ? 'red' : r.action === 'insert' ? 'green' : 'blue'}>{r.action}</Badge></td>
              <td>{r.table_name}</td><td className="font-mono text-xs">{r.record_id?.slice(0, 8)}</td><td className="text-right"><Button variant="ghost" onClick={() => setSel(r)}>Ver</Button></td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>
      <Modal open={!!sel} wide title="Detalle de auditoría" onClose={() => setSel(null)}>
        {sel && <AuditDiff row={sel} />}
      </Modal>
    </div>
  );
}

function AuditDiff({ row }: { row: Row }) {
  const keys = [...new Set([...Object.keys(row.old_data ?? {}), ...Object.keys(row.new_data ?? {})])];
  const changed = keys.filter((k) => JSON.stringify(row.old_data?.[k]) !== JSON.stringify(row.new_data?.[k]));
  return (
    <div className="space-y-3 text-sm">
      {row.context && <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(row.context, null, 2)}</pre>}
      {keys.length > 0 && <table className="table"><thead><tr><th>Campo</th><th>Antes</th><th>Después</th></tr></thead>
        <tbody>{(row.action === 'update' ? changed : keys).map((k) => <tr key={k}><td className="font-mono text-xs">{k}</td><td className="break-all text-xs text-red-700">{JSON.stringify(row.old_data?.[k]) ?? ''}</td><td className="break-all text-xs text-emerald-700">{JSON.stringify(row.new_data?.[k]) ?? ''}</td></tr>)}</tbody></table>}
    </div>
  );
}

// ------------------------------ Documentos ------------------------------
export function DocumentsPage() {
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const { data, loading } = useAsync(() => {
    let x = supabase.from('documents').select('*, material:materials(id,sku), lot:lots(lot_code), asset:assets(id,code), wo:work_orders(id,wo_number), incident:incidents(id,incident_number)').eq('status', 'vigente').order('uploaded_at', { ascending: false }).limit(1000);
    if (cat) x = x.eq('doc_category', cat);
    return run(x);
  }, [cat]);
  const rows = (data ?? []).filter((d) => !q || [d.title, d.file_name, d.material?.sku, d.asset?.code].some((v) => v?.toLowerCase().includes(q.toLowerCase())));
  const link = (d: Row) => d.material ? <Link className="text-brand-700" to={`/materiales/${d.material.id}`}>Material {d.material.sku}</Link>
    : d.asset ? <Link className="text-brand-700" to={`/activos/${d.asset.id}`}>Activo {d.asset.code}</Link>
    : d.wo ? <Link className="text-brand-700" to={`/mantenimiento/ordenes/${d.wo.id}`}>OT {d.wo.wo_number}</Link>
    : d.incident ? <Link className="text-brand-700" to={`/calidad/incidencias/${d.incident.id}`}>Incidencia {d.incident.incident_number}</Link>
    : d.lot ? <Link className="text-brand-700" to={`/lotes?lot=${d.lot_id}`}>Lote {d.lot.lot_code}</Link> : '—';
  return (
    <div>
      <PageHeader title="Documentos técnicos" subtitle="Archivos privados. Se descargan con enlaces temporales de 60 segundos. Para subir, ingrese al registro correspondiente." />
      <Alert>{err}</Alert>
      <Card>
        <div className="mb-3 grid gap-2 md:grid-cols-3"><Select value={cat} onChange={(e) => setCat(e.target.value)} placeholder="Todos los tipos" options={DOC_CATEGORIES} /><Input placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {loading ? <Spinner /> : !rows.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Título</th><th>Tipo</th><th>Asociado a</th><th>Versión</th><th>Fecha</th><th /></tr></thead>
            <tbody>{rows.map((d) => <tr key={d.id}><td className="font-medium">{d.title}<div className="text-xs text-slate-400">{d.file_name}</div></td><td>{DOC_CATEGORIES.find((c) => c.value === d.doc_category)?.label}</td>
              <td>{link(d)}</td><td>v{d.version}</td><td className="text-xs">{fmtDateTime(d.uploaded_at)}</td>
              <td className="text-right"><Button variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => openDocument(d.storage_path).catch((e) => setErr(e.message))} /></td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>
    </div>
  );
}

// ------------------------------ Informes ------------------------------
export function ReportsPage() {
  const { perms } = useAuth();
  const [tab, setTab] = useState(perms.viewCosts ? 'valuation' : 'kardex');
  return (
    <div>
      <PageHeader title="Informes" subtitle="Todos los informes respetan sus permisos y almacenes autorizados. Exportables a CSV." />
      <Tabs active={tab} onChange={setTab} tabs={[
        ...(perms.viewCosts ? [{ key: 'valuation', label: 'Valoración' }] : []), { key: 'kardex', label: 'Kardex / movimientos' }, { key: 'expiry', label: 'Vencimientos' },
        { key: 'transit', label: 'En tránsito' }, { key: 'low', label: 'Bajo mínimo' }, { key: 'maint', label: 'Costos de mantenimiento' }]} />
      {tab === 'valuation' && <ValuationReport />}
      {tab === 'kardex' && <Card><KardexReport /></Card>}
      {tab === 'expiry' && <ExpiryReport />}
      {tab === 'transit' && <InTransit />}
      {tab === 'low' && <LowStockReport />}
      {tab === 'maint' && <MaintenanceCostReport />}
    </div>
  );
}

function ValuationReport() {
  const { data, loading } = useAsync(() => run(supabase.from('v_valuation').select('*').gt('qty', 0).order('sku')), []);
  const method = useAsync(() => run(supabase.from('valuation_methods').select('method').order('effective_from', { ascending: false }).limit(1)), []);
  const total = (data ?? []).reduce((s, r) => s + Number(r.value), 0);
  const cols = [{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Material' }, { key: 'category', label: 'Categoría' }, { key: 'qty', label: 'Cantidad (incluye tránsito)' }, { key: 'unit_cost', label: 'Costo unitario BOB' }, { key: 'value', label: 'Valor BOB' }];
  return (
    <Card title={<>Valor del inventario: {fmtBOB(total)} <span className="ml-2 text-xs font-normal text-slate-500">Método: {method.data?.[0]?.method === 'fifo' ? 'FIFO' : 'Promedio ponderado'}</span></>}
      actions={<Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => downloadCSV('valoracion', data ?? [], cols)}>CSV</Button>} padded={false}>
      {loading ? <Spinner /> : !data?.length ? <Empty /> : (
        <TableWrap><table className="table"><thead><tr><th>SKU</th><th>Material</th><th>Categoría</th><th className="num">Cantidad</th><th className="num">Costo unit.</th><th className="num">Valor</th></tr></thead>
          <tbody>{data.map((r) => <tr key={r.material_id}><td>{r.sku}</td><td>{r.name}</td><td>{r.category ?? '—'}</td><td className="num">{r.qty}</td><td className="num">{fmtBOB(r.unit_cost)}</td><td className="num font-medium">{fmtBOB(r.value)}</td></tr>)}</tbody></table></TableWrap>
      )}
    </Card>
  );
}

function ExpiryReport() {
  const [days, setDays] = useState(60);
  const { data, loading } = useAsync(() => run(supabase.from('v_stock').select('*').not('exp_date', 'is', null).lte('exp_date', new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)).order('exp_date')), [days]);
  const cols = [{ key: 'sku', label: 'SKU' }, { key: 'material_name', label: 'Material' }, { key: 'lot_code', label: 'Lote' }, { key: 'exp_date', label: 'Vence' }, { key: 'warehouse_code', label: 'Almacén' }, { key: 'location_code', label: 'Ubicación' }, { key: 'qty_on_hand', label: 'Cantidad' }];
  return (
    <Card actions={<><Select className="w-44" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} options={[0, 15, 30, 60, 90, 180].map((d) => ({ value: String(d), label: d === 0 ? 'Solo vencidos' : `Próximos ${d} días` }))} />
      <Button variant="secondary" onClick={() => downloadCSV('vencimientos', data ?? [], cols)}>CSV</Button></>} padded={false}>
      {loading ? <Spinner /> : !data?.length ? <Empty>Sin lotes en el rango.</Empty> : (
        <TableWrap><table className="table"><thead><tr><th>Material</th><th>Lote</th><th>Vence</th><th>Almacén / ubicación</th><th className="num">Cantidad</th><th>Estado</th></tr></thead>
          <tbody>{data.map((r) => <tr key={r.id}><td>{r.sku}<div className="text-xs text-slate-400">{r.material_name}</div></td><td>{r.lot_code}</td><td className={r.exp_date < new Date().toISOString().slice(0, 10) ? 'font-semibold text-red-600' : ''}>{fmtDate(r.exp_date)}</td>
            <td>{r.warehouse_code}{r.location_code && ` / ${r.location_code}`}</td><td className="num">{r.qty_on_hand}</td><td><Badge status={r.lot_status} /></td></tr>)}</tbody></table></TableWrap>
      )}
    </Card>
  );
}

function LowStockReport() {
  const { data, loading } = useAsync(async () => {
    const mats = await run(supabase.from('materials').select('id,sku,name,min_stock').eq('active', true).gt('min_stock', 0)) as Row[];
    const st = await run(supabase.from('v_stock').select('material_id,qty_available,qty_on_hand')) as Row[];
    return mats.map((m): Row => ({ ...m, on_hand: st.filter((s) => s.material_id === m.id).reduce((a, s) => a + Number(s.qty_on_hand), 0), available: st.filter((s) => s.material_id === m.id).reduce((a, s) => a + Number(s.qty_available), 0) }))
      .filter((m) => m.on_hand < Number(m.min_stock));
  }, []);
  return (
    <Card padded={false}>
      {loading ? <Spinner /> : !data?.length ? <Empty>Ningún material bajo el mínimo (en sus almacenes).</Empty> : (
        <TableWrap><table className="table"><thead><tr><th>Material</th><th className="num">Mínimo</th><th className="num">En mano</th><th className="num">Disponible</th></tr></thead>
          <tbody>{data.map((m) => <tr key={m.id}><td><Link className="text-brand-700" to={`/materiales/${m.id}`}>{m.sku}</Link> {m.name}</td><td className="num">{m.min_stock}</td><td className="num text-red-600">{m.on_hand}</td><td className="num">{m.available}</td></tr>)}</tbody></table></TableWrap>
      )}
    </Card>
  );
}

function MaintenanceCostReport() {
  const [from, setFrom] = useState(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10));
  const { data, loading } = useAsync(() => run(supabase.from('v_work_order_costs').select('*').gte('created_at', from).order('created_at', { ascending: false })), [from]);
  const byAsset = useMemo(() => {
    const m = new Map<string, Row>();
    (data ?? []).forEach((w) => { const c = m.get(w.asset_id) ?? { asset_code: w.asset_code, asset_name: w.asset_name, count: 0, total: 0, materials: 0 }; c.count++; c.total += Number(w.total_cost); c.materials += Number(w.materials_cost); m.set(w.asset_id, c); });
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [data]);
  return (
    <Card actions={<><Input type="date" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} />
      <Button variant="secondary" onClick={() => downloadCSV('costos_mantenimiento', data ?? [], [{ key: 'wo_number', label: 'OT' }, { key: 'asset_code', label: 'Activo' }, { key: 'wo_type', label: 'Tipo' }, { key: 'status', label: 'Estado' }, { key: 'labor_cost', label: 'Mano de obra' }, { key: 'external_cost', label: 'Externos' }, { key: 'materials_cost', label: 'Materiales' }, { key: 'total_cost', label: 'Total' }])}>CSV</Button></>} padded={false}>
      {loading ? <Spinner /> : !byAsset.length ? <Empty /> : (
        <TableWrap><table className="table"><thead><tr><th>Activo</th><th className="num">OT</th><th className="num">Materiales</th><th className="num">Total</th></tr></thead>
          <tbody>{byAsset.map((a) => <tr key={a.asset_code}><td>{a.asset_code} — {a.asset_name}</td><td className="num">{a.count}</td><td className="num">{fmtBOB(a.materials)}</td><td className="num font-medium">{fmtBOB(a.total)}</td></tr>)}</tbody></table></TableWrap>
      )}
    </Card>
  );
}
