const bob = new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB', minimumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat('es-BO', { maximumFractionDigits: 6 });

export const fmtBOB = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : bob.format(Number(v)));
export const fmtQty = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : qtyFmt.format(Number(v)));
export const fmtDate = (v: unknown) => {
  if (!v) return '—';
  const s = String(v);
  const d = s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s);
  return d.toLocaleDateString('es-BO', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
export const fmtDateTime = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('es-BO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const today = () => new Date().toISOString().slice(0, 10);

export const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador', supervisor: 'Supervisor de almacén', operador: 'Operador de almacén',
  mantenimiento: 'Mantenimiento', calidad: 'Calidad / Inspección', consulta: 'Consulta',
};

export const DOC_TYPE_LABEL: Record<string, string> = {
  entrada: 'Recepción', devolucion: 'Devolución', salida: 'Salida', ajuste: 'Ajuste',
};

export const MOVEMENT_LABEL: Record<string, string> = {
  entrada: 'Entrada', devolucion: 'Devolución', salida: 'Salida', ajuste_pos: 'Ajuste +', ajuste_neg: 'Ajuste −',
  traslado_salida: 'Traslado (salida)', traslado_entrada: 'Traslado (entrada)', traslado_baja: 'Baja en traslado',
};

const tone: Record<string, string> = {
  borrador: 'slate', pendiente: 'amber', aprobado: 'blue', confirmado: 'green', rechazado: 'red', anulado: 'slate',
  disponible: 'green', cuarentena: 'amber', bloqueado: 'red', vencido: 'red', por_vencer: 'amber',
  preparado: 'blue', en_transito: 'violet', recibido_parcial: 'amber', recibido: 'green', con_diferencias: 'red', cerrado: 'slate',
  abierta: 'amber', en_progreso: 'blue', en_espera: 'slate', completada: 'green', cancelada: 'slate', cerrada: 'slate',
  operativo: 'green', en_mantenimiento: 'amber', fuera_de_servicio: 'red', baja: 'slate',
  pendiente_tarea: 'amber', incumplida: 'red', verificada: 'green', en_proceso: 'blue', abierto: 'amber',
  vigente: 'green', reemplazado: 'slate', eliminado: 'red', aplicada: 'green', aprobada: 'blue', rechazada: 'red', anulada: 'slate',
  critica: 'red', alta: 'amber', media: 'blue',
};
export const statusTone = (s: string) => tone[s] ?? 'slate';
export const statusLabel = (s: string) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');
