import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { newKey, rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth, useCanApproveIn } from '../lib/auth';
import { loadCatalog, lookupCode, useCatalog } from '../lib/catalogs';
import { DOC_TYPE_LABEL, fmtBOB, fmtDate, fmtDateTime, fmtQty } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, KV, PageHeader, ReasonDialog, Select, Spinner, TableWrap, Tabs, Textarea, useToast } from '../components/ui';
import { LocationSelect, LotSelect, MaterialSelect, UnitSelect, WarehouseSelect } from '../components/Pickers';
import { ScanInput } from '../components/Scanner';
import NotesPanel from '../components/NotesPanel';
import { Kardex } from './Stock';

export const SLUG_TO_TYPE: Record<string, string> = { recepciones: 'entrada', salidas: 'salida', devoluciones: 'devolucion', ajustes: 'ajuste' };
const TYPE_TO_SLUG: Record<string, string> = { entrada: 'recepciones', salida: 'salidas', devolucion: 'devoluciones', ajuste: 'ajustes' };
const TITLES: Record<string, [string, string]> = {
  entrada: ['Recepción de materiales', 'Entradas de proveedores. Las confirma un supervisor con el costo unitario en BOB.'],
  salida: ['Salidas y despachos', 'Requieren aprobación de un supervisor distinto de quien las crea. La reserva usa FEFO.'],
  devolucion: ['Devoluciones', 'Reingreso de material al almacén. Se valoriza al costo vigente salvo que se indique otro.'],
  ajuste: ['Ajustes de inventario', 'Correcciones positivas o negativas con motivo obligatorio y aprobación.'],
};

export function InventoryDocsList() {
  const { type: slug } = useParams();
  const type = SLUG_TO_TYPE[slug ?? ''] ?? 'entrada';
  const { perms } = useAuth();
  const [status, setStatus] = useState('');
  const [wh, setWh] = useState('');
  const { data, loading, error } = useAsync(() => {
    let q = supabase.from('inventory_documents').select('*, warehouse:warehouses(code,name), creator:profiles!inventory_documents_created_by_fkey(full_name), supplier:suppliers(name)')
      .eq('doc_type', type).order('created_at', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    if (wh) q = q.eq('warehouse_id', wh);
    return run(q);
  }, [type, status, wh]);
  const canCreate = type === 'salida' ? perms.createIssues : perms.createInventoryDocs;
  return (
    <div>
      <PageHeader title={TITLES[type][0]} subtitle={TITLES[type][1]}
        actions={canCreate && <Link to={`/inventario/${slug}/nuevo`}><Button icon={<Plus className="h-4 w-4" />}>Nuevo</Button></Link>} />
      <Alert>{error}</Alert>
      <Card>
        <div className="mb-3 grid gap-2 md:grid-cols-3">
          <WarehouseSelect value={wh} onChange={setWh} placeholder="Todos mis almacenes" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Todos los estados"
            options={['borrador', 'pendiente', 'aprobado', 'confirmado', 'rechazado', 'anulado'].map((s) => ({ value: s, label: s }))} />
        </div>
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Número</th><th>Almacén</th><th>Estado</th>{type === 'entrada' && <th>Proveedor</th>}<th>Referencia / motivo</th><th>Creado por</th><th>Fecha</th></tr></thead>
            <tbody>{data.map((d) => (
              <tr key={d.id}>
                <td><Link className="font-medium text-brand-700 hover:underline" to={`/inventario/documentos/${d.id}`}>{d.doc_number}</Link></td>
                <td>{d.warehouse?.code}</td><td><Badge status={d.status} /></td>
                {type === 'entrada' && <td>{d.supplier?.name ?? '—'}</td>}
                <td className="max-w-xs truncate">{d.reference || d.reason || '—'}</td>
                <td>{d.creator?.full_name}</td><td className="text-xs">{fmtDateTime(d.created_at)}</td>
              </tr>))}</tbody></table></TableWrap>
        )}
      </Card>
    </div>
  );
}

