import { useRef, useState } from 'react';
import { Download, FileUp, RefreshCw, Trash2 } from 'lucide-react';
import { supabase, BUCKET } from '../lib/supabase';
import { errMsg, rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { Alert, Badge, Button, Empty, Field, Input, Modal, ReasonDialog, Select, Spinner, TableWrap } from './ui';

export type EntityType = 'material' | 'lot' | 'asset' | 'work_order' | 'incident';
const fkCol: Record<EntityType, string> = { material: 'material_id', lot: 'lot_id', asset: 'asset_id', work_order: 'work_order_id', incident: 'incident_id' };

export const DOC_CATEGORIES = [
  { value: 'ficha_tecnica', label: 'Ficha técnica' }, { value: 'certificado', label: 'Certificado' },
  { value: 'hoja_seguridad', label: 'Hoja de seguridad' }, { value: 'manual', label: 'Manual' },
  { value: 'foto', label: 'Fotografía' }, { value: 'inspeccion', label: 'Inspección' }, { value: 'otro', label: 'Otro' },
];
const MAX_MB = 25;

/** Descarga con URL firmada de 60 segundos: el archivo nunca queda público. */
export async function openDocument(path: string) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data) throw new Error('No tiene acceso a este archivo o ya no existe.');
  window.open(data.signedUrl, '_blank', 'noopener');
}

export default function DocumentsPanel({ entityType, entityId }: { entityType: EntityType; entityId: string }) {
  const { perms, profile } = useAuth();
  const [showAll, setShowAll] = useState(false);
  const { data, loading, reload } = useAsync(() =>
    run(supabase.from('documents').select('*, uploader:profiles!documents_uploaded_by_fkey(full_name)').eq(fkCol[entityType], entityId).order('uploaded_at', { ascending: false })),
  [entityType, entityId]);
  const [upload, setUpload] = useState<{ replaces?: Row } | null>(null);
  const [retire, setRetire] = useState<Row | null>(null);
  const [err, setErr] = useState('');

  const rows = (data ?? []).filter((d) => showAll || d.status === 'vigente');

  return (
    <div>
      <Alert>{err}</Alert>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />Mostrar versiones anteriores y retirados
        </label>
        {perms.uploadDocs && <Button icon={<FileUp className="h-4 w-4" />} onClick={() => setUpload({})}>Subir documento</Button>}
      </div>
      {loading ? <Spinner /> : rows.length === 0 ? <Empty>No hay documentos.</Empty> : (
        <TableWrap>
          <table className="table">
            <thead><tr><th>Título</th><th>Tipo</th><th>Versión</th><th>Estado</th><th>Subido</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td><div className="font-medium">{d.title}</div><div className="text-xs text-slate-400">{d.file_name}{d.is_controlled && ' · controlado'}</div></td>
                  <td>{DOC_CATEGORIES.find((c) => c.value === d.doc_category)?.label}</td>
                  <td>v{d.version}</td>
                  <td><Badge status={d.status} />{d.delete_reason && <div className="text-xs text-slate-400">{d.delete_reason}</div>}</td>
                  <td className="text-xs">{fmtDateTime(d.uploaded_at)}<div className="text-slate-400">{d.uploader?.full_name}</div></td>
                  <td className="whitespace-nowrap text-right">
                    <Button variant="ghost" title="Descargar" onClick={() => openDocument(d.storage_path).catch((e) => setErr(e.message))} icon={<Download className="h-4 w-4" />} />
                    {d.status === 'vigente' && perms.uploadDocs && <Button variant="ghost" title="Reemplazar por nueva versión" onClick={() => setUpload({ replaces: d })} icon={<RefreshCw className="h-4 w-4" />} />}
                    {d.status === 'vigente' && (perms.isAdmin || (perms.uploadDocs && d.uploaded_by === profile?.id && !d.is_controlled)) &&
                      <Button variant="ghost" title="Retirar" onClick={() => setRetire(d)} icon={<Trash2 className="h-4 w-4 text-red-500" />} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <UploadDialog open={!!upload} replaces={upload?.replaces} entityType={entityType} entityId={entityId}
        onClose={() => setUpload(null)} onDone={reload} canControl={perms.isAdmin} />
      <ReasonDialog open={!!retire} title="Retirar documento" variant="danger" confirmText="Retirar"
        onClose={() => setRetire(null)} onConfirm={async (r) => { await rpc('retire_document', { p_id: retire!.id, p_reason: r }); reload(); }} />
    </div>
  );
}

function UploadDialog({ open, onClose, onDone, entityType, entityId, replaces, canControl }: {
  open: boolean; onClose: () => void; onDone: () => void; entityType: EntityType; entityId: string; replaces?: Row; canControl: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [cat, setCat] = useState('ficha_tecnica');
  const [controlled, setControlled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) { setErr('Seleccione un archivo.'); return; }
    if (file.size > MAX_MB * 1024 * 1024) { setErr(`El archivo supera ${MAX_MB} MB.`); return; }
    setBusy(true); setErr('');
    try {
      const safe = file.name.normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-80);
      const path = `${entityType}/${entityId}/${crypto.randomUUID()}-${safe}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new Error(errMsg(error));
      await rpc('register_document', { p: {
        entity_type: entityType, entity_id: entityId, storage_path: path, file_name: file.name, mime_type: file.type,
        size_bytes: file.size, title: title || replaces?.title || file.name, doc_category: replaces?.doc_category ?? cat,
        replaces_id: replaces?.id ?? null, is_controlled: replaces ? undefined : controlled,
      } });
      onDone(); onClose(); setTitle('');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={replaces ? `Nueva versión de “${replaces.title}”` : 'Subir documento'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} onClick={submit}>Subir</Button></>}>
      <Alert>{err}</Alert>
      <div className="space-y-3">
        <Field label="Archivo" hint={`PDF, imágenes, Word, Excel. Máx. ${MAX_MB} MB.`}><input ref={fileRef} type="file" className="input" /></Field>
        <Field label="Título"><Input value={title} placeholder={replaces?.title} onChange={(e) => setTitle(e.target.value)} /></Field>
        {!replaces && <Field label="Tipo"><Select value={cat} onChange={(e) => setCat(e.target.value)} options={DOC_CATEGORIES} /></Field>}
        {!replaces && canControl && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={controlled} onChange={(e) => setControlled(e.target.checked)} />Documento controlado (solo un administrador podrá retirarlo)</label>
        )}
      </div>
    </Modal>
  );
}
