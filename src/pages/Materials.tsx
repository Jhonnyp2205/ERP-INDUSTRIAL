import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { run, useAsync, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { invalidateCatalog, lookupCode, useCatalog } from '../lib/catalogs';
import { fmtBOB, fmtDate, fmtQty } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, KV, Modal, PageHeader, Select, Spinner, TableWrap, Tabs, Textarea, useToast } from '../components/ui';
import { ScanInput } from '../components/Scanner';
import { printLabels } from '../components/labels';
import DocumentsPanel from '../components/DocumentsPanel';
import NotesPanel from '../components/NotesPanel';
import CrudTable from '../components/CrudTable';
import { Kardex } from './Stock';

export function MaterialsPage() {
  const { perms } = useAuth();
  const nav = useNavigate();
  const cats = useCatalog('categories');
  const units = useCatalog('units');
  const { data, loading, error, reload } = useAsync(() => run(supabase.from('materials').select('*').order('sku')), []);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState('activos');
  const [edit, setEdit] = useState<Row | null>(null);
  const [msg, setMsg] = useState('');

  const rows = useMemo(() => (data ?? []).filter((m) => {
    const t = q.toLowerCase();
    return (!t || [m.sku, m.name, m.barcode, m.internal_code].some((x) => x?.toLowerCase().includes(t)))
      && (!cat || m.category_id === cat) && (status === 'todos' || (status === 'activos' ? m.active : !m.active));
  }), [data, q, cat, status]);

  return (
    <div>
      <PageHeader title="Materiales" subtitle="SKU, códigos, unidades, control de lotes y vencimientos."
        actions={perms.manageCatalogs && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ active: true, lot_controlled: true, expiry_controlled: true, allow_fraction: false, min_stock: 0 })}>Nuevo material</Button>} />
      <Alert>{error}</Alert>
      {msg && <Alert kind="info">{msg}</Alert>}
      <Card>
        <div className="mb-3 grid gap-2 md:grid-cols-4">
          <Input placeholder="Buscar SKU, nombre, código…" value={q} onChange={(e) => setQ(e.target.value)} className="md:col-span-1" />
          <Select value={cat} onChange={(e) => setCat(e.target.value)} placeholder="Todas las categorías" options={cats.map((c) => ({ value: c.id, label: c.name }))} />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'activos', label: 'Activos' }, { value: 'inactivos', label: 'Inactivos' }, { value: 'todos', label: 'Todos' }]} />
          <ScanInput placeholder="Escanear para abrir…" onCode={async (c) => {
            const r = await lookupCode(c);
            if (r?.kind === 'material') nav(`/materiales/${r.row.id}`); else setMsg(`No se encontró un material con el código “${c}”.`);
          }} />
        </div>
        {loading ? <Spinner /> : !rows.length ? <Empty /> : (
          <TableWrap><table className="table">
            <thead><tr><th>SKU</th><th>Nombre</th><th>Categoría</th><th>Unidad base</th><th>Control</th><th>Estado</th><th /></tr></thead>
            <tbody>{rows.map((m) => (
              <tr key={m.id}>
                <td><Link className="font-medium text-brand-700 hover:underline" to={`/materiales/${m.id}`}>{m.sku}</Link><div className="text-xs text-slate-400">{m.barcode}</div></td>
                <td>{m.name}</td>
                <td>{cats.find((c) => c.id === m.category_id)?.name ?? '—'}</td>
                <td>{units.find((u) => u.id === m.base_unit_id)?.code}</td>
                <td className="space-x-1">{m.lot_controlled && <Badge tone="blue">Lote</Badge>}{m.expiry_controlled && <Badge tone="amber">Vence</Badge>}{m.allow_fraction && <Badge>Fracción</Badge>}</td>
                <td><Badge tone={m.active ? 'green' : 'slate'}>{m.active ? 'Activo' : 'Inactivo'}</Badge></td>
                <td className="text-right">{perms.manageCatalogs && <Button variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(m)} />}</td>
              </tr>))}
            </tbody></table></TableWrap>
        )}
      </Card>
      <MaterialForm material={edit} onClose={() => setEdit(null)} onSaved={() => { reload(); invalidateCatalog('materials', 'materialUnits'); }} />
    </div>
  );
}

