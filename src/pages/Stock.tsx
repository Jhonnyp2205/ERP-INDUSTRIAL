import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Printer, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtBOB, fmtDate, fmtDateTime, fmtQty, MOVEMENT_LABEL } from '../lib/format';
import { downloadCSV } from '../lib/csv';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, ReasonDialog, Select, Spinner, TableWrap, Tabs, Alert, KV } from '../components/ui';
import { MaterialSelect, WarehouseSelect } from '../components/Pickers';
import { printLabels } from '../components/labels';
import DocumentsPanel from '../components/DocumentsPanel';
import NotesPanel from '../components/NotesPanel';

export function StockPage() {
  const [tab, setTab] = useState('stock');
  return (
    <div>
      <PageHeader title="Existencias" subtitle="Disponible = en mano − reservado (solo lotes habilitados). Bloqueado = lotes en cuarentena, bloqueados o vencidos." />
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'stock', label: 'Por almacén y ubicación' }, { key: 'transit', label: 'En tránsito' }]} />
      {tab === 'stock' ? <StockTable /> : <InTransit />}
    </div>
  );
}

function StockTable() {
  const [wh, setWh] = useState('');
  const [mat, setMat] = useState('');
  const [q, setQ] = useState('');
  const { data, loading, error } = useAsync(() => {
    let x = supabase.from('v_stock').select('*').order('sku').order('warehouse_code').limit(5000);
    if (wh) x = x.eq('warehouse_id', wh);
    if (mat) x = x.eq('material_id', mat);
    return run(x);
  }, [wh, mat]);
  const rows = useMemo(() => (data ?? []).filter((r) => !q || [r.sku, r.material_name, r.location_code, r.lot_code].some((v) => v?.toLowerCase().includes(q.toLowerCase()))), [data, q]);
  const cols = [{ key: 'sku', label: 'SKU' }, { key: 'material_name', label: 'Material' }, { key: 'warehouse_code', label: 'Almacén' }, { key: 'location_code', label: 'Ubicación' },
    { key: 'lot_code', label: 'Lote' }, { key: 'exp_date', label: 'Vence' }, { key: 'qty_on_hand', label: 'En mano' }, { key: 'qty_reserved', label: 'Reservado' },
    { key: 'qty_available', label: 'Disponible' }, { key: 'qty_blocked', label: 'Bloqueado' }, { key: 'unit_code', label: 'Unidad' }];
  return (
    <Card actions={<Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => downloadCSV('existencias', rows, cols)}>CSV</Button>}>
      <Alert>{error}</Alert>
      <div className="mb-3 grid gap-2 md:grid-cols-3">
        <WarehouseSelect value={wh} onChange={setWh} placeholder="Todos mis almacenes" />
        <MaterialSelect value={mat} onChange={setMat} />
        <Input placeholder="Filtrar…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {mat && <button className="mb-2 text-xs text-brand-700" onClick={() => setMat('')}>Quitar filtro de material</button>}
      {loading ? <Spinner /> : !rows.length ? <Empty>Sin existencias.</Empty> : (
        <TableWrap><table className="table"><thead><tr><th>Material</th><th>Almacén</th><th>Ubicación</th><th>Lote</th><th>Vence</th><th className="num">En mano</th><th className="num">Reservado</th><th className="num">Disponible</th><th className="num">Bloqueado</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><Link className="font-medium text-brand-700 hover:underline" to={`/materiales/${r.material_id}`}>{r.sku}</Link><div className="text-xs text-slate-400">{r.material_name}</div></td>
              <td>{r.warehouse_code}</td><td>{r.location_code ?? '—'}</td>
              <td>{r.lot_code ?? '—'} {r.lot_status && r.lot_status !== 'disponible' && <Badge status={r.lot_status} />}</td>
              <td>{fmtDate(r.exp_date)}</td>
              <td className="num">{fmtQty(r.qty_on_hand)} <span className="text-xs text-slate-400">{r.unit_code}</span></td>
              <td className="num">{fmtQty(r.qty_reserved)}</td><td className="num font-semibold">{fmtQty(r.qty_available)}</td>
              <td className={`num ${Number(r.qty_blocked) > 0 ? 'text-red-600' : ''}`}>{fmtQty(r.qty_blocked)}</td>
            </tr>))}</tbody></table></TableWrap>
      )}
    </Card>
  );
}