interface Line { key: string; material_id: string; unit_id: string; qty: string; direction: 1 | -1; location_id: string; lot_id: string; lot_code: string; mfg_date: string; exp_date: string; unit_cost: string; notes: string }
const emptyLine = (): Line => ({ key: newKey(), material_id: '', unit_id: '', qty: '', direction: 1, location_id: '', lot_id: '', lot_code: '', mfg_date: '', exp_date: '', unit_cost: '', notes: '' });

export function InventoryDocForm() {
  const { type: slug, id } = useParams();
  const nav = useNavigate();
  const { perms, warehouses } = useAuth();
  const mats = useCatalog('materials');
  const suppliers = useCatalog('suppliers');
  const [type, setType] = useState(SLUG_TO_TYPE[slug ?? ''] ?? 'entrada');
  const [h, setH] = useState<Row>(() => ({ warehouse_id: warehouses.length === 1 ? warehouses[0].id : '', supplier_id: '', reference: '', reason: '', notes: '', work_order_id: new URLSearchParams(window.location.search).get('ot') ?? '' }));
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [idem] = useState(newKey());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [loaded, setLoaded] = useState(!id);
  const [wos, setWos] = useState<Row[]>([]);

  useEffect(() => {
    if (type === 'salida') supabase.from('work_orders').select('id,wo_number,title').in('status', ['abierta', 'en_progreso', 'en_espera']).order('wo_number').then(({ data }) => setWos(data ?? []));
  }, [type]);

  useEffect(() => {
    if (!id) return;
    (async () => {
      const d = await run(supabase.from('inventory_documents').select('*').eq('id', id).single()) as Row;
      const ls = await run(supabase.from('inventory_document_lines').select('*, cost:document_line_costs(unit_cost)').eq('document_id', id).order('line_no')) as Row[];
      setType(d.doc_type);
      setH({ id: d.id, warehouse_id: d.warehouse_id, supplier_id: d.supplier_id ?? '', reference: d.reference ?? '', reason: d.reason ?? '', notes: d.notes ?? '', work_order_id: d.work_order_id ?? '' });
      setLines(ls.map((l) => ({ key: l.id, material_id: l.material_id, unit_id: l.unit_id, qty: String(l.qty), direction: l.direction, location_id: l.location_id ?? '', lot_id: l.lot_id ?? '',
        lot_code: l.lot_code ?? '', mfg_date: l.mfg_date ?? '', exp_date: l.exp_date ?? '', unit_cost: l.cost?.unit_cost != null ? String(l.cost.unit_cost) : '', notes: l.notes ?? '' })));
      setLoaded(true);
    })().catch((e) => setErr(e.message));
  }, [id]);

  const upd = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const isIn = (l: Line) => type === 'entrada' || type === 'devolucion' || (type === 'ajuste' && l.direction === 1);
  const costEditable = perms.viewCosts && type !== 'salida';

  const onScan = async (code: string) => {
    const r = await lookupCode(code);
    if (r?.kind === 'material') {
      setLines((ls) => {
        const empty = ls.find((l) => !l.material_id);
        const nl = { material_id: r.row.id, unit_id: r.row.base_unit_id, qty: '1' };
        return empty ? ls.map((l) => (l === empty ? { ...l, ...nl } : l)) : [...ls, { ...emptyLine(), ...nl }];
      });
    } else if (r?.kind === 'location') {
      if (r.row.warehouse_id !== h.warehouse_id) setErr('La ubicación escaneada pertenece a otro almacén.');
      else setLines((ls) => { const last = ls[ls.length - 1]; return ls.map((l) => (l === last ? { ...l, location_id: r.row.id } : l)); });
    } else if (r?.kind === 'lot') {
      setLines((ls) => [...ls.filter((l) => l.material_id), { ...emptyLine(), material_id: r.row.material_id, unit_id: mats.find((m) => m.id === r.row.material_id)?.base_unit_id ?? '', lot_id: r.row.id, qty: '1' }]);
    } else setErr(`Código “${code}” no encontrado.`);
  };

  const save = async (submit: boolean) => {
    setBusy(true); setErr('');
    try {
      if (!h.warehouse_id) throw new Error('Seleccione el almacén.');
      if (type === 'ajuste' && !h.reason.trim()) throw new Error('Indique el motivo del ajuste.');
      const valid = lines.filter((l) => l.material_id);
      if (!valid.length) throw new Error('Agregue al menos una línea.');
      await loadCatalog('materials');
      const payload = {
        id: h.id ?? null, doc_type: type, warehouse_id: h.warehouse_id, supplier_id: h.supplier_id || null, reference: h.reference || null,
        reason: h.reason || null, notes: h.notes || null, work_order_id: h.work_order_id || null, idempotency_key: h.id ? null : idem,
        lines: valid.map((l) => ({
          material_id: l.material_id, unit_id: l.unit_id || null, qty: l.qty, direction: type === 'ajuste' ? l.direction : 1,
          location_id: l.location_id || null, lot_id: l.lot_id || null, lot_code: isIn(l) && !l.lot_id ? l.lot_code || null : null,
          mfg_date: isIn(l) && !l.lot_id ? l.mfg_date || null : null, exp_date: isIn(l) && !l.lot_id ? l.exp_date || null : null,
          unit_cost: costEditable && isIn(l) && l.unit_cost !== '' ? l.unit_cost : null, notes: l.notes || null,
        })),
      };
      const docId = await rpc<string>('save_inventory_document', { p: payload });
      if (submit) await rpc('submit_inventory_document', { p_id: docId });
      nav(`/inventario/documentos/${docId}`, { replace: true });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!loaded) return <Spinner />;
  return (
    <div>
      <PageHeader title={`${h.id ? 'Editar' : 'Nueva'} ${DOC_TYPE_LABEL[type].toLowerCase()}`} subtitle={TITLES[type][1]} />
      <Alert>{err}</Alert>
      <Card title="Cabecera" className="mb-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Almacén *"><WarehouseSelect value={h.warehouse_id} onChange={(v) => { if (!h.id) { setH({ ...h, warehouse_id: v }); setLines((ls) => ls.map((l) => ({ ...l, location_id: '', lot_id: '' }))); } }} /></Field>
          {type === 'entrada' && <Field label="Proveedor"><Select value={h.supplier_id} onChange={(e) => setH({ ...h, supplier_id: e.target.value })} placeholder="—" options={suppliers.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} /></Field>}
          {type === 'salida' && <Field label="Orden de trabajo (opcional)"><Select value={h.work_order_id} onChange={(e) => setH({ ...h, work_order_id: e.target.value })} placeholder="—" options={wos.map((w) => ({ value: w.id, label: `${w.wo_number} — ${w.title}` }))} /></Field>}
          <Field label={type === 'entrada' ? 'Factura / guía' : 'Referencia'}><Input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></Field>
          <Field label={`Motivo${type === 'ajuste' ? ' *' : ''}`} className="md:col-span-3"><Input value={h.reason} onChange={(e) => setH({ ...h, reason: e.target.value })} placeholder={type === 'salida' ? 'Ej.: consumo de producción línea 2' : ''} /></Field>
          <Field label="Observaciones" className="md:col-span-3"><Textarea rows={2} value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></Field>
        </div>
      </Card>

      <Card title="Líneas" actions={<Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, emptyLine()])}>Línea</Button>}>
        <div className="mb-4 max-w-xl"><ScanInput onCode={onScan} placeholder="Escanee material, lote o ubicación…" /></div>
        <div className="space-y-3">
          {lines.map((l, i) => {
            const m = mats.find((x) => x.id === l.material_id);
            return (
              <div key={l.key} className="rounded-lg border border-slate-200 p-3">
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-500">
                  <span>Línea {i + 1}</span>
                  <button onClick={() => setLines(lines.filter((x) => x.key !== l.key))} className="text-red-500 hover:text-red-700"><Trash2 className="h-4 w-4" /></button>
                </div>
                <div className="grid gap-2 md:grid-cols-12">
                  <div className="md:col-span-4"><Field label="Material"><MaterialSelect value={l.material_id} onChange={(v) => upd(l.key, { material_id: v, unit_id: mats.find((x) => x.id === v)?.base_unit_id ?? '', lot_id: '', lot_code: '' })} /></Field></div>
                  {type === 'ajuste' && <div className="md:col-span-2"><Field label="Sentido"><Select value={String(l.direction)} onChange={(e) => upd(l.key, { direction: Number(e.target.value) as 1 | -1, lot_id: '' })} options={[{ value: '1', label: '+ Aumentar' }, { value: '-1', label: '− Disminuir' }]} /></Field></div>}
                  <div className="md:col-span-2"><Field label="Cantidad"><Input type="number" min={0} step={m?.allow_fraction ? 'any' : 1} value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /></Field></div>
                  <div className="md:col-span-2"><Field label="Unidad"><UnitSelect materialId={l.material_id} value={l.unit_id} onChange={(v) => upd(l.key, { unit_id: v })} /></Field></div>
                  <div className={type === 'ajuste' ? 'md:col-span-2' : 'md:col-span-4'}><Field label="Ubicación"><LocationSelect warehouseId={h.warehouse_id} value={l.location_id} onChange={(v) => upd(l.key, { location_id: v })} placeholder={isIn(l) ? 'Sin ubicación' : 'Cualquiera (FEFO)'} /></Field></div>
                  {m?.lot_controlled && (isIn(l) ? (
                    <>
                      <div className="md:col-span-3"><Field label="Lote existente"><LotSelect allLots materialId={l.material_id} value={l.lot_id} onChange={(v) => upd(l.key, { lot_id: v })} placeholder="— Lote nuevo —" /></Field></div>
                      {!l.lot_id && <>
                        <div className="md:col-span-3"><Field label="Código de lote nuevo *"><Input value={l.lot_code} onChange={(e) => upd(l.key, { lot_code: e.target.value })} /></Field></div>
                        <div className="md:col-span-2"><Field label="Fabricación"><Input type="date" value={l.mfg_date} onChange={(e) => upd(l.key, { mfg_date: e.target.value })} /></Field></div>
                        <div className="md:col-span-2"><Field label={`Vencimiento${m.expiry_controlled ? ' *' : ''}`}><Input type="date" value={l.exp_date} onChange={(e) => upd(l.key, { exp_date: e.target.value })} /></Field></div>
                      </>}
                    </>
                  ) : (
                    <div className="md:col-span-4"><Field label="Lote"><LotSelect materialId={l.material_id} warehouseId={h.warehouse_id} value={l.lot_id} onChange={(v) => upd(l.key, { lot_id: v })} /></Field></div>
                  ))}
                  {costEditable && isIn(l) && <div className="md:col-span-2"><Field label={`Costo unit. BOB${type === 'entrada' ? ' *' : ''}`} hint="Por unidad de la línea"><Input type="number" min={0} step="any" value={l.unit_cost} onChange={(e) => upd(l.key, { unit_cost: e.target.value })} /></Field></div>}
                  <div className="md:col-span-12"><Input placeholder="Nota de la línea (opcional)" value={l.notes} onChange={(e) => upd(l.key, { notes: e.target.value })} /></div>
                </div>
              </div>
            );
          })}
        </div>
        {type === 'entrada' && !perms.viewCosts && <p className="mt-3 text-xs text-slate-500">Un supervisor completará los costos y confirmará la recepción.</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => nav(-1)}>Cancelar</Button>
          <Button variant="secondary" loading={busy} onClick={() => save(false)}>Guardar borrador</Button>
          <Button loading={busy} icon={<Send className="h-4 w-4" />} onClick={() => save(true)}>{type === 'salida' || type === 'ajuste' ? 'Guardar y enviar a aprobación' : 'Guardar y enviar'}</Button>
        </div>
      </Card>
    </div>
  );
}