export function MaterialForm({ material, onClose, onSaved }: { material: Row | null; onClose: () => void; onSaved: () => void }) {
  const cats = useCatalog('categories');
  const units = useCatalog('units');
  const [f, setF] = useState<Row>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [prev, setPrev] = useState<Row | null>(null);
  if (material !== prev) { setPrev(material); setF(material ?? {}); setErr(''); }
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (!f.sku?.trim() || !f.name?.trim() || !f.base_unit_id) throw new Error('SKU, nombre y unidad base son obligatorios.');
      if (f.expiry_controlled && !f.lot_controlled) throw new Error('El control de vencimiento requiere control por lote.');
      const p = {
        sku: f.sku.trim(), internal_code: f.internal_code || null, barcode: f.barcode || null, name: f.name.trim(), description: f.description || null,
        category_id: f.category_id || null, base_unit_id: f.base_unit_id, allow_fraction: !!f.allow_fraction, lot_controlled: !!f.lot_controlled,
        expiry_controlled: !!f.expiry_controlled, serial_controlled: !!f.serial_controlled, quarantine_on_receipt: !!f.quarantine_on_receipt,
        expiry_alert_days: f.expiry_alert_days === '' || f.expiry_alert_days == null ? null : Number(f.expiry_alert_days),
        min_stock: Number(f.min_stock || 0), active: f.active !== false,
      };
      if (f.id) await run(supabase.from('materials').update(p).eq('id', f.id));
      else await run(supabase.from('materials').insert(p));
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={!!material} wide title={f.id ? `Editar ${f.sku}` : 'Nuevo material'} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} onClick={save}>Guardar</Button></>}>
      <Alert>{err}</Alert>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="SKU *"><Input value={f.sku ?? ''} onChange={(e) => set('sku', e.target.value)} /></Field>
        <Field label="Código interno"><Input value={f.internal_code ?? ''} onChange={(e) => set('internal_code', e.target.value)} /></Field>
        <Field label="Código de barras"><Input value={f.barcode ?? ''} onChange={(e) => set('barcode', e.target.value)} /></Field>
        <Field label="Nombre *" className="sm:col-span-2"><Input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Categoría"><Select value={f.category_id ?? ''} onChange={(e) => set('category_id', e.target.value)} placeholder="—" options={cats.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Unidad base (almacenamiento) *" hint={f.id ? 'Cambiarla con existencias no es recomendable' : undefined}>
          <Select value={f.base_unit_id ?? ''} onChange={(e) => set('base_unit_id', e.target.value)} placeholder="—" options={units.filter((u) => u.active).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }))} />
        </Field>
        <Field label="Stock mínimo (unidad base)"><Input type="number" min={0} step="any" value={f.min_stock ?? 0} onChange={(e) => set('min_stock', e.target.value)} /></Field>
        <Field label="Alerta de vencimiento (días)" hint="Vacío = valor de la empresa (30)"><Input type="number" min={0} value={f.expiry_alert_days ?? ''} onChange={(e) => set('expiry_alert_days', e.target.value)} /></Field>
        <Field label="Descripción" className="sm:col-span-3"><Textarea value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-2 text-sm sm:col-span-3 sm:grid-cols-3">
          {[['lot_controlled', 'Controla lotes'], ['expiry_controlled', 'Controla vencimiento'], ['allow_fraction', 'Admite fracciones'],
            ['quarantine_on_receipt', 'Cuarentena al recibir'], ['serial_controlled', 'Lleva número de serie'], ['active', 'Activo']].map(([k, l]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={k === 'active' ? f.active !== false : !!f[k]} onChange={(e) => set(k, e.target.checked)} />{l}</label>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function MaterialDetailPage() {
  const { id } = useParams();
  const { perms } = useAuth();
  const units = useCatalog('units');
  const cats = useCatalog('categories');
  const { data: m, loading, reload } = useAsync(() => run(supabase.from('materials').select('*').eq('id', id!).single()), [id]);
  const [tab, setTab] = useState('general');
  const [edit, setEdit] = useState<Row | null>(null);
  if (loading) return <Spinner />;
  if (!m) return <Empty>Material no encontrado.</Empty>;
  const base = units.find((u) => u.id === m.base_unit_id);
  return (
    <div>
      <PageHeader title={<>{m.sku} <span className="font-normal text-slate-500">· {m.name}</span></>} subtitle={<Badge tone={m.active ? 'green' : 'slate'}>{m.active ? 'Activo' : 'Inactivo'}</Badge>}
        actions={<>
          <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => printLabels([{ code: m.barcode || m.sku, title: m.sku, subtitle: m.name }])}>Etiqueta</Button>
          {perms.manageCatalogs && <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(m)}>Editar</Button>}
        </>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'general', label: 'General' }, { key: 'units', label: 'Unidades' }, { key: 'stock', label: 'Existencias' }, { key: 'lots', label: 'Lotes' },
        { key: 'kardex', label: 'Movimientos' }, ...(m.serial_controlled ? [{ key: 'serials', label: 'Series' }] : []),
        { key: 'docs', label: 'Documentos' }, { key: 'notes', label: 'Observaciones' }]} />
      {tab === 'general' && <Card><KV items={[
        ['SKU', m.sku], ['Código interno', m.internal_code], ['Código de barras', m.barcode], ['Categoría', cats.find((c) => c.id === m.category_id)?.name],
        ['Unidad base', base ? `${base.code} — ${base.name}` : '—'], ['Stock mínimo', fmtQty(m.min_stock)], ['Control de lote', m.lot_controlled ? 'Sí' : 'No'],
        ['Control de vencimiento', m.expiry_controlled ? 'Sí' : 'No'], ['Alerta de vencimiento', m.expiry_alert_days != null ? `${m.expiry_alert_days} días` : 'Valor de la empresa'],
        ['Fracciones', m.allow_fraction ? 'Permitidas' : 'No'], ['Cuarentena al recibir', m.quarantine_on_receipt ? 'Sí' : 'No'], ['Descripción', m.description],
      ]} /></Card>}
      {tab === 'units' && <UnitsTab material={m} canEdit={perms.manageCatalogs} />}
      {tab === 'stock' && <MaterialStock materialId={m.id} />}
      {tab === 'lots' && <MaterialLots materialId={m.id} />}
      {tab === 'kardex' && <Card><Kardex materialId={m.id} /></Card>}
      {tab === 'serials' && <SerialsTab materialId={m.id} canEdit={perms.manageCatalogs} />}
      {tab === 'docs' && <Card><DocumentsPanel entityType="material" entityId={m.id} /></Card>}
      {tab === 'notes' && <Card><NotesPanel entityType="material" entityId={m.id} /></Card>}
      <MaterialForm material={edit} onClose={() => setEdit(null)} onSaved={() => { reload(); invalidateCatalog('materials', 'materialUnits'); }} />
    </div>
  );
}

