import { useMemo, useState, type ReactNode } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { run, useAsync, type Row } from '../lib/api';
import { Alert, Badge, Button, Empty, Field, Input, Modal, Select, Spinner, TableWrap, Textarea } from './ui';

export interface Col {
  key: string; label: string;
  type?: 'text' | 'number' | 'bool' | 'select' | 'textarea' | 'date' | 'custom';
  options?: { value: string; label: string }[];
  required?: boolean; hideInTable?: boolean; hideInForm?: boolean; readOnlyOnEdit?: boolean;
  render?: (r: Row) => ReactNode;
  input?: (v: unknown, set: (v: unknown) => void, form: Row) => ReactNode;
  hint?: string;
}

/** Tabla CRUD genérica para catálogos (sin borrado físico: se usa "activo"). */
export default function CrudTable({ table, columns, select = '*', orderBy = 'created_at', ascending = true, canEdit, defaults = {}, filter, onSaved, extraActions, transform }: {
  table: string; columns: Col[]; select?: string; orderBy?: string; ascending?: boolean; canEdit: boolean;
  defaults?: Row; filter?: (r: Row) => boolean; onSaved?: () => void; extraActions?: (r: Row) => ReactNode; transform?: (form: Row) => Row;
}) {
  const { data, loading, error, reload } = useAsync(() => run(supabase.from(table).select(select).order(orderBy, { ascending })) as Promise<Row[]>, [table, select]);
  const [edit, setEdit] = useState<Row | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const rows = useMemo(() => {
    const t = q.toLowerCase();
    return (data ?? []).filter((r) => (!filter || filter(r)) && (!t || JSON.stringify(r).toLowerCase().includes(t)));
  }, [data, q, filter]);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const payload: Row = {};
      for (const c of columns) {
        if (c.hideInForm || c.type === 'custom' && !c.input) continue;
        let v = edit![c.key];
        if (c.type === 'number') v = v === '' || v === null || v === undefined ? null : Number(v);
        if ((c.type === 'select' || c.type === 'date' || c.type === 'text') && v === '') v = null;
        if (c.required && (v === null || v === undefined || v === '')) throw new Error(`Complete el campo “${c.label}”.`);
        payload[c.key] = v;
      }
      const final = transform ? transform(payload) : payload;
      if (edit!.id) await run(supabase.from(table).update(final).eq('id', edit!.id));
      else await run(supabase.from(table).insert(final));
      setEdit(null); reload(); onSaved?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const tableCols = columns.filter((c) => !c.hideInTable);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Input className="max-w-xs" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        {canEdit && <Button icon={<Plus className="h-4 w-4" />} onClick={() => { setErr(''); setEdit({ ...defaults }); }}>Nuevo</Button>}
      </div>
      <Alert>{error}</Alert>
      {loading ? <Spinner /> : !rows.length ? <Empty /> : (
        <TableWrap>
          <table className="table">
            <thead><tr>{tableCols.map((c) => <th key={c.key}>{c.label}</th>)}<th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {tableCols.map((c) => (
                    <td key={c.key} className={c.type === 'number' ? 'num' : ''}>
                      {c.render ? c.render(r) : c.type === 'bool' ? <Badge tone={r[c.key] ? 'green' : 'slate'}>{r[c.key] ? 'Sí' : 'No'}</Badge>
                        : c.type === 'select' ? c.options?.find((o) => o.value === r[c.key])?.label ?? '—' : (r[c.key] ?? '—')}
                    </td>
                  ))}
                  <td className="whitespace-nowrap text-right">
                    {extraActions?.(r)}
                    {canEdit && <Button variant="ghost" onClick={() => { setErr(''); setEdit({ ...r }); }} icon={<Pencil className="h-4 w-4" />} title="Editar" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <Modal open={!!edit} title={edit?.id ? 'Editar' : 'Nuevo registro'} onClose={() => setEdit(null)}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button loading={busy} onClick={save}>Guardar</Button></>}>
        <Alert>{err}</Alert>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            {columns.filter((c) => !c.hideInForm).map((c) => {
              const v = edit[c.key];
              const set = (nv: unknown) => setEdit((e) => ({ ...e!, [c.key]: nv }));
              const ro = !!edit.id && c.readOnlyOnEdit;
              const wide = c.type === 'textarea' || c.type === 'custom';
              return (
                <Field key={c.key} label={c.label + (c.required ? ' *' : '')} hint={c.hint} className={wide ? 'sm:col-span-2' : ''}>
                  {c.input ? c.input(v, set, edit)
                    : c.type === 'bool' ? <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} />Sí</label>
                    : c.type === 'select' ? <Select disabled={ro} value={(v as string) ?? ''} onChange={(e) => set(e.target.value)} placeholder="—" options={c.options ?? []} />
                    : c.type === 'textarea' ? <Textarea value={(v as string) ?? ''} onChange={(e) => set(e.target.value)} />
                    : <Input disabled={ro} type={c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text'} step="any" value={(v as string) ?? ''} onChange={(e) => set(e.target.value)} />}
                </Field>
              );
            })}
          </div>
        )}
      </Modal>
    </div>
  );
}
