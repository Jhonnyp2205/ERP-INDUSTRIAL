import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

/** Traduce errores técnicos a mensajes de negocio sin exponer detalles internos. */
export function errMsg(e: unknown): string {
  const raw = (e as { message?: string })?.message ?? String(e);
  if (raw.includes('ERP:')) return raw.slice(raw.indexOf('ERP:') + 4).trim();
  if (/row-level security|permission denied|42501/i.test(raw)) return 'No tiene permiso para realizar esta acción.';
  if (/duplicate key/i.test(raw)) return 'Ya existe un registro con ese código o valor único.';
  if (/violates foreign key/i.test(raw)) return 'El registro está relacionado con otros datos y no puede modificarse así.';
  if (/violates check constraint/i.test(raw)) return 'Algún valor no cumple las reglas de validación.';
  if (/JWT|session/i.test(raw)) return 'Su sesión expiró. Vuelva a iniciar sesión.';
  if (/Failed to fetch|NetworkError/i.test(raw)) return 'Sin conexión con el servidor. Revise su internet.';
  console.error(e);
  return 'Ocurrió un error inesperado. Intente nuevamente.';
}

export async function rpc<T = unknown>(fn: string, args?: Row): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args ?? {});
  if (error) throw new Error(errMsg(error));
  return data as T;
}

/** Ejecuta una consulta de Supabase y lanza error amigable. */
/** Resultado flexible: sirve como lista (Row[]) o como fila única (Row). */
export type Rows = Row[] & Row;

export async function run<T = Rows>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(errMsg(error));
  return data as T;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await fn();
      if (my === seq.current) setData(r);
    } catch (e) {
      if (my === seq.current) setError(errMsg(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function newKey(): string {
  return crypto.randomUUID();
}