function UnitsTab({ material, canEdit }: { material: Row; canEdit: boolean }) {
  const units = useCatalog('units');
  const { data, reload } = useAsync(() => run(supabase.from('material_units').select('*').eq('material_id', material.id)), [material.id]);
  const [f, setF] = useState<Row>({ unit_id: '', factor: '', is_purchase: true, is_consumption: false });
  const t = useToast();
  const base = units.find((u) => u.id === material.base_unit_id);
  const add = async () => {
    try {
      if (!f.unit_id || !(Number(f.factor) > 0)) throw new Error('Seleccione unidad y factor mayor que cero.');
      await run(supabase.from('material_units').upsert({ material_id: material.id, unit_id: f.unit_id, factor: Number(f.factor), is_purchase: f.is_purchase, is_consumption: f.is_consumption }));
      setF({ unit_id: '', factor: '', is_purchase: true, is_consumption: false }); reload(); invalidateCatalog('materialUnits'); t.ok('Conversión guardada.');
    } catch (e) { t.fail(e); }
  };
  return (
    <Card title="Conversiones de unidades" >
      {t.node}
      <p className="mb-3 text-sm text-slate-500">Cada conversión indica cuántas <b>{base?.code}</b> (unidad base de almacenamiento) equivalen a 1 unidad. Ej.: 1 CJ = 12 {base?.code}.
        {!material.allow_fraction && ' Este material no admite fracciones: las cantidades convertidas deben resultar en enteros.'}</p>
      <TableWrap><table className="table"><thead><tr><th>Unidad</th><th className="num">Equivale a</th><th>Compra</th><th>Consumo</th><th /></tr></thead><tbody>
        {(data ?? []).map((r) => {
          const u = units.find((x) => x.id === r.unit_id);
          const isBase = r.unit_id === material.base_unit_id;
          return <tr key={r.unit_id}><td>{u?.code} — {u?.name}{isBase && <Badge tone="blue">base</Badge>}</td><td className="num">{fmtQty(r.factor)} {base?.code}</td>
            <td>{r.is_purchase ? 'Sí' : 'No'}</td><td>{r.is_consumption ? 'Sí' : 'No'}</td>
            <td className="text-right">{canEdit && !isBase && <Button variant="ghost" icon={<Trash2 className="h-4 w-4 text-red-500" />} onClick={async () => {
              try { await run(supabase.from('material_units').delete().eq('material_id', material.id).eq('unit_id', r.unit_id)); reload(); invalidateCatalog('materialUnits'); } catch (e) { t.fail(e); }
            }} />}</td></tr>;
        })}
      </tbody></table></TableWrap>
      {canEdit && (
        <div className="mt-4 grid items-end gap-2 sm:grid-cols-5">
          <Field label="Unidad"><Select value={f.unit_id} onChange={(e) => setF({ ...f, unit_id: e.target.value })} placeholder="—" options={units.filter((u) => u.id !== material.base_unit_id).map((u) => ({ value: u.id, label: u.code }))} /></Field>
          <Field label={`Factor (en ${base?.code})`}><Input type="number" step="any" min={0} value={f.factor} onChange={(e) => setF({ ...f, factor: e.target.value })} /></Field>
          <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={f.is_purchase} onChange={(e) => setF({ ...f, is_purchase: e.target.checked })} />Compra</label>
          <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={f.is_consumption} onChange={(e) => setF({ ...f, is_consumption: e.target.checked })} />Consumo</label>
          <Button onClick={add}>Agregar / actualizar</Button>
        </div>
      )}
    </Card>
  );
}

