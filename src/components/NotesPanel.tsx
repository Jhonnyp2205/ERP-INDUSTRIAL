import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { run, useAsync } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { Alert, Button, Empty, Spinner, Textarea } from './ui';

/** Observaciones inmutables asociadas a un registro. */
export default function NotesPanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { perms, profile } = useAuth();
  const { data, loading, reload } = useAsync(() =>
    run(supabase.from('record_notes').select('*, author:profiles(full_name)').eq('entity_type', entityType).eq('entity_id', entityId).order('created_at', { ascending: false })),
  [entityType, entityId]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const add = async () => {
    setBusy(true); setErr('');
    try {
      await run(supabase.from('record_notes').insert({ entity_type: entityType, entity_id: entityId, note: text.trim(), created_by: profile!.id }));
      setText(''); reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <Alert>{err}</Alert>
      {perms.writeNotes && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <Textarea rows={2} value={text} placeholder="Agregar observación (no se puede editar después)…" onChange={(e) => setText(e.target.value)} />
          <Button className="sm:self-start" disabled={!text.trim()} loading={busy} onClick={add}>Agregar</Button>
        </div>
      )}
      {loading ? <Spinner /> : !data?.length ? <Empty>Sin observaciones.</Empty> : (
        <ul className="space-y-3">
          {data.map((n) => (
            <li key={n.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <p className="whitespace-pre-wrap text-sm">{n.note}</p>
              <p className="mt-1 text-xs text-slate-400">{n.author?.full_name} · {fmtDateTime(n.created_at)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
