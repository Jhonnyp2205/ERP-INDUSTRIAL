import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, PackageCheck, Plus, Send, Trash2, Truck, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { newKey, rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth, useCanApproveIn } from '../lib/auth';
import { lookupCode, useCatalog } from '../lib/catalogs';
import { fmtDate, fmtDateTime, fmtQty } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, KV, Modal, PageHeader, ReasonDialog, Select, Spinner, TableWrap, Tabs, Textarea, useToast } from '../components/ui';
import { LocationSelect, LotSelect, MaterialSelect, UnitSelect, WarehouseSelect } from '../components/Pickers';
import { ScanInput } from '../components/Scanner';
import NotesPanel from '../components/NotesPanel';

const STEPS = ['borrador', 'pendiente', 'aprobado', 'preparado', 'en_transito', 'recibido_parcial', 'con_diferencias', 'recibido', 'cerrado'];
const STEP_LABEL: Record<string, string> = { borrador: 'Creado', pendiente: 'Por aprobar', aprobado: 'Aprobado', preparado: 'Cargado', en_transito: 'En tránsito', recibido_parcial: 'Recepción parcial', con_diferencias: 'Diferencias', recibido: 'Recibido', cerrado: 'Cerrado' };

export function TransfersPage() {
  const { perms } = useAuth();
  const [status, setStatus] = useState('');
  const { data, loading, error } = useAsync(() => {
    let q = supabase.from('warehouse_transfers').select('*, origin:warehouses!warehouse_transfers_origin_warehouse_id_fkey(code), dest:warehouses!warehouse_transfers_dest_warehouse_id_fkey(code), creator:profiles!warehouse_transfers_created_by_fkey(full_name)').order('created_at', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    return run(q);
  }, [status]);
  return (
    <div>
      <PageHeader title="Traslados entre almacenes" subtitle="Creación → aprobación → carga → despacho autorizado → tránsito → recepción → diferencias → cierre."
        actions={perms.createInventoryDocs && <Link to="/traslados/nuevo"><Button icon={<Plus className="h-4 w-4" />}>Nuevo traslado</Button></Link>} />
      <Alert>{error}</Alert>
      <Card>
        <div className="mb-3 max-w-xs"><Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Todos los estados" options={[...STEPS, 'rechazado', 'anulado'].map((s) => ({ value: s, label: STEP_LABEL[s] ?? s }))} /></div>
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Número</th><th>Origen → Destino</th><th>Estado</th><th>Creado por</th><th>Fecha</th><th>Despacho</th></tr></thead>
            <tbody>{data.map((t) => <tr key={t.id}><td><Link className="font-medium text-brand-700 hover:underline" to={`/traslados/${t.id}`}>{t.transfer_number}</Link></td>
              <td>{t.origin?.code} → {t.dest?.code}</td><td><Badge status={t.status} /></td><td>{t.creator?.full_name}</td><td className="text-xs">{fmtDateTime(t.created_at)}</td><td className="text-xs">{fmtDateTime(t.dispatched_at)}</td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>
    </div>
  );
}

interface TLine { key: string; material_id: string; unit_id: string; qty: string; origin_location_id: string; lot_id: string; notes: string }
const emptyT = (): TLine => ({ key: newKey(), material_id: '', unit_id: '', qty: '', origin_location_id: '', lot_id: '', notes: '' });

export function TransferForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const mats = useCatalog('materials');
  const [h, setH] = useState<Row>({ origin_warehouse_id: '', dest_warehouse_id: '', notes: '', carrier: '', vehicle: '' });
  const [lines, setLines] = useState<TLine[]>([emptyT()]);
  const [idem] = useState(newKey());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!id) return;
    (async () => {
      const t = await run(supabase.from('warehouse_transfers').select('*').eq('id', id).single()) as Row;
      const ls = await run(supabase.from('warehouse_transfer_lines').select('*').eq('transfer_id', id).order('line_no')) as Row[];
      setH({ id: t.id, origin_warehouse_id: t.origin_warehouse_id, dest_warehouse_id: t.dest_warehouse_id, notes: t.notes ?? '', carrier: t.carrier ?? '', vehicle: t.vehicle ?? '' });
      setLines(ls.map((l) => ({ key: l.id, material_id: l.material_id, unit_id: l.unit_id, qty: String(l.qty), origin_location_id: l.origin_location_id ?? '', lot_id: l.lot_id ?? '', notes: l.notes ?? '' })));
    })().catch((e) => setErr(e.message));
  }, [id]);
  const upd = (k: string, p: Partial<TLine>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const save = async (submit: boolean) => {
    setBusy(true); setErr('');
    try {
      const valid = lines.filter((l) => l.material_id);
      const tid = await rpc<string>('save_transfer', { p: { ...h, id: h.id ?? null, idempotency_key: h.id ? null : idem,
        lines: valid.map((l) => ({ material_id: l.material_id, unit_id: l.unit_id || null, qty: l.qty, origin_location_id: l.origin_location_id || null, lot_id: l.lot_id || null, notes: l.notes || null })) } });
      if (submit) await rpc('transfer_action', { p_id: tid, p_action: 'submit', p_payload: {} });
      nav(`/traslados/${tid}`, { replace: true });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader title={h.id ? 'Editar traslado' : 'Nuevo traslado'} />
      <Alert>{err}</Alert>
      <Card title="Datos" className="mb-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Almacén de origen *"><WarehouseSelect value={h.origin_warehouse_id} onChange={(v) => { setH({ ...h, origin_warehouse_id: v }); setLines((ls) => ls.map((l) => ({ ...l, origin_location_id: '', lot_id: '' }))); }} /></Field>
          <Field label="Almacén de destino *"><WarehouseSelect all value={h.dest_warehouse_id} onChange={(v) => setH({ ...h, dest_warehouse_id: v })} /></Field>
          <Field label="Transportista"><Input value={h.carrier} onChange={(e) => setH({ ...h, carrier: e.target.value })} /></Field>
          <Field label="Vehículo / placa"><Input value={h.vehicle} onChange={(e) => setH({ ...h, vehicle: e.target.value })} /></Field>
          <Field label="Observaciones" className="md:col-span-2"><Textarea rows={1} value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Materiales" actions={<Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, emptyT()])}>Línea</Button>}>
        <div className="mb-3 max-w-xl"><ScanInput onCode={async (c) => {
          const r = await lookupCode(c);
          if (r?.kind === 'material') setLines((ls) => [...ls.filter((l) => l.material_id), { ...emptyT(), material_id: r.row.id, unit_id: r.row.base_unit_id, qty: '1' }]);
          else if (r?.kind === 'lot') setLines((ls) => [...ls.filter((l) => l.material_id), { ...emptyT(), material_id: r.row.material_id, unit_id: mats.find((m) => m.id === r.row.material_id)?.base_unit_id ?? '', lot_id: r.row.id, qty: '1' }]);
          else setErr(`Código “${c}” no encontrado.`);
        }} /></div>
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.key} className="grid items-end gap-2 rounded-lg border border-slate-200 p-3 md:grid-cols-12">
              <div className="md:col-span-4"><Field label="Material"><MaterialSelect value={l.material_id} onChange={(v) => upd(l.key, { material_id: v, unit_id: mats.find((m) => m.id === v)?.base_unit_id ?? '', lot_id: '' })} /></Field></div>
              <div className="md:col-span-2"><Field label="Cantidad"><Input type="number" min={0} step="any" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /></Field></div>
              <div className="md:col-span-1"><Field label="Unidad"><UnitSelect materialId={l.material_id} value={l.unit_id} onChange={(v) => upd(l.key, { unit_id: v })} /></Field></div>
              <div className="md:col-span-2"><Field label="Ubicación origen"><LocationSelect warehouseId={h.origin_warehouse_id} value={l.origin_location_id} onChange={(v) => upd(l.key, { origin_location_id: v })} placeholder="Cualquiera" /></Field></div>
              <div className="md:col-span-2"><Field label="Lote"><LotSelect materialId={l.material_id} warehouseId={h.origin_warehouse_id} value={l.lot_id} onChange={(v) => upd(l.key, { lot_id: v })} /></Field></div>
              <div className="md:col-span-1 text-right"><Button variant="ghost" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} icon={<Trash2 className="h-4 w-4 text-red-500" />} /></div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" loading={busy} onClick={() => save(false)}>Guardar borrador</Button>
          <Button loading={busy} icon={<Send className="h-4 w-4" />} onClick={() => save(true)}>Guardar y enviar a aprobación</Button>
        </div>
      </Card>
    </div>
  );
}