export function InventoryDocDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { perms, profile } = useAuth();
  const canApproveIn = useCanApproveIn();
  const units = useCatalog('units');
  const t = useToast();
  const doc = useAsync(() => run(supabase.from('inventory_documents').select(`*, warehouse:warehouses(code,name), supplier:suppliers(name), work_order:work_orders(id,wo_number,title),
      creator:profiles!inventory_documents_created_by_fkey(full_name), approver:profiles!inventory_documents_approved_by_fkey(full_name),
      confirmer:profiles!inventory_documents_confirmed_by_fkey(full_name), rejecter:profiles!inventory_documents_rejected_by_fkey(full_name)`).eq('id', id!).single()), [id]);
  const lines = useAsync(() => run(supabase.from('inventory_document_lines').select('*, material:materials(sku,name), location:locations(code), lot:lots(lot_code,exp_date), cost:document_line_costs(unit_cost,unit_cost_base)').eq('document_id', id!).order('line_no')), [id]);
  const res = useAsync(() => run(supabase.from('stock_reservations').select('*, lot:lots(lot_code,exp_date), location:locations(code), material:materials(sku)').eq('document_id', id!).order('created_at')), [id]);
  const [tab, setTab] = useState('lines');
  const [dialog, setDialog] = useState<'reject' | 'cancel' | null>(null);
  const [busy, setBusy] = useState('');
  const d = doc.data;

  const act = async (fn: string, label: string) => {
    setBusy(fn);
    try { await rpc(fn, { p_id: id }); t.ok(label); doc.reload(); lines.reload(); res.reload(); } catch (e) { t.fail(e); } finally { setBusy(''); }
  };
  const total = useMemo(() => (lines.data ?? []).reduce((s, l) => s + (l.cost?.unit_cost != null ? Number(l.cost.unit_cost) * Number(l.qty) : 0), 0), [lines.data]);

  if (doc.loading) return <Spinner />;
  if (!d) return <Empty>Documento no encontrado o sin acceso.</Empty>;
  const mine = d.created_by === profile?.id;
  const needsApproval = d.doc_type === 'salida' || d.doc_type === 'ajuste';
  const canApprove = canApproveIn(d.warehouse_id) && !mine;
  const canEdit = (d.status === 'borrador' && (mine || perms.isAdmin)) || (['borrador', 'pendiente'].includes(d.status) && !needsApproval && canApproveIn(d.warehouse_id));
  const canConfirm = d.doc_type === 'entrada' ? ['borrador', 'pendiente'].includes(d.status) && perms.confirmReceipts
    : d.doc_type === 'devolucion' ? ['borrador', 'pendiente'].includes(d.status) && perms.createInventoryDocs
    : d.status === 'aprobado' && (perms.createInventoryDocs || (profile?.role === 'mantenimiento' && d.work_order_id));

  return (
    <div>
      <PageHeader title={<>{d.doc_number} <Badge status={d.status} /></>} subtitle={`${DOC_TYPE_LABEL[d.doc_type]} · ${d.warehouse?.code} — ${d.warehouse?.name}`}
        actions={<>
          <Link to={`/inventario/${TYPE_TO_SLUG[d.doc_type]}`}><Button variant="ghost">Volver</Button></Link>
          {canEdit && <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => nav(`/inventario/documentos/${d.id}/editar`)}>{d.status === 'pendiente' ? 'Completar costos' : 'Editar'}</Button>}
          {d.status === 'borrador' && (mine || perms.isAdmin) && <Button variant="secondary" loading={busy === 'submit_inventory_document'} icon={<Send className="h-4 w-4" />} onClick={() => act('submit_inventory_document', 'Enviado.')}>Enviar{needsApproval ? ' a aprobación' : ''}</Button>}
          {needsApproval && d.status === 'pendiente' && canApprove && <Button variant="success" loading={busy === 'approve_inventory_document'} icon={<Check className="h-4 w-4" />} onClick={() => act('approve_inventory_document', 'Aprobado y reservado (FEFO).')}>Aprobar</Button>}
          {needsApproval && ['pendiente', 'aprobado'].includes(d.status) && canApproveIn(d.warehouse_id) && <Button variant="danger" icon={<X className="h-4 w-4" />} onClick={() => setDialog('reject')}>Rechazar</Button>}
          {canConfirm && <Button loading={busy === 'confirm_inventory_document'} icon={<Check className="h-4 w-4" />} onClick={() => act('confirm_inventory_document', 'Documento confirmado. Existencias actualizadas.')}>Confirmar</Button>}
          {['borrador', 'pendiente', 'aprobado'].includes(d.status) && (mine || canApproveIn(d.warehouse_id)) && <Button variant="ghost" onClick={() => setDialog('cancel')}>Anular</Button>}
        </>} />
      {t.node}
      {needsApproval && d.status === 'pendiente' && mine && <Alert kind="info">Usted creó este documento: debe aprobarlo otro supervisor o un administrador.</Alert>}
      {d.status === 'confirmado' && <Alert kind="info">Documento confirmado: es inmutable. Cualquier corrección se hace con un ajuste o devolución compensatoria.</Alert>}
      <Card className="mb-4">
        <KV items={[
          ['Creado', `${d.creator?.full_name ?? ''} · ${fmtDateTime(d.created_at)}`],
          ...(d.approved_by ? [['Aprobado', `${d.approver?.full_name} · ${fmtDateTime(d.approved_at)}`] as [string, string]] : []),
          ...(d.confirmed_by ? [['Confirmado', `${d.confirmer?.full_name} · ${fmtDateTime(d.confirmed_at)}`] as [string, string]] : []),
          ...(d.rejected_by ? [['Rechazado', `${d.rejecter?.full_name} · ${d.rejection_reason}`] as [string, string]] : []),
          ...(d.cancel_reason ? [['Anulado', d.cancel_reason] as [string, string]] : []),
          ...(d.supplier ? [['Proveedor', d.supplier.name] as [string, string]] : []),
          ...(d.work_order ? [['Orden de trabajo', <Link className="text-brand-700" to={`/mantenimiento/ordenes/${d.work_order.id}`}>{d.work_order.wo_number}</Link>] as [string, React.ReactNode]] : []),
          ['Referencia', d.reference], ['Motivo', d.reason], ['Observaciones', d.notes],
          ...(perms.viewCosts && total > 0 ? [['Total (BOB)', fmtBOB(total)] as [string, string]] : []),
        ]} />
      </Card>
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'lines', label: 'Líneas' }, ...(needsApproval ? [{ key: 'res', label: 'Asignación FEFO' }] : []), ...(d.status === 'confirmado' ? [{ key: 'mov', label: 'Movimientos' }] : []), { key: 'notes', label: 'Observaciones' }]} />
      {tab === 'lines' && <Card padded={false}>
        {lines.loading ? <Spinner /> : (
          <TableWrap><table className="table"><thead><tr><th>#</th><th>Material</th><th className="num">Cantidad</th><th className="num">En unidad base</th><th>Ubicación</th><th>Lote</th>{perms.viewCosts && <th className="num">Costo unit.</th>}<th>Nota</th></tr></thead>
            <tbody>{(lines.data ?? []).map((l) => (
              <tr key={l.id}>
                <td>{l.line_no}</td><td>{l.material?.sku}<div className="text-xs text-slate-400">{l.material?.name}</div></td>
                <td className={`num ${l.direction < 0 ? 'text-red-600' : ''}`}>{l.direction < 0 ? '−' : ''}{fmtQty(l.qty)} {units.find((u) => u.id === l.unit_id)?.code}</td>
                <td className="num">{fmtQty(l.qty_base)}</td><td>{l.location?.code ?? '—'}</td>
                <td>{l.lot?.lot_code ?? (l.lot_code ? `${l.lot_code} (nuevo)` : '—')}{(l.lot?.exp_date || l.exp_date) && <div className="text-xs text-slate-400">vence {fmtDate(l.lot?.exp_date ?? l.exp_date)}</div>}</td>
                {perms.viewCosts && <td className="num">{l.cost ? fmtBOB(l.cost.unit_cost) : '—'}</td>}
                <td className="text-xs">{l.notes}</td>
              </tr>))}</tbody></table></TableWrap>
        )}
      </Card>}
      {tab === 'res' && <Card padded={false}>
        {!res.data?.length ? <Empty>Se asigna al aprobar (FEFO: primero el lote que vence antes).</Empty> : (
          <TableWrap><table className="table"><thead><tr><th>Material</th><th>Lote</th><th>Vence</th><th>Ubicación</th><th className="num">Cantidad</th><th>Estado</th></tr></thead>
            <tbody>{res.data.map((r) => <tr key={r.id}><td>{r.material?.sku}</td><td>{r.lot?.lot_code ?? '—'}</td><td>{fmtDate(r.lot?.exp_date)}</td><td>{r.location?.code ?? '—'}</td><td className="num">{fmtQty(r.qty)}</td><td><Badge tone={r.status === 'activa' ? 'blue' : r.status === 'consumida' ? 'green' : 'slate'}>{r.status}</Badge></td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>}
      {tab === 'mov' && <Card><DocMovements docId={d.id} /></Card>}
      {tab === 'notes' && <Card><NotesPanel entityType="inventory_document" entityId={d.id} /></Card>}
      <ReasonDialog open={dialog === 'reject'} title="Rechazar documento" variant="danger" confirmText="Rechazar" onClose={() => setDialog(null)}
        onConfirm={async (r) => { await rpc('reject_inventory_document', { p_id: id, p_reason: r }); doc.reload(); res.reload(); }} />
      <ReasonDialog open={dialog === 'cancel'} title="Anular documento" variant="danger" confirmText="Anular" onClose={() => setDialog(null)}
        onConfirm={async (r) => { await rpc('cancel_inventory_document', { p_id: id, p_reason: r }); doc.reload(); res.reload(); }} />
    </div>
  );
}

function DocMovements({ docId }: { docId: string }) {
  const { perms } = useAuth();
  const { data, loading } = useAsync(() => run(supabase.from('v_movements').select('*').eq('document_id', docId).order('created_at')), [docId]);
  if (loading) return <Spinner />;
  return (
    <TableWrap><table className="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Material</th><th>Ubicación</th><th>Lote</th><th className="num">Cantidad</th>{perms.viewCosts && <><th className="num">Costo unit.</th><th className="num">Total</th><th>Método</th></>}</tr></thead>
      <tbody>{(data ?? []).map((m) => <tr key={m.id}><td className="text-xs">{fmtDateTime(m.created_at)}</td><td>{m.movement_type}</td><td>{m.sku}</td><td>{m.location_code ?? '—'}</td><td>{m.lot_code ?? '—'}</td>
        <td className="num">{fmtQty(m.qty)}</td>{perms.viewCosts && <><td className="num">{fmtBOB(m.unit_cost)}</td><td className="num">{fmtBOB(m.total_cost)}</td><td>{m.valuation_method}</td></>}</tr>)}</tbody></table></TableWrap>
  );
}

export { Kardex };