function MaterialStock({ materialId }: { materialId: string }) {
  const { perms } = useAuth();
  const { data, loading } = useAsync(() => run(supabase.from('v_stock').select('*').eq('material_id', materialId).order('warehouse_code')), [materialId]);
  const val = useAsync(() => perms.viewCosts ? run(supabase.from('v_valuation').select('*').eq('material_id', materialId).maybeSingle()) : Promise.resolve(null), [materialId]);
  const tot = (k: string) => (data ?? []).reduce((s, r) => s + Number(r[k]), 0);
  return (
    <Card padded={false} title="Existencias por almacén, ubicación y lote" actions={perms.viewCosts && val.data && <span className="text-sm text-slate-600">Valor: <b>{fmtBOB(val.data.value)}</b> · Costo unitario: <b>{fmtBOB(val.data.unit_cost)}</b></span>}>
      {loading ? <Spinner /> : !data?.length ? <Empty>Sin existencias.</Empty> : (
        <TableWrap><table className="table"><thead><tr><th>Almacén</th><th>Ubicación</th><th>Lote</th><th>Vence</th><th className="num">En mano</th><th className="num">Reservado</th><th className="num">Disponible</th><th className="num">Bloqueado</th></tr></thead>
          <tbody>{data.map((r) => <tr key={r.id}><td>{r.warehouse_code}</td><td>{r.location_code ?? '—'}</td><td>{r.lot_code ?? '—'} {r.lot_status && r.lot_status !== 'disponible' && <Badge status={r.lot_status} />}</td>
            <td>{fmtDate(r.exp_date)}</td><td className="num">{fmtQty(r.qty_on_hand)}</td><td className="num">{fmtQty(r.qty_reserved)}</td><td className="num font-medium">{fmtQty(r.qty_available)}</td><td className="num text-red-600">{fmtQty(r.qty_blocked)}</td></tr>)}
            <tr className="font-semibold"><td colSpan={4}>Total</td><td className="num">{fmtQty(tot('qty_on_hand'))}</td><td className="num">{fmtQty(tot('qty_reserved'))}</td><td className="num">{fmtQty(tot('qty_available'))}</td><td className="num">{fmtQty(tot('qty_blocked'))}</td></tr>
          </tbody></table></TableWrap>
      )}
    </Card>
  );
}

