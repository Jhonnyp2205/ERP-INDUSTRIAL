import { useState } from 'react';
import { Printer } from 'lucide-react';
import CrudTable from '../components/CrudTable';
import { Button, Card, PageHeader, Tabs } from '../components/ui';
import { printLabels } from '../components/labels';
import { useAuth } from '../lib/auth';
import { invalidateCatalog } from '../lib/catalogs';
import type { Row } from '../lib/api';

export function CatalogsPage() {
  const { perms } = useAuth();
  const [tab, setTab] = useState('categories');
  return (
    <div>
      <PageHeader title="Catálogos" subtitle="Categorías, unidades de medida y proveedores. Los registros se desactivan; no se eliminan." />
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'categories', label: 'Categorías' }, { key: 'units', label: 'Unidades de medida' }, { key: 'suppliers', label: 'Proveedores' }]} />
      <Card>
        {tab === 'categories' && <CrudTable key="c" table="categories" orderBy="name" canEdit={perms.manageCatalogs} defaults={{ active: true }} onSaved={() => invalidateCatalog('categories')}
          columns={[{ key: 'name', label: 'Nombre', required: true }, { key: 'description', label: 'Descripción', type: 'textarea' }, { key: 'active', label: 'Activo', type: 'bool' }]} />}
        {tab === 'units' && <CrudTable key="u" table="units_of_measure" orderBy="code" canEdit={perms.manageCatalogs} defaults={{ active: true }} onSaved={() => invalidateCatalog('units')}
          columns={[{ key: 'code', label: 'Código', required: true, readOnlyOnEdit: true, hint: 'Ej.: UND, CJ, KG, L' }, { key: 'name', label: 'Nombre', required: true }, { key: 'active', label: 'Activo', type: 'bool' }]} />}
        {tab === 'suppliers' && <CrudTable key="s" table="suppliers" orderBy="name" canEdit={perms.manageCatalogs} defaults={{ active: true }} onSaved={() => invalidateCatalog('suppliers')}
          columns={[{ key: 'name', label: 'Razón social', required: true }, { key: 'tax_id', label: 'NIT' }, { key: 'contact', label: 'Contacto' }, { key: 'phone', label: 'Teléfono' },
            { key: 'email', label: 'Correo', hideInTable: true }, { key: 'address', label: 'Dirección', type: 'textarea', hideInTable: true }, { key: 'active', label: 'Activo', type: 'bool' }]} />}
      </Card>
    </div>
  );
}

export function WarehousesPage() {
  const { perms, warehouses, refresh } = useAuth();
  const [tab, setTab] = useState('locations');
  const whOpts = warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }));
  return (
    <div>
      <PageHeader title="Almacenes y ubicaciones" subtitle="Cada ubicación puede identificarse con su código de barras." />
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'locations', label: 'Ubicaciones' }, { key: 'warehouses', label: 'Almacenes' }]} />
      <Card>
        {tab === 'warehouses' && <CrudTable key="w" table="warehouses" orderBy="code" canEdit={perms.isAdmin} defaults={{ active: true }} onSaved={refresh}
          columns={[{ key: 'code', label: 'Código', required: true, readOnlyOnEdit: true }, { key: 'name', label: 'Nombre', required: true }, { key: 'address', label: 'Dirección' }, { key: 'active', label: 'Activo', type: 'bool' }]} />}
        {tab === 'locations' && <CrudTable key="l" table="locations" orderBy="code" canEdit={perms.manageCatalogs} defaults={{ active: true }}
          onSaved={() => invalidateCatalog('locations')}
          transform={(f: Row) => ({ ...f, barcode: f.barcode || null })}
          extraActions={(r) => <Button variant="ghost" title="Imprimir etiqueta" icon={<Printer className="h-4 w-4" />}
            onClick={() => printLabels([{ code: r.barcode || r.code, title: r.code, subtitle: r.name }])} />}
          columns={[
            { key: 'warehouse_id', label: 'Almacén', type: 'select', options: whOpts, required: true, readOnlyOnEdit: true },
            { key: 'code', label: 'Código', required: true }, { key: 'name', label: 'Nombre', required: true },
            { key: 'barcode', label: 'Código de barras', hint: 'Si se deja vacío, la etiqueta usa el código' }, { key: 'active', label: 'Activo', type: 'bool' },
          ]} />}
      </Card>
    </div>
  );
}
