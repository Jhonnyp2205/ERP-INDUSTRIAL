import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useCatalog } from '../lib/catalogs';
import { useAuth } from '../lib/auth';
import type { Row } from '../lib/api';
import { fmtDate, fmtQty } from '../lib/format';
import { Select } from './ui';

/** Selector buscable genérico. */
export function SearchSelect({ value, onChange, options, placeholder = 'Buscar…', disabled }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string; hint?: string }[]; placeholder?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const t = q.toLowerCase();
    return options.filter((o) => !t || o.label.toLowerCase().includes(t) || o.hint?.toLowerCase().includes(t)).slice(0, 80);
  }, [q, options]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button type="button" disabled={disabled} onClick={() => setOpen(!open)} className="input flex items-center justify-between text-left">
        <span className={`truncate ${current ? '' : 'text-slate-400'}`}>{current?.label ?? placeholder}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[260px] rounded-lg border border-slate-200 bg-white shadow-lg">
          <input autoFocus className="w-full border-b border-slate-100 px-3 py-2 text-sm outline-none" placeholder="Escriba para filtrar…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.map((o) => (
              <li key={o.value}>
                <button type="button" onClick={() => { onChange(o.value); setOpen(false); setQ(''); }}
                  className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-brand-50 ${o.value === value ? 'bg-brand-50 font-medium' : ''}`}>
                  {o.label}{o.hint && <span className="ml-1 text-xs text-slate-400">{o.hint}</span>}
                </button>
              </li>
            ))}
            {!filtered.length && <li className="px-3 py-2 text-sm text-slate-400">Sin resultados</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

export function MaterialSelect({ value, onChange, includeInactive }: { value: string; onChange: (v: string) => void; includeInactive?: boolean }) {
  const mats = useCatalog('materials');
  const opts = useMemo(() => mats.filter((m) => includeInactive || m.active).map((m) => ({ value: m.id, label: `${m.sku} — ${m.name}`, hint: m.barcode ?? '' })), [mats, includeInactive]);
  return <SearchSelect value={value} onChange={onChange} options={opts} placeholder="Seleccione material" />;
}

export function WarehouseSelect({ value, onChange, placeholder = 'Seleccione almacén', all }: { value: string; onChange: (v: string) => void; placeholder?: string; all?: boolean }) {
  const { warehouses } = useAuth();
  const [allWh, setAllWh] = useState<Row[]>([]);
  useEffect(() => { if (all) supabase.from('warehouses').select('*').eq('active', true).order('code').then(({ data }) => setAllWh(data ?? [])); }, [all]);
  const list = all ? allWh : warehouses.filter((w) => w.active);
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} options={list.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))} />;
}

export function LocationSelect({ warehouseId, value, onChange, placeholder = 'Sin ubicación específica' }: { warehouseId?: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const locs = useCatalog('locations');
  const opts = locs.filter((l) => l.warehouse_id === warehouseId && l.active).map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` }));
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} options={opts} disabled={!warehouseId} />;
}

export function UnitSelect({ materialId, value, onChange }: { materialId: string; value: string; onChange: (v: string) => void }) {
  const units = useCatalog('units');
  const mu = useCatalog('materialUnits');
  const opts = mu.filter((x) => x.material_id === materialId).map((x) => {
    const u = units.find((y) => y.id === x.unit_id);
    return { value: x.unit_id, label: `${u?.code ?? '?'}${Number(x.factor) !== 1 ? ` (×${fmtQty(x.factor)})` : ''}` };
  });
  return <Select value={value} onChange={(e) => onChange(e.target.value)} options={opts} disabled={!materialId} />;
}

/** Lotes con existencia disponible del material en el almacén (ordenados FEFO). */
export function LotSelect({ materialId, warehouseId, value, onChange, placeholder = 'Automático (FEFO)', allLots }: {
  materialId: string; warehouseId?: string; value: string; onChange: (v: string) => void; placeholder?: string; allLots?: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (!materialId) { setRows([]); return; }
    if (allLots) {
      supabase.from('lots').select('id,lot_code,exp_date,status').eq('material_id', materialId).order('exp_date', { nullsFirst: false })
        .then(({ data }) => setRows((data ?? []).map((l) => ({ lot_id: l.id, lot_code: l.lot_code, exp_date: l.exp_date, lot_status: l.status, qty_available: null }))));
      return;
    }
    let q = supabase.from('v_stock').select('lot_id,lot_code,exp_date,lot_status,qty_available,location_code').eq('material_id', materialId).not('lot_id', 'is', null);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    q.order('exp_date', { ascending: true, nullsFirst: false }).then(({ data }) => setRows(data ?? []));
  }, [materialId, warehouseId, allLots]);
  const byLot = new Map<string, Row>();
  rows.forEach((r) => {
    const cur = byLot.get(r.lot_id);
    byLot.set(r.lot_id, cur && r.qty_available != null ? { ...cur, qty_available: Number(cur.qty_available) + Number(r.qty_available) } : { ...r });
  });
  const opts = [...byLot.values()].map((r) => ({
    value: r.lot_id,
    label: `${r.lot_code} · vence ${fmtDate(r.exp_date)}${r.qty_available != null ? ` · disp. ${fmtQty(r.qty_available)}` : ''}${r.lot_status !== 'disponible' ? ` · ${r.lot_status.toUpperCase()}` : ''}`,
  }));
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} options={opts} disabled={!materialId} />;
}

export function UserSelect({ value, onChange, placeholder = 'Sin asignar', roles }: { value: string; onChange: (v: string) => void; placeholder?: string; roles?: string[] }) {
  const users = useCatalog('profiles');
  const opts = users.filter((u) => u.active && (!roles || roles.includes(u.role))).map((u) => ({ value: u.id, label: u.full_name || u.email }));
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} options={opts} />;
}
