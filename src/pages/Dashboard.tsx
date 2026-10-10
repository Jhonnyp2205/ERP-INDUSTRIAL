import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CheckSquare, Lock, SprayCan, Thermometer, Truck, Wrench, Wallet } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { rpc, run, useAsync, type Row } from '../lib/api';
import { useAuth, useCanApproveIn } from '../lib/auth';
import { DOC_TYPE_LABEL, fmtBOB, fmtDate, fmtDateTime, fmtQty } from '../lib/format';
import { Alert, Badge, Card, Empty, PageHeader, Spinner, TableWrap } from '../components/ui';

function Stat({ icon, label, value, to, tone = 'text-slate-900' }: { icon: React.ReactNode; label: string; value: React.ReactNode; to?: string; tone?: string }) {
  const body = (
    <div className="card flex items-center gap-3 p-4 transition hover:shadow-md">
      <div className="rounded-lg bg-slate-100 p-2 text-slate-600 [&>svg]:h-5 [&>svg]:w-5">{icon}</div>
      <div><div className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</div><div className="text-xs text-slate-500">{label}</div></div>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export default function Dashboard() {
  const { profile, perms } = useAuth();
  const sum = useAsync(() => rpc<Row>('dashboard_summary'), []);
  const expiring = useAsync(() => run(supabase.from('v_lots').select('id,sku,material_name,lot_code,exp_date,remaining_days,effective_status')
    .in('effective_status', ['por_vencer', 'vencido']).order('exp_date').limit(8)), []);
  const recent = useAsync(() => run(supabase.from('v_movements').select('id,created_at,movement_type,sku,qty,warehouse_code,doc_number,transfer_number').order('created_at', { ascending: false }).limit(8)), []);

  // Genera alertas internas (vencimientos, mantenimiento, limpieza). Limitado a 1 vez cada 30 min en la base.
  useEffect(() => { rpc('generate_alerts', { p_force: false }).then(() => sum.reload()).catch(() => {}); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = sum.data ?? {};
  return (
    <div>
      <PageHeader title={`Hola, ${profile?.full_name?.split(' ')[0] || 'bienvenido'}`} subtitle={`Método de valoración activo: ${s.valuation_method === 'fifo' ? 'FIFO' : 'Promedio ponderado'} · Moneda BOB`} />
      <Alert>{sum.error}</Alert>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {perms.approve && <Stat icon={<CheckSquare />} label="Aprobaciones pendientes" value={s.pending_approvals ?? '…'} to="/aprobaciones" tone={s.pending_approvals ? 'text-amber-600' : undefined} />}
        <Stat icon={<CalendarClock />} label="Lotes por vencer (con stock)" value={s.lots_expiring ?? '…'} to="/lotes?f=por_vencer" tone={s.lots_expiring ? 'text-amber-600' : undefined} />
        <Stat icon={<Lock />} label="Lotes bloqueados / cuarentena" value={s.lots_blocked ?? '…'} to="/lotes?f=bloqueados" />
        <Stat icon={<Truck />} label="Traslados en tránsito" value={s.in_transit ?? '…'} to="/traslados" />
        <Stat icon={<Wrench />} label={`OT abiertas (${s.overdue_work_orders ?? 0} atrasadas)`} value={s.open_work_orders ?? '…'} to="/mantenimiento/ordenes" tone={s.overdue_work_orders ? 'text-red-600' : undefined} />
        <Stat icon={<AlertTriangle />} label="Incidencias abiertas" value={s.open_incidents ?? '…'} to="/calidad/incidencias" />
        <Stat icon={<SprayCan />} label="Limpiezas pendientes" value={s.cleaning_pending ?? '…'} to="/calidad/limpieza" />
        <Stat icon={<Thermometer />} label="Mediciones fuera de rango (7 días)" value={s.out_of_range_7d ?? '…'} to="/calidad/mediciones" tone={s.out_of_range_7d ? 'text-red-600' : undefined} />
        {perms.viewCosts && <Stat icon={<Wallet />} label="Valor del inventario" value={fmtBOB(s.inventory_value)} to="/informes" />}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {perms.approve && <PendingApprovals compact />}
        <Card title="Vencimientos próximos" actions={<Link className="text-sm text-brand-700" to="/lotes">Ver todo</Link>} padded={false}>
          {expiring.loading ? <Spinner /> : !expiring.data?.length ? <Empty>Sin lotes por vencer.</Empty> : (
            <TableWrap><table className="table"><thead><tr><th>Material</th><th>Lote</th><th>Vence</th><th>Estado</th></tr></thead><tbody>
              {expiring.data.map((l) => <tr key={l.id}><td>{l.sku}<div className="text-xs text-slate-400">{l.material_name}</div></td><td>{l.lot_code}</td><td>{fmtDate(l.exp_date)}<div className="text-xs text-slate-400">{l.remaining_days} días</div></td><td><Badge status={l.effective_status} /></td></tr>)}
            </tbody></table></TableWrap>
          )}
        </Card>
        <Card title="Últimos movimientos" padded={false} className="lg:col-span-2">
          {recent.loading ? <Spinner /> : !recent.data?.length ? <Empty /> : (
            <TableWrap><table className="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Material</th><th>Almacén</th><th className="num">Cantidad</th><th>Documento</th></tr></thead><tbody>
              {recent.data.map((m) => <tr key={m.id}><td className="text-xs">{fmtDateTime(m.created_at)}</td><td>{m.movement_type}</td><td>{m.sku}</td><td>{m.warehouse_code}</td>
                <td className={`num ${Number(m.qty) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtQty(m.qty)}</td><td>{m.doc_number ?? m.transfer_number}</td></tr>)}
            </tbody></table></TableWrap>
          )}
        </Card>
      </div>
    </div>
  );
}

export function PendingApprovals({ compact }: { compact?: boolean }) {
  const { profile } = useAuth();
  const canApprove = useCanApproveIn();
  const { data, loading, error } = useAsync(() => run(supabase.from('v_pending_approvals').select('*').order('created_at')), []);
  const rows = (data ?? []).filter((r) => canApprove(r.warehouse_id) || r.status === 'con_diferencias');
  const content = loading ? <Spinner /> : !rows.length ? <Empty>No hay operaciones pendientes.</Empty> : (
    <TableWrap><table className="table"><thead><tr><th>Número</th><th>Tipo</th><th>Estado</th><th>Almacén</th><th>Creado por</th><th>Fecha</th></tr></thead><tbody>
      {rows.slice(0, compact ? 6 : 500).map((r) => (
        <tr key={r.kind + r.id}>
          <td><Link className="font-medium text-brand-700 hover:underline" to={r.link}>{r.number}</Link></td>
          <td>{DOC_TYPE_LABEL[r.subtype] ?? 'Traslado'}</td>
          <td><Badge status={r.status} /></td>
          <td>{r.warehouse_name}</td>
          <td>{r.created_by_name}{r.created_by === profile?.id && <div className="text-xs text-amber-600">propio: otro supervisor debe aprobar</div>}</td>
          <td className="text-xs">{fmtDateTime(r.created_at)}</td>
        </tr>
      ))}
    </tbody></table></TableWrap>
  );
  if (compact) return <Card title="Pendientes de aprobación" actions={<Link className="text-sm text-brand-700" to="/aprobaciones">Ver todo</Link>} padded={false}>{content}</Card>;
  return (
    <div>
      <PageHeader title="Aprobaciones pendientes" subtitle="Salidas, ajustes, traslados, despachos y diferencias. Nadie aprueba lo que creó." />
      <Alert>{error}</Alert>
      <Card padded={false}>{content}</Card>
    </div>
  );
}
