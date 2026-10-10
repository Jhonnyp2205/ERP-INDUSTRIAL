import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { Row } from './api';

type Key = 'materials' | 'units' | 'materialUnits' | 'categories' | 'suppliers' | 'locations' | 'profiles' | 'assets';

const queries: Record<Key, () => PromiseLike<{ data: Row[] | null }>> = {
  materials: () => supabase.from('materials').select('id,sku,name,barcode,internal_code,base_unit_id,allow_fraction,lot_controlled,expiry_controlled,active').order('sku'),
  units: () => supabase.from('units_of_measure').select('*').order('code'),
  materialUnits: () => supabase.from('material_units').select('*'),
  categories: () => supabase.from('categories').select('*').order('name'),
  suppliers: () => supabase.from('suppliers').select('*').order('name'),
  locations: () => supabase.from('locations').select('*').order('code'),
  profiles: () => supabase.from('profiles').select('id,full_name,email,role,active').order('full_name'),
  assets: () => supabase.from('assets').select('id,code,name,warehouse_id,status').order('code'),
};

const cache = new Map<Key, Row[]>();
const listeners = new Map<Key, Set<(r: Row[]) => void>>();

export async function loadCatalog(k: Key, force = false): Promise<Row[]> {
  if (!force && cache.has(k)) return cache.get(k)!;
  const { data } = await queries[k]();
  cache.set(k, data ?? []);
  listeners.get(k)?.forEach((fn) => fn(data ?? []));
  return data ?? [];
}

export function invalidateCatalog(...keys: Key[]) {
  keys.forEach((k) => { cache.delete(k); loadCatalog(k, true); });
}

export function clearCatalogs() { cache.clear(); }

export function useCatalog(k: Key): Row[] {
  const [rows, setRows] = useState<Row[]>(cache.get(k) ?? []);
  useEffect(() => {
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k)!.add(setRows);
    loadCatalog(k).then(setRows);
    return () => { listeners.get(k)!.delete(setRows); };
  }, [k]);
  return rows;
}

/** Busca un código escaneado: material (barcode/sku/código interno), ubicación o lote. */
export async function lookupCode(code: string): Promise<{ kind: 'material' | 'location' | 'lot' | 'asset'; row: Row } | null> {
  const c = code.trim().replace(/[",()]/g, '');
  if (!c) return null;
  const mats = await loadCatalog('materials');
  const m = mats.find((x) => x.barcode === c || x.sku === c || x.internal_code === c);
  if (m) return { kind: 'material', row: m };
  const { data: loc } = await supabase.from('locations').select('*').or(`barcode.eq."${c}",code.eq."${c}"`).limit(1);
  if (loc?.length) return { kind: 'location', row: loc[0] };
  if (c.startsWith('LOT:')) {
    const { data: lot } = await supabase.from('lots').select('*').eq('id', c.slice(4)).maybeSingle();
    if (lot) return { kind: 'lot', row: lot };
  }
  const { data: asset } = await supabase.from('assets').select('*').or(`barcode.eq."${c}",code.eq."${c}"`).limit(1);
  if (asset?.length) return { kind: 'asset', row: asset[0] };
  return null;
}
