import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Row } from './api';

export type Role = 'admin' | 'supervisor' | 'operador' | 'mantenimiento' | 'calidad' | 'consulta';

export interface Profile { id: string; email: string; full_name: string; role: Role; active: boolean }

/**
 * Permisos de INTERFAZ (solo ocultan botones). La seguridad real está en RLS y
 * en las funciones de PostgreSQL: si alguien fuerza la interfaz, la base rechaza la acción.
 */
export function buildPerms(role: Role | undefined) {
  const is = (...r: Role[]) => !!role && r.includes(role);
  return {
    isAdmin: is('admin'),
    viewCosts: is('admin', 'supervisor'),
    manageCatalogs: is('admin', 'supervisor'),
    createInventoryDocs: is('admin', 'supervisor', 'operador'),
    createIssues: is('admin', 'supervisor', 'operador', 'mantenimiento'),
    confirmReceipts: is('admin', 'supervisor'),
    approve: is('admin', 'supervisor'),
    lotStatus: is('admin', 'supervisor', 'calidad'),
    manageMaintenance: is('admin', 'mantenimiento'),
    createWorkOrders: is('admin', 'mantenimiento', 'supervisor', 'operador', 'calidad'),
    recordMeasurements: is('admin', 'supervisor', 'operador', 'calidad', 'mantenimiento'),
    manageQuality: is('admin', 'supervisor', 'calidad'),
    uploadDocs: is('admin', 'supervisor', 'mantenimiento', 'calidad'),
    writeNotes: !!role && role !== 'consulta',
    reportIncidents: is('admin', 'supervisor', 'operador', 'mantenimiento', 'calidad'),
  };
}
export type Perms = ReturnType<typeof buildPerms>;

interface AuthCtx {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  perms: Perms;
  warehouses: Row[];          // almacenes visibles para el usuario
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [warehouses, setWarehouses] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (s: Session | null) => {
    if (!s) { setProfile(null); setWarehouses([]); setLoading(false); return; }
    const { data: p } = await supabase.from('profiles').select('id,email,full_name,role,active').eq('id', s.user.id).maybeSingle();
    setProfile((p as Profile) ?? null);
    if (p?.role === 'admin') {
      const { data } = await supabase.from('warehouses').select('*').order('code');
      setWarehouses(data ?? []);
    } else if (p) {
      const { data } = await supabase.from('user_warehouse_access').select('warehouse:warehouses(*)').eq('user_id', s.user.id);
      setWarehouses(((data ?? []) as Row[]).map((r) => r.warehouse).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code)));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); load(data.session); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') { setLoading(true); load(s); }
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const value = useMemo<AuthCtx>(() => ({
    session, profile, loading, warehouses,
    perms: buildPerms(profile?.active ? profile.role : undefined),
    refresh: () => load(session),
    signOut: async () => { await supabase.auth.signOut(); },
  }), [session, profile, loading, warehouses, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth fuera de AuthProvider');
  return c;
}

/** ¿Puede aprobar en este almacén? (interfaz) */
export function useCanApproveIn() {
  const { perms, warehouses } = useAuth();
  return (whId?: string | null) => perms.isAdmin || (perms.approve && !!whId && warehouses.some((w) => w.id === whId));
}
