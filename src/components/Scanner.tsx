import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { Camera, ScanLine } from 'lucide-react';
import { Button, Modal } from './ui';

/** Lector por cámara (Chrome, Edge, Android, iOS Safari) usando ZXing. */
export function CameraScanner({ open, onClose, onCode }: { open: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    let controls: IScannerControls | undefined;
    let done = false;
    const reader = new BrowserMultiFormatReader();
    setErr('');
    reader.decodeFromVideoDevice(undefined, videoRef.current!, (result, _e, c) => {
      controls = c;
      if (result && !done) {
        done = true;
        c.stop();
        onCode(result.getText());
        onClose();
      }
    }).then((c) => { controls = c; }).catch(() => setErr('No se pudo acceder a la cámara. Revise los permisos del navegador (requiere HTTPS).'));
    return () => controls?.stop();
  }, [open, onClose, onCode]);
  return (
    <Modal open={open} title="Escanear con cámara" onClose={onClose}>
      {err ? <p className="text-sm text-red-600">{err}</p> : (
        <div className="relative overflow-hidden rounded-lg bg-black">
          <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" />
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">Apunte al código de barras o QR del material, lote o ubicación.</p>
    </Modal>
  );
}

/**
 * Campo de escaneo: los lectores USB actúan como teclado y envían Enter al final.
 * También ofrece botón de cámara.
 */
export function ScanInput({ onCode, placeholder = 'Escanear o escribir código y Enter…', autoFocus }: { onCode: (code: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [v, setV] = useState('');
  const [cam, setCam] = useState(false);
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input className="input pl-9" value={v} placeholder={placeholder} autoFocus={autoFocus}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (v.trim()) { onCode(v.trim()); setV(''); } } }} />
      </div>
      <Button type="button" variant="secondary" onClick={() => setCam(true)} icon={<Camera className="h-4 w-4" />} title="Usar cámara" />
      <CameraScanner open={cam} onClose={() => setCam(false)} onCode={onCode} />
    </div>
  );
}
