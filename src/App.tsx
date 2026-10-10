import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './lib/auth';
import Layout from './components/Layout';
import { Spinner, Empty } from './components/ui';
import { ForgotPage, LoginPage, ResetPage } from './pages/Auth';
import Dashboard, { PendingApprovals } from './pages/Dashboard';
import { MaterialDetailPage, MaterialsPage } from './pages/Materials';
import { CatalogsPage, WarehousesPage } from './pages/Catalogs';
import { LotsPage, StockPage } from './pages/Stock';
import { InventoryDocDetail, InventoryDocForm, InventoryDocsList } from './pages/InventoryDocs';
import { CountDetail, CountsPage } from './pages/Counts';
import { TransferDetail, TransferForm, TransfersPage } from './pages/Transfers';
import { AssetDetail, AssetsPage, PlansPage, WorkOrderDetail, WorkOrderNew, WorkOrdersPage } from './pages/Maintenance';
import { CleaningPage, IncidentDetail, IncidentNew, IncidentsPage, MeasurementsPage } from './pages/Quality';
import { AuditPage, DocumentsPage, ReportsPage, SettingsPage, UsersPage } from './pages/Admin';
import { NotificationsPage, ProfilePage } from './pages/Profile';

function Protected({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner label="Verificando sesión…" />;
  if (!session) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (!profile || !profile.active) return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="card max-w-md p-6 text-center">
        <h1 className="mb-2 font-semibold">Acceso no habilitado</h1>
        <p className="text-sm text-slate-500">Su usuario está inactivo o no tiene perfil asignado. Contacte al administrador.</p>
      </div>
    </div>
  );
  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { perms } = useAuth();
  return perms.isAdmin ? <>{children}</> : <Empty>Solo administradores.</Empty>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/recuperar" element={<ForgotPage />} />
      <Route path="/restablecer" element={<ResetPage />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Dashboard />} />
        <Route path="aprobaciones" element={<PendingApprovals />} />
        <Route path="materiales" element={<MaterialsPage />} />
        <Route path="materiales/:id" element={<MaterialDetailPage />} />
        <Route path="catalogos" element={<CatalogsPage />} />
        <Route path="almacenes" element={<WarehousesPage />} />
        <Route path="existencias" element={<StockPage />} />
        <Route path="lotes" element={<LotsPage />} />
        <Route path="inventario/documentos/:id" element={<InventoryDocDetail />} />
        <Route path="inventario/documentos/:id/editar" element={<InventoryDocForm />} />
        <Route path="inventario/:type" element={<InventoryDocsList />} />
        <Route path="inventario/:type/nuevo" element={<InventoryDocForm />} />
        <Route path="recuentos" element={<CountsPage />} />
        <Route path="recuentos/:id" element={<CountDetail />} />
        <Route path="traslados" element={<TransfersPage />} />
        <Route path="traslados/nuevo" element={<TransferForm />} />
        <Route path="traslados/:id" element={<TransferDetail />} />
        <Route path="traslados/:id/editar" element={<TransferForm />} />
        <Route path="activos" element={<AssetsPage />} />
        <Route path="activos/:id" element={<AssetDetail />} />
        <Route path="mantenimiento/planes" element={<PlansPage />} />
        <Route path="mantenimiento/ordenes" element={<WorkOrdersPage />} />
        <Route path="mantenimiento/ordenes/nueva" element={<WorkOrderNew />} />
        <Route path="mantenimiento/ordenes/:id" element={<WorkOrderDetail />} />
        <Route path="calidad/mediciones" element={<MeasurementsPage />} />
        <Route path="calidad/limpieza" element={<CleaningPage />} />
        <Route path="calidad/incidencias" element={<IncidentsPage />} />
        <Route path="calidad/incidencias/nueva" element={<IncidentNew />} />
        <Route path="calidad/incidencias/:id" element={<IncidentDetail />} />
        <Route path="documentos" element={<DocumentsPage />} />
        <Route path="informes" element={<ReportsPage />} />
        <Route path="usuarios" element={<AdminOnly><UsersPage /></AdminOnly>} />
        <Route path="configuracion" element={<AdminOnly><SettingsPage /></AdminOnly>} />
        <Route path="auditoria" element={<AdminOnly><AuditPage /></AdminOnly>} />
        <Route path="perfil" element={<ProfilePage />} />
        <Route path="notificaciones" element={<NotificationsPage />} />
        <Route path="*" element={<Empty>Página no encontrada.</Empty>} />
      </Route>
    </Routes>
  );
}
