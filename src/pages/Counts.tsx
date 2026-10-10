import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth, useCanApproveIn } from '../lib/auth';
import { lookupCode, useCatalog } from '../lib/catalogs';
import { fmtDateTime, fmtQty } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Spinner, TableWrap, Textarea, useToast } from '../components/ui';
import { LocationSelect, LotSelect, MaterialSelect, WarehouseSelect } from '../components/Pickers';
import { ScanInput } from '../components/Scanner';

export function CountsPage() {
  const { perms, warehouses } = useAuth();
  const nav = useNavigate();
  const { data, loading, error } = useAsync(() => run(supabase.from('stock_counts').select('*, warehouse:warehouses(code), location:locations(code), creator:profiles!stock_counts_created_by_fkey(full_name)').order('created_at', { ascending: false })), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Row>({ warehouse_id: warehouses[0]?.id ?? '', location_id: '', notes: '' });
  const t = useToast();
  return (
    <div>
      <PageHeader title="Recuentos físicos" subtitle="Al cerrar, las diferencias generan un ajuste que debe aprobar otro supervisor."
        actions={perms.createInventoryDocs && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Nuevo recuento</Button>} />
      <Alert>{error}</Alert>
      {t.node}
      <Card padded={false}>
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Número</th><th>Almacén</th><th>Alcance</th><th>Estado</th><th>Creado</th><th>Ajuste</th></tr></thead>
            <tbody>{data.map((c) => <tr key={c.id}><td><Link className="font-medium text-brand-700 hover:underline" to={`/recuentos/${c.id}`}>{c.count_number}</Link></td>
              <td>{c.warehouse?.code}</td><td>{c.location?.code ?? 'Todo el almacén'}</td><td><Badge status={c.status} /></td>
              <td className="text-xs">{c.creator?.full_name}<div>{fmtDateTime(c.created_at)}</div></td>
              <td>{c.adjustment_document_id ? <Link className="text-brand-700" to={`/inventario/documentos/${c.adjustment_document_id}`}>Ver ajuste</Link> : '—'}</td></tr>)}</tbody></table></TableWrap>
        )}
      </Card>
      <Modal open={open} title="Nuevo recuento" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
        <Button onClick={async () => { try { const id = await rpc<string>('create_stock_count', { p_wh: f.warehouse_id, p_loc: f.location_id || null, p_notes: f.notes || null }); nav(`/recuentos/${id}`); } catch (e) { t.fail(e); setOpen(false); } }}>Crear</Button></>}>
        <div className="space-y-3">
          <Field label="Almacén"><WarehouseSelect value={f.warehouse_id} onChange={(v) => setF({ ...f, warehouse_id: v, location_id: '' })} /></Field>
          <Field label="Ubicación (opcional)"><LocationSelect warehouseId={f.warehouse_id} value={f.location_id} onChange={(v) => setF({ ...f, location_id: v })} placeholder="Todo el almacén" /></Field>
          <Field label="Notas"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <p className="text-xs text-slate-500">Se toma una foto de las existencias actuales. Recomendado: suspender movimientos durante el conteo.</p>
        </div>
      </Modal>
    </div>
  );
}