export function InTransit() {
  const { data, loading } = useAsync(() => run(supabase.from('v_stock_in_transit').select('*').order('dispatched_at')), []);
  return (
    <Card padded={false}>
      {loading ? <Spinner /> : !data?.length ? <Empty>No hay mercadería en tránsito.</Empty> : (
        <TableWrap><table className="table"><thead><tr><th>Traslado</th><th>Origen → Destino</th><th>Material</th><th>Lote</th><th className="num">Despachado</th><th className="num">Recibido</th><th className="num">En tránsito</th><th>Despacho</th></tr></thead>
          <tbody>{data.map((r) => <tr key={r.item_id}><td><Link className="text-brand-700 hover:underline" to={`/traslados/${r.transfer_id}`}>{r.transfer_number}</Link> <Badge status={r.status} /></td>
            <td>{r.origin_name} → {r.dest_name}</td><td>{r.sku}</td><td>{r.lot_code ?? '—'}</td><td className="num">{fmtQty(r.qty_shipped)}</td><td className="num">{fmtQty(r.qty_received)}</td>
            <td className="num font-semibold text-violet-700">{fmtQty(r.qty_in_transit)}</td><td className="text-xs">{fmtDateTime(r.dispatched_at)}</td></tr>)}</tbody></table></TableWrap>
      )}
    </Card>
  );
}