export function TransferDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { perms, profile, warehouses } = useAuth();
  const canApproveIn = useCanApproveIn();
  const t = useToast();
  const tr = useAsync(() => run(supabase.from('warehouse_transfers').select(`*, origin:warehouses!warehouse_transfers_origin_warehouse_id_fkey(code,name), dest:warehouses!warehouse_transfers_dest_warehouse_id_fkey(code,name),
    creator:profiles!warehouse_transfers_created_by_fkey(full_name), approver:profiles!warehouse_transfers_approved_by_fkey(full_name), dispatcher:profiles!warehouse_transfers_dispatched_by_fkey(full_name),
    receiver:profiles!warehouse_transfers_received_by_fkey(full_name), diff_approver:profiles!warehouse_transfers_differences_approved_by_fkey(full_name)`).eq('id', id!).single()), [id]);
  const lines = useAsync(() => run(supabase.from('warehouse_transfer_lines').select('*, material:materials(sku,name), lot:lots(lot_code), location:locations(code)').eq('transfer_id', id!).order('line_no')), [id]);
  const items = useAsync(() => run(supabase.from('warehouse_transfer_items').select('*, material:materials(sku,name,allow_fraction), lot:lots(lot_code,exp_date), oloc:locations!warehouse_transfer_items_origin_location_id_fkey(code), dloc:locations!warehouse_transfer_items_dest_location_id_fkey(code)').eq('transfer_id', id!)), [id]);
  const [tab, setTab] = useState('items');
  const [prep, setPrep] = useState<Record<string, string> | null>(null);
  const [recv, setRecv] = useState<Record<string, Row> | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const act = async (action: string, payload: Row = {}, msg = 'Listo.') => {
    setBusy(action);
    try { await rpc('transfer_action', { p_id: id, p_action: action, p_payload: payload }); t.ok(msg); tr.reload(); items.reload(); return true; }
    catch (e) { t.fail(e); return false; } finally { setBusy(''); }
  };

  if (tr.loading) return <Spinner />;
  const d = tr.data;
  if (!d) return <Empty>Traslado no encontrado o sin acceso.</Empty>;
  const mine = d.created_by === profile?.id;
  const atOrigin = warehouses.some((w) => w.id === d.origin_warehouse_id);
  const atDest = warehouses.some((w) => w.id === d.dest_warehouse_id);
  const staff = perms.createInventoryDocs;
  const stepIdx = STEPS.indexOf(d.status);

  return (
    <div>
      <PageHeader title={<>{d.transfer_number} <Badge status={d.status} /></>} subtitle={`${d.origin?.code} ${d.origin?.name} → ${d.dest?.code} ${d.dest?.name}`}
        actions={<>
          <Link to="/traslados"><Button variant="ghost">Volver</Button></Link>
          {d.status === 'borrador' && (mine || perms.isAdmin) && <><Button variant="secondary" onClick={() => nav(`/traslados/${d.id}/editar`)}>Editar</Button>
            <Button loading={busy === 'submit'} icon={<Send className="h-4 w-4" />} onClick={() => act('submit', {}, 'Enviado a aprobación.')}>Enviar</Button></>}
          {d.status === 'pendiente' && canApproveIn(d.origin_warehouse_id) && !mine && <Button variant="success" loading={busy === 'approve'} icon={<Check className="h-4 w-4" />} onClick={() => act('approve', {}, 'Aprobado: stock reservado en origen (FEFO).')}>Aprobar</Button>}
          {d.status === 'aprobado' && atOrigin && staff && <Button icon={<PackageCheck className="h-4 w-4" />} onClick={() => setPrep(Object.fromEntries((items.data ?? []).map((i) => [i.id, String(i.qty_planned)])))}>Preparar y cargar</Button>}
          {d.status === 'preparado' && canApproveIn(d.origin_warehouse_id) && <Button variant="success" loading={busy === 'dispatch'} icon={<Truck className="h-4 w-4" />} onClick={() => act('dispatch', {}, 'Despachado: la mercadería está en tránsito.')}>Autorizar despacho</Button>}
          {['en_transito', 'recibido_parcial'].includes(d.status) && atDest && staff && <>
            <Button icon={<PackageCheck className="h-4 w-4" />} onClick={() => setRecv(Object.fromEntries((items.data ?? []).map((i) => [i.id, { qty_received: '', qty_damaged: '', dest_location_id: i.dest_location_id ?? '', notes: '' }])))}>Registrar recepción</Button>
            <Button variant="secondary" onClick={() => setDialog('declare')}>Declarar faltantes</Button></>}
          {d.status === 'con_diferencias' && canApproveIn(d.dest_warehouse_id) && d.received_by !== profile?.id && d.differences_declared_by !== profile?.id &&
            <Button variant="success" onClick={() => setDialog('approve_differences')}>Aprobar diferencias y cerrar</Button>}
          {d.status === 'recibido' && atDest && staff && <Button loading={busy === 'close'} onClick={() => act('close', {}, 'Traslado cerrado.')}>Cerrar traslado</Button>}
          {['pendiente', 'aprobado', 'preparado'].includes(d.status) && canApproveIn(d.origin_warehouse_id) && <Button variant="danger" icon={<X className="h-4 w-4" />} onClick={() => setDialog('reject')}>Rechazar</Button>}
          {['borrador', 'pendiente'].includes(d.status) && mine && <Button variant="ghost" onClick={() => setDialog('cancel')}>Anular</Button>}
        </>} />
      {t.node}
      {d.status === 'con_diferencias' && <Alert kind="info">Hay faltantes o daños. Debe aprobarlos un supervisor del destino distinto de quien recibió; se darán de baja con su costo.</Alert>}
      <Card className="mb-4">
        <ol className="mb-4 flex flex-wrap gap-1 text-xs">
          {['borrador', 'pendiente', 'aprobado', 'preparado', 'en_transito', 'recibido', 'cerrado'].map((s) => {
            const done = stepIdx >= STEPS.indexOf(s) || d.status === 'cerrado';
            return <li key={s} className={`rounded-full px-2.5 py-1 ${done ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{STEP_LABEL[s]}</li>;
          })}
        </ol>
        <KV items={[
          ['Creado', `${d.creator?.full_name} · ${fmtDateTime(d.created_at)}`], ['Aprobado', d.approved_by ? `${d.approver?.full_name} · ${fmtDateTime(d.approved_at)}` : '—'],
          ['Despachado', d.dispatched_by ? `${d.dispatcher?.full_name} · ${fmtDateTime(d.dispatched_at)}` : '—'], ['Recibido', d.received_by ? `${d.receiver?.full_name} · ${fmtDateTime(d.received_at)}` : '—'],
          ['Diferencias', d.differences_notes ?? '—'], ['Diferencias aprobadas', d.differences_approved_by ? `${d.diff_approver?.full_name} · ${fmtDateTime(d.differences_approved_at)}` : '—'],
          ['Transportista / vehículo', [d.carrier, d.vehicle].filter(Boolean).join(' · ') || '—'], ['Observaciones', d.notes], ['Rechazo / anulación', d.rejection_reason],
        ]} />
      </Card>
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'items', label: 'Detalle por lote' }, { key: 'lines', label: 'Solicitado' }, { key: 'notes', label: 'Observaciones' }]} />
      {tab === 'lines' && <Card padded={false}>
        <TableWrap><table className="table"><thead><tr><th>#</th><th>Material</th><th className="num">Cantidad</th><th className="num">Unidad base</th><th>Ubicación</th><th>Lote pedido</th></tr></thead>
          <tbody>{(lines.data ?? []).map((l) => <tr key={l.id}><td>{l.line_no}</td><td>{l.material?.sku}<div className="text-xs text-slate-400">{l.material?.name}</div></td><td className="num">{fmtQty(l.qty)}</td><td className="num">{fmtQty(l.qty_base)}</td><td>{l.location?.code ?? 'Cualquiera'}</td><td>{l.lot?.lot_code ?? 'FEFO'}</td></tr>)}</tbody></table></TableWrap>
      </Card>}
      {tab === 'items' && <Card padded={false}>
        {!items.data?.length ? <Empty>Los lotes se asignan al aprobar.</Empty> : (
          <TableWrap><table className="table"><thead><tr><th>Material</th><th>Lote</th><th>Origen</th><th className="num">Planificado</th><th className="num">Cargado</th><th className="num">Despachado</th><th className="num">Recibido</th><th className="num">Dañado</th><th className="num">Faltante</th><th className="num">En tránsito</th><th>Destino</th></tr></thead>
            <tbody>{items.data.map((i) => <tr key={i.id}><td>{i.material?.sku}</td><td>{i.lot?.lot_code ?? '—'}<div className="text-xs text-slate-400">{fmtDate(i.lot?.exp_date)}</div></td><td>{i.oloc?.code ?? '—'}</td>
              <td className="num">{fmtQty(i.qty_planned)}</td><td className="num">{fmtQty(i.qty_prepared)}</td><td className="num">{fmtQty(i.qty_shipped)}</td><td className="num text-emerald-700">{fmtQty(i.qty_received)}</td>
              <td className="num text-red-600">{fmtQty(i.qty_damaged)}</td><td className="num text-red-600">{fmtQty(i.qty_missing)}</td>
              <td className="num font-medium text-violet-700">{['en_transito', 'recibido_parcial', 'con_diferencias'].includes(d.status) ? fmtQty(Number(i.qty_shipped) - Number(i.qty_received)) : '—'}</td><td>{i.dloc?.code ?? '—'}</td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>}
      {tab === 'notes' && <Card><NotesPanel entityType="transfer" entityId={d.id} /></Card>}

      <Modal open={!!prep} wide title="Preparación y carga: confirme cantidades" onClose={() => setPrep(null)}
        footer={<><Button variant="secondary" onClick={() => setPrep(null)}>Cancelar</Button><Button loading={busy === 'prepare'} onClick={async () => {
          if (await act('prepare', { items: Object.entries(prep!).map(([item_id, q]) => ({ item_id, qty_prepared: Number(q) })) }, 'Carga confirmada. Falta la autorización de despacho.')) setPrep(null);
        }}>Confirmar carga</Button></>}>
        <p className="mb-3 text-sm text-slate-500">Si carga menos de lo planificado, el saldo reservado se libera al despachar.</p>
        <table className="table"><thead><tr><th>Material</th><th>Lote</th><th>Ubicación</th><th className="num">Planificado</th><th className="num">Cargado</th></tr></thead>
          <tbody>{(items.data ?? []).map((i) => <tr key={i.id}><td>{i.material?.sku}</td><td>{i.lot?.lot_code ?? '—'}</td><td>{i.oloc?.code ?? '—'}</td><td className="num">{fmtQty(i.qty_planned)}</td>
            <td className="num"><Input className="w-28 text-right" type="number" min={0} max={i.qty_planned} step="any" value={prep?.[i.id] ?? ''} onChange={(e) => setPrep({ ...prep!, [i.id]: e.target.value })} /></td></tr>)}</tbody></table>
      </Modal>

      <Modal open={!!recv} wide title="Recepción en destino" onClose={() => setRecv(null)}
        footer={<><Button variant="secondary" onClick={() => setRecv(null)}>Cancelar</Button><Button loading={busy === 'receive'} onClick={async () => {
          const payload = Object.entries(recv!).filter(([, v]) => Number(v.qty_received) > 0 || Number(v.qty_damaged) > 0)
            .map(([item_id, v]) => ({ item_id, qty_received: Number(v.qty_received || 0), qty_damaged: Number(v.qty_damaged || 0), dest_location_id: v.dest_location_id || null, notes: v.notes || null }));
          if (await act('receive', { items: payload }, 'Recepción registrada.')) setRecv(null);
        }}>Registrar</Button></>}>
        <p className="mb-3 text-sm text-slate-500">Registre lo recibido en esta entrega (puede haber varias). Lo dañado no ingresa al stock y queda como diferencia por aprobar.</p>
        <TableWrap><table className="table"><thead><tr><th>Material / lote</th><th className="num">Pendiente</th><th>Recibido OK</th><th>Dañado</th><th>Ubicación destino</th></tr></thead>
          <tbody>{(items.data ?? []).map((i) => {
            const pend = Number(i.qty_shipped) - Number(i.qty_received) - Number(i.qty_damaged) - Number(i.qty_missing);
            const v = recv?.[i.id] ?? {};
            const set = (k: string, val: string) => setRecv({ ...recv!, [i.id]: { ...v, [k]: val } });
            return <tr key={i.id}><td>{i.material?.sku}<div className="text-xs text-slate-400">{i.lot?.lot_code ?? 'sin lote'}</div></td><td className="num">{fmtQty(pend)}</td>
              <td><Input className="w-24" type="number" min={0} step="any" disabled={pend <= 0} value={v.qty_received ?? ''} onChange={(e) => set('qty_received', e.target.value)} /></td>
              <td><Input className="w-24" type="number" min={0} step="any" disabled={pend <= 0} value={v.qty_damaged ?? ''} onChange={(e) => set('qty_damaged', e.target.value)} /></td>
              <td className="min-w-[160px]"><LocationSelect warehouseId={d.dest_warehouse_id} value={v.dest_location_id ?? ''} onChange={(x) => set('dest_location_id', x)} /></td></tr>;
          })}</tbody></table></TableWrap>
      </Modal>

      <ReasonDialog open={dialog === 'declare'} title="Declarar faltantes" label="Describa las diferencias (lo no recibido se registrará como faltante)" onClose={() => setDialog(null)}
        onConfirm={async (r) => { await rpc('transfer_action', { p_id: id, p_action: 'declare_differences', p_payload: { reason: r } }); tr.reload(); items.reload(); }} />
      <ReasonDialog open={dialog === 'approve_differences'} title="Aprobar diferencias" label="Resolución" variant="success" confirmText="Aprobar y cerrar" onClose={() => setDialog(null)}
        onConfirm={async (r) => { await rpc('transfer_action', { p_id: id, p_action: 'approve_differences', p_payload: { reason: r } }); tr.reload(); items.reload(); }} />
      <ReasonDialog open={dialog === 'reject' || dialog === 'cancel'} title={dialog === 'reject' ? 'Rechazar traslado' : 'Anular traslado'} variant="danger" confirmText={dialog === 'reject' ? 'Rechazar' : 'Anular'} onClose={() => setDialog(null)}
        onConfirm={async (r) => { await rpc('transfer_action', { p_id: id, p_action: dialog, p_payload: { reason: r } }); tr.reload(); items.reload(); }} />
    </div>
  );
}
