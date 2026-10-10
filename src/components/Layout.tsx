import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Bell, Boxes, CalendarClock, CheckSquare, ClipboardCheck, ClipboardList, FileText, Gauge, History, LayoutDashboard,
  LogOut, Menu, Package, PackageMinus, PackagePlus, Repeat, Settings, ShieldCheck, SprayCan, Thermometer, TriangleAlert,
  Truck, Undo2, Users, Warehouse, Wrench, BarChart3, Tags, X, Factory,
} from 'lucide-react';
import { useAuth, type Perms } from '../lib/auth';
import { ROLE_LABEL } from '../lib/format';
import { supabase } from '../lib/supabase';

interface Item { to: string; label: string; icon: ReactNode; show?: (p: Perms) => boolean }
const groups: { title: string; items: Item[] }[] = [
  { title: 'General', items: [
    { to: '/', label: 'Panel principal', icon: <LayoutDashboard />, },
    { to: '/aprobaciones', label: 'Aprobaciones', icon: <CheckSquare />, show: (p) => p.approve },
  ] },
  { title: 'Inventario', items: [
    { to: '/materiales', label: 'Materiales', icon: <Package /> },
    { to: '/catalogos', label: 'Catálogos', icon: <Tags /> },
    { to: '/almacenes', label: 'Almacenes y ubicaciones', icon: <Warehouse /> },
    { to: '/existencias', label: 'Existencias', icon: <Boxes /> },
    { to: '/lotes', label: 'Lotes y vencimientos', icon: <CalendarClock /> },
    { to: '/inventario/recepciones', label: 'Recepciones', icon: <PackagePlus /> },
    { to: '/inventario/salidas', label: 'Salidas y despachos', icon: <PackageMinus /> },
    { to: '/inventario/devoluciones', label: 'Devoluciones', icon: <Undo2 /> },
    { to: '/inventario/ajustes', label: 'Ajustes', icon: <Repeat /> },
    { to: '/recuentos', label: 'Recuentos físicos', icon: <ClipboardList /> },
    { to: '/traslados', label: 'Traslados', icon: <Truck /> },
  ] },
  { title: 'Mantenimiento', items: [
    { to: '/activos', label: 'Activos industriales', icon: <Factory /> },
    { to: '/mantenimiento/planes', label: 'Planes preventivos', icon: <CalendarClock /> },
    { to: '/mantenimiento/ordenes', label: 'Órdenes de trabajo', icon: <Wrench /> },
  ] },
  { title: 'Calidad', items: [
    { to: '/calidad/mediciones', label: 'Temperatura y ambiente', icon: <Thermometer /> },
    { to: '/calidad/limpieza', label: 'Limpieza', icon: <SprayCan /> },
    { to: '/calidad/incidencias', label: 'Incidencias', icon: <TriangleAlert /> },
  ] },
  { title: 'Gestión', items: [
    { to: '/documentos', label: 'Documentos técnicos', icon: <FileText /> },
    { to: '/informes', label: 'Informes', icon: <BarChart3 /> },
    { to: '/usuarios', label: 'Usuarios y permisos', icon: <Users />, show: (p) => p.isAdmin },
    { to: '/configuracion', label: 'Configuración', icon: <Settings />, show: (p) => p.isAdmin },
    { to: '/auditoria', label: 'Auditoría', icon: <History />, show: (p) => p.isAdmin },
  ] },
];

export default function Layout() {
  const { profile, perms, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const loc = useLocation();

  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
      if (alive) setUnread(count ?? 0);
    };
    tick();
    const t = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [loc.pathname]);

  const nav = (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {groups.map((g) => {
        const items = g.items.filter((i) => !i.show || i.show(perms));
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.title}</div>
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === '/'}
                className={({ isActive }) => `flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition [&>svg]:h-4 [&>svg]:w-4 ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`}>
                {i.icon}{i.label}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className={`no-print fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform lg:static lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-14 items-center justify-between border-b border-slate-100 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold text-slate-900"><Gauge className="h-5 w-5 text-brand-600" />ERP Industrial</Link>
          <button className="lg:hidden" onClick={() => setOpen(false)}><X className="h-5 w-5" /></button>
        </div>
        {nav}
        <div className="border-t border-slate-100 p-3 text-xs">
          <Link to="/perfil" className="block rounded-lg px-2 py-1.5 hover:bg-slate-100">
            <div className="font-medium text-slate-800">{profile?.full_name || profile?.email}</div>
            <div className="flex items-center gap-1 text-slate-500"><ShieldCheck className="h-3 w-3" />{ROLE_LABEL[profile?.role ?? '']}</div>
          </Link>
          <button onClick={signOut} className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-slate-500 hover:bg-slate-100"><LogOut className="h-3.5 w-3.5" />Cerrar sesión</button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur">
          <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Menú"><Menu className="h-5 w-5" /></button>
          <div className="hidden text-sm text-slate-500 lg:block">Moneda base: <b>BOB</b></div>
          <div className="flex items-center gap-2">
            <Link to="/notificaciones" className="relative rounded-lg p-2 hover:bg-slate-100" aria-label="Notificaciones">
              <Bell className="h-5 w-5 text-slate-600" />
              {unread > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
            </Link>
            <Link to="/inventario/salidas/nuevo" className="hidden items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100 sm:flex"><ClipboardCheck className="h-4 w-4" />Nueva salida</Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