function MaterialLots({ materialId }: { materialId: string }) {
  const { data, loading } = useAsync(() => run(supabase.from('v_lots').select('*').eq('material_id', materialId).order('exp_date', { nullsFirst: false })), [materialId]);
  return (
    <Card padded={false}>
      {loading ? <Spinner /> : !data?.length ? <Empty>Sin lotes.</Empty> : (
        <TableWrap><table className="table"><thead><tr><th>Lote</th><th>Fabricación</th><th>Vencimiento</th><th className="num">Vida útil</th><th className="num">Restante</th><th>Estado</th></tr></thead>
          <tbody>{data.map((l) => <tr key={l.id}><td><Link className="text-brand-700 hover:underline" to={`/lotes?lot=${l.id}`}>{l.lot_code}</Link></td><td>{fmtDate(l.mfg_date)}</td><td>{fmtDate(l.exp_date)}</td>
            <td className="num">{l.shelf_life_days != null ? `${l.shelf_life_days} d` : '—'}</td><td className="num">{l.remaining_days != null ? `${l.remaining_days} d${l.remaining_pct != null ? ` (${l.remaining_pct}%)` : ''}` : '—'}</td><td><Badge status={l.effective_status} /></td></tr>)}</tbody></table></TableWrap>
      )}
    </Card>
  );
}

function SerialsTab({ materialId, canEdit }: { materialId: string; canEdit: boolean }) {
  const { warehouses } = useAuth();
  return (
    <Card title="Números de serie" >
      <p className="mb-3 text-sm text-slate-500">Registro de seriales del material (control documental; las cantidades se mueven por documentos de inventario).</p>
      <CrudTableLazy materialId={materialId} canEdit={canEdit} whOpts={warehouses.map((w) => ({ value: w.id, label: w.code }))} />
    </Card>
  );
}

function CrudTableLazy({ materialId, canEdit, whOpts }: { materialId: string; canEdit: boolean; whOpts: { value: string; label: string }[] }) {
  return <CrudTable table="serial_numbers" orderBy="serial" canEdit={canEdit} defaults={{ material_id: materialId, status: 'en_stock' }}
    filter={(r) => r.material_id === materialId}
    transform={(f) => ({ ...f, material_id: materialId })}
    columns={[{ key: 'serial', label: 'Serie', required: true }, { key: 'warehouse_id', label: 'Almacén', type: 'select', options: whOpts },
      { key: 'status', label: 'Estado', type: 'select', options: ['en_stock', 'asignado', 'en_transito', 'baja'].map((s) => ({ value: s, label: s })) },
      { key: 'notes', label: 'Notas', type: 'textarea', hideInTable: true }]} />;
}