export function CountDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { perms } = useAuth();
  const canApproveIn = useCanApproveIn();
  const mats = useCatalog('materials');
  const t = useToast();
  const c = useAsync(() => run(supabase.from('stock_counts').select('*, warehouse:warehouses(code,name), location:locations(code)').eq('id', id!).single()), [id]);
  const lines = useAsync(() => run(supabase.from('stock_count_lines').select('*, material:materials(sku,name,allow_fraction), location:locations(code), lot:lots(lot_code)').eq('count_id', id!)), [id]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [add, setAdd] = useState<Row | null>(null);
  const [q, setQ] = useState('');
  const rows = useMemo(() => (lines.data ?? []).filter((l) => !q || l.material?.sku.toLowerCase().includes(q.toLowerCase()) || l.lot?.lot_code?.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.material?.sku ?? '').localeCompare(b.material?.sku ?? '')), [lines.data, q]);

  if (c.loading) return <Spinner />;
  const cnt = c.data!;
  const open = cnt.status === 'abierto';
  const save = async (l: Row) => {
    const v = vals[l.id];
    if (v === undefined || v === '') return;
    try { await rpc('save_count_line', { p_count: id, p_material: l.material_id, p_location: l.location_id, p_lot: l.lot_id, p_counted: Number(v), p_notes: null }); lines.reload(); }
    catch (e) { t.fail(e); }
  };
  const pending = (lines.data ?? []).filter((l) => l.counted_qty === null).length;

  return (
    <div>
      <PageHeader title={<>{cnt.count_number} <Badge status={cnt.status} /></>} subtitle={`${cnt.warehouse?.code} — ${cnt.warehouse?.name} · ${cnt.location?.code ?? 'Todo el almacén'}`}
        actions={<>
          {open && perms.approve && canApproveIn(cnt.warehouse_id) && <Button disabled={pending > 0} onClick={async () => {
            try { const adj = await rpc<string | null>('close_stock_count', { p_count: id }); t.ok(adj ? 'Recuento cerrado. Se generó un ajuste pendiente de aprobación.' : 'Recuento cerrado sin diferencias.'); c.reload(); if (adj) nav(`/inventario/documentos/${adj}`); }
            catch (e) { t.fail(e); } }}>Cerrar recuento{pending ? ` (${pending} sin contar)` : ''}</Button>}
          {open && canApproveIn(cnt.warehouse_id) && <Button variant="ghost" onClick={async () => { try { await rpc('cancel_stock_count', { p_count: id }); c.reload(); } catch (e) { t.fail(e); } }}>Anular</Button>}
        </>} />
      {t.node}
      <Card>
        {open && <div className="mb-3 grid gap-2 md:grid-cols-2">
          <ScanInput placeholder="Escanee un material para ubicarlo o agregarlo…" onCode={async (code) => {
            const r = await lookupCode(code);
            if (r?.kind === 'material') { const found = (lines.data ?? []).find((l) => l.material_id === r.row.id); if (found) setQ(r.row.sku); else setAdd({ material_id: r.row.id, location_id: cnt.location_id ?? '', lot_id: '', qty: '' }); }
            else if (r?.kind === 'lot') setAdd({ material_id: r.row.material_id, lot_id: r.row.id, location_id: cnt.location_id ?? '', qty: '' });
            else t.fail(new Error('Código no encontrado.'));
          }} />
          <div className="flex gap-2"><Input placeholder="Filtrar…" value={q} onChange={(e) => setQ(e.target.value)} /><Button variant="secondary" onClick={() => setAdd({ material_id: '', location_id: cnt.location_id ?? '', lot_id: '', qty: '' })}>Agregar ítem</Button></div>
        </div>}
        {lines.loading ? <Spinner /> : !rows.length ? <Empty /> : (
          <TableWrap><table className="table"><thead><tr><th>Material</th><th>Ubicación</th><th>Lote</th><th className="num">Sistema (foto)</th><th className="num">Contado</th><th className="num">Diferencia</th></tr></thead>
            <tbody>{rows.map((l) => {
              const diff = l.counted_qty != null ? Number(l.counted_qty) - Number(l.system_qty) : null;
              return (
                <tr key={l.id}>
                  <td>{l.material?.sku}<div className="text-xs text-slate-400">{l.material?.name}</div></td><td>{l.location?.code ?? '—'}</td><td>{l.lot?.lot_code ?? '—'}</td>
                  <td className="num">{fmtQty(l.system_qty)}</td>
                  <td className="num">{open ? <Input className="w-28 text-right" type="number" min={0} step={l.material?.allow_fraction ? 'any' : 1}
                    value={vals[l.id] ?? (l.counted_qty ?? '')} onChange={(e) => setVals({ ...vals, [l.id]: e.target.value })} onBlur={() => save(l)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /> : fmtQty(l.counted_qty)}</td>
                  <td className={`num font-medium ${diff ? (diff < 0 ? 'text-red-600' : 'text-emerald-700') : ''}`}>{diff == null ? '—' : fmtQty(diff)}</td>
                </tr>
              );
            })}</tbody></table></TableWrap>
        )}
      </Card>
      <Modal open={!!add} title="Agregar ítem encontrado" onClose={() => setAdd(null)} footer={<><Button variant="secondary" onClick={() => setAdd(null)}>Cancelar</Button>
        <Button onClick={async () => { try { await rpc('save_count_line', { p_count: id, p_material: add!.material_id, p_location: add!.location_id || null, p_lot: add!.lot_id || null, p_counted: Number(add!.qty), p_notes: 'Agregado en conteo' }); setAdd(null); lines.reload(); } catch (e) { t.fail(e); } }}>Guardar</Button></>}>
        {add && <div className="space-y-3">
          <Field label="Material"><MaterialSelect value={add.material_id} onChange={(v) => setAdd({ ...add, material_id: v, lot_id: '' })} /></Field>
          <Field label="Ubicación"><LocationSelect warehouseId={cnt.warehouse_id} value={add.location_id} onChange={(v) => setAdd({ ...add, location_id: v })} /></Field>
          {mats.find((m) => m.id === add.material_id)?.lot_controlled && <Field label="Lote"><LotSelect allLots materialId={add.material_id} value={add.lot_id} onChange={(v) => setAdd({ ...add, lot_id: v })} placeholder="Seleccione lote" /></Field>}
          <Field label="Cantidad contada (unidad base)"><Input type="number" min={0} step="any" value={add.qty} onChange={(e) => setAdd({ ...add, qty: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