/** Historial de movimientos (kardex). Los costos solo aparecen si el usuario tiene permiso (RLS). */
export function Kardex({ materialId, lotId, from, to, warehouseId }: { materialId?: string; lotId?: string; from?: string; to?: string; warehouseId?: string }) {
  const { perms } = useAuth();
  const { data, loading, error } = useAsync(() => {
    let x = supabase.from('v_movements').select('*').order('created_at', { ascending: false }).limit(2000);
    if (materialId) x = x.eq('material_id', materialId);
    if (lotId) x = x.eq('lot_id', lotId);
    if (warehouseId) x = x.eq('warehouse_id', warehouseId);
    if (from) x = x.gte('created_at', from);
    if (to) x = x.lte('created_at', to + 'T23:59:59');
    return run(x);
  }, [materialId, lotId, from, to, warehouseId]);
  const cols = [{ key: 'created_at', label: 'Fecha' }, { key: 'movement_type', label: 'Tipo' }, { key: 'sku', label: 'SKU' }, { key: 'warehouse_code', label: 'Almacén' },
    { key: 'location_code', label: 'Ubicación' }, { key: 'lot_code', label: 'Lote' }, { key: 'qty', label: 'Cantidad' }, { key: 'balance_after', label: 'Saldo ubicación' },
    { key: 'doc_number', label: 'Documento' }, { key: 'transfer_number', label: 'Traslado' }, { key: 'user_name', label: 'Usuario' },
    ...(perms.viewCosts ? [{ key: 'unit_cost', label: 'Costo unit. BOB' }, { key: 'total_cost', label: 'Costo total BOB' }, { key: 'valuation_method', label: 'Método' }] : [])];
  if (loading) return <Spinner />;
  return (
    <div>
      <Alert>{error}</Alert>
      <div className="mb-2 flex justify-end"><Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => downloadCSV('movimientos', data ?? [], cols)}>CSV</Button></div>
      {!data?.length ? <Empty>Sin movimientos.</Empty> : (
        <TableWrap><table className="table"><thead><tr><th>Fecha</th><th>Tipo</th>{!materialId && <th>Material</th>}<th>Almacén / ubicación</th><th>Lote</th><th className="num">Cantidad</th><th className="num">Saldo ubic.</th><th>Origen</th><th>Usuario</th>{perms.viewCosts && <><th className="num">Costo unit.</th><th className="num">Costo total</th></>}</tr></thead>
          <tbody>{data.map((m) => (
            <tr key={m.id}>
              <td className="whitespace-nowrap text-xs">{fmtDateTime(m.created_at)}</td>
              <td>{MOVEMENT_LABEL[m.movement_type] ?? m.movement_type}</td>
              {!materialId && <td>{m.sku}</td>}
              <td>{m.warehouse_code}{m.location_code && <span className="text-slate-400"> / {m.location_code}</span>}</td>
              <td>{m.lot_code ?? '—'}</td>
              <td className={`num font-medium ${Number(m.qty) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{Number(m.qty) > 0 ? '+' : ''}{fmtQty(m.qty)}</td>
              <td className="num">{fmtQty(m.balance_after)}</td>
              <td>{m.document_id ? <Link className="text-brand-700 hover:underline" to={`/inventario/documentos/${m.document_id}`}>{m.doc_number}</Link>
                : m.transfer_id ? <Link className="text-brand-700 hover:underline" to={`/traslados/${m.transfer_id}`}>{m.transfer_number}</Link> : '—'}</td>
              <td className="text-xs">{m.user_name}</td>
              {perms.viewCosts && <><td className="num">{fmtBOB(m.unit_cost)}</td><td className="num">{fmtBOB(m.total_cost)}</td></>}
            </tr>))}</tbody></table></TableWrap>
      )}
    </div>
  );
}

// ------------------------------- Lotes -------------------------------
export function LotsPage() {
  const { perms } = useAuth();
  const [params, setParams] = useSearchParams();
  const [f, setF] = useState(params.get('f') ?? '');
  const [q, setQ] = useState('');
  const { data, loading, error, reload } = useAsync(() => run(supabase.from('v_lots').select('*').order('exp_date', { ascending: true, nullsFirst: false }).limit(3000)), []);
  const lotId = params.get('lot');
  const rows = useMemo(() => (data ?? []).filter((l) => {
    if (f === 'por_vencer' && l.effective_status !== 'por_vencer') return false;
    if (f === 'vencido' && l.effective_status !== 'vencido') return false;
    if (f === 'bloqueados' && !['bloqueado', 'cuarentena'].includes(l.effective_status)) return false;
    const t = q.toLowerCase();
    return !t || [l.lot_code, l.sku, l.material_name].some((v) => v?.toLowerCase().includes(t));
  }), [data, f, q]);
  return (
    <div>
      <PageHeader title="Lotes y vencimientos" subtitle="FEFO prioriza el lote que vence primero en las salidas. El costo lo define el método de valoración, no FEFO." />
      <Alert>{error}</Alert>
      <Card>
        <div className="mb-3 grid gap-2 md:grid-cols-3">
          <Select value={f} onChange={(e) => setF(e.target.value)} placeholder="Todos los lotes"
            options={[{ value: 'por_vencer', label: 'Por vencer (según alerta)' }, { value: 'vencido', label: 'Vencidos' }, { value: 'bloqueados', label: 'Bloqueados / cuarentena' }]} />
          <Input placeholder="Buscar lote o material…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {loading ? <Spinner /> : !rows.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Lote</th><th>Material</th><th>Fabricación</th><th>Vencimiento</th><th className="num">Vida útil</th><th className="num">Restante</th><th className="num">Alerta</th><th>Estado</th></tr></thead>
            <tbody>{rows.map((l) => (
              <tr key={l.id} className="cursor-pointer" onClick={() => setParams({ lot: l.id })}>
                <td className="font-medium text-brand-700">{l.lot_code}</td><td>{l.sku}<div className="text-xs text-slate-400">{l.material_name}</div></td>
                <td>{fmtDate(l.mfg_date)}</td><td>{fmtDate(l.exp_date)}</td>
                <td className="num">{l.shelf_life_days != null ? `${l.shelf_life_days} d` : '—'}</td>
                <td className={`num ${l.remaining_days != null && l.remaining_days <= l.alert_days ? 'font-semibold text-amber-700' : ''}`}>{l.remaining_days != null ? `${l.remaining_days} d` : '—'}</td>
                <td className="num text-xs">{l.alert_days} d</td>
                <td><Badge status={l.effective_status} /></td>
              </tr>))}</tbody></table></TableWrap>
        )}
      </Card>
      {lotId && <LotDrawer lotId={lotId} canStatus={perms.lotStatus} onClose={() => { params.delete('lot'); setParams(params); }} onChanged={reload} />}
    </div>
  );
}

function LotDrawer({ lotId, onClose, canStatus, onChanged }: { lotId: string; onClose: () => void; canStatus: boolean; onChanged: () => void }) {
  const { data: l, reload } = useAsync(() => run(supabase.from('v_lots').select('*').eq('id', lotId).single()), [lotId]);
  const [tab, setTab] = useState('info');
  const [target, setTarget] = useState<string | null>(null);
  return (
    <Modal open wide title={l ? `Lote ${l.lot_code} · ${l.sku}` : 'Lote'} onClose={onClose}
      footer={l && <>
        <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => printLabels([{ code: `LOT:${l.id}`, title: `${l.sku} · Lote ${l.lot_code}`, subtitle: l.material_name, extra: l.exp_date ? `Vence ${fmtDate(l.exp_date)}` : undefined }])}>Etiqueta</Button>
        {canStatus && l.status !== 'disponible' && l.status !== 'vencido' && <Button variant="success" onClick={() => setTarget('disponible')}>Liberar / habilitar</Button>}
        {canStatus && l.status === 'disponible' && <><Button variant="secondary" onClick={() => setTarget('cuarentena')}>Cuarentena</Button><Button variant="danger" icon={<ShieldAlert className="h-4 w-4" />} onClick={() => setTarget('bloqueado')}>Bloquear</Button></>}
      </>}>
      {!l ? <Spinner /> : (
        <>
          <Tabs active={tab} onChange={setTab} tabs={[{ key: 'info', label: 'Datos' }, { key: 'mov', label: 'Movimientos' }, { key: 'docs', label: 'Certificados' }, { key: 'notes', label: 'Observaciones' }]} />
          {tab === 'info' && <KV items={[['Material', `${l.sku} — ${l.material_name}`], ['Estado', <Badge status={l.effective_status} />], ['Motivo del estado', l.status_reason],
            ['Fabricación', fmtDate(l.mfg_date)], ['Vencimiento', fmtDate(l.exp_date)], ['Vida útil total', l.shelf_life_days != null ? `${l.shelf_life_days} días` : '—'],
            ['Vida útil restante', l.remaining_days != null ? `${l.remaining_days} días (${l.remaining_pct ?? '—'}%)` : '—'], ['Alerta', `${l.alert_days} días antes`]]} />}
          {tab === 'mov' && <Kardex lotId={l.id} />}
          {tab === 'docs' && <DocumentsPanel entityType="lot" entityId={l.id} />}
          {tab === 'notes' && <NotesPanel entityType="lot" entityId={l.id} />}
        </>
      )}
      <ReasonDialog open={!!target} title={target === 'disponible' ? 'Resolución de liberación del lote' : `Cambiar a ${target}`}
        label="Motivo / resolución (queda auditado)" variant={target === 'bloqueado' ? 'danger' : 'primary'}
        onClose={() => setTarget(null)} onConfirm={async (r) => { await rpc('set_lot_status', { p_lot: lotId, p_status: target, p_reason: r }); reload(); onChanged(); }} />
    </Modal>
  );
}

export function KardexReport() {
  const [mat, setMat] = useState('');
  const [wh, setWh] = useState('');
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  return (
    <div>
      <div className="mb-3 grid gap-2 md:grid-cols-4">
        <Field label="Material"><MaterialSelect value={mat} onChange={setMat} /></Field>
        <Field label="Almacén"><WarehouseSelect value={wh} onChange={setWh} placeholder="Todos" /></Field>
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Kardex materialId={mat || undefined} warehouseId={wh || undefined} from={from} to={to} />
    </div>
  );
}

export type { Row };
