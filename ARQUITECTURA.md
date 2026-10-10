# ERP Industrial — Documento de arquitectura (versión breve)

Stack: **React + TypeScript + Vite + Tailwind** · **Supabase** (PostgreSQL, Auth, RLS, Storage privado) · **Netlify** (hosting + 1 función de servidor).
Moneda base: **BOB**. Una empresa, varios almacenes. Operación en línea, alertas dentro del ERP, sin IoT/correo/SMS.

## 1. Decisiones confirmadas

| Tema | Decisión |
|---|---|
| Método de valoración inicial | **Promedio ponderado**, global para la empresa (no por almacén) |
| Cambio de método | Solicitud de un admin + aprobación de **otro** admin, con fecha de vigencia; se aplica una sola vez y queda registrado |
| Aprobaciones | Salidas, ajustes y traslados requieren aprobación del **supervisor del almacén o admin**, y **nadie aprueba lo que creó** (regla de cuatro ojos, aplicada en la base de datos) |
| Lotes | FEFO (primero en vencer) para elegir lotes físicos; independiente del método de costo |
| Alertas de vencimiento | 30 días por defecto, configurable por material |
| Correcciones | Movimientos inmutables; se corrige con ajustes compensatorios |

## 2. Principio de seguridad

1. **Toda escritura crítica pasa por funciones RPC `SECURITY DEFINER`** en PostgreSQL (crear/editar borradores, enviar, aprobar, confirmar, despachar, recibir, cerrar recuentos, cambiar método). Cada función valida identidad (`auth.uid()`), rol, acceso al almacén, estado del documento y existencias, todo dentro de **una transacción**.
2. Las tablas de saldos, movimientos, reservas y costos **no tienen políticas de escritura** para el cliente: aunque alguien use la clave pública directamente contra la API, no puede tocarlas.
3. **RLS en todas las tablas.** La lectura se filtra por rol y por `user_warehouse_access`.
4. **Costos separados en tablas propias** (`material_costs`, `cost_layers`, `movement_costs`, `document_line_costs`) con RLS que solo permite verlos a quien tiene `can_view_costs` (admin y supervisor). Así el operador no ve costos aunque vea movimientos.
5. `profiles.role` solo lo cambia la función de servidor o un admin; un trigger bloquea cualquier intento de cambiar el propio rol.
6. **Función Netlify `admin-users`**: valida el JWT del solicitante, comprueba en la base que es admin activo, valida la entrada, y solo entonces usa `SUPABASE_SERVICE_ROLE_KEY` (variable secreta del servidor) para invitar/crear/desactivar usuarios. Registra todo en `audit_logs`.
   - Un segundo cliente de Supabase con `persistSession: false` solo evita que crear un usuario con `signUp` reemplace la sesión del admin en el navegador; **no otorga privilegios** (sigue usando la clave pública) y no sustituye al backend. Por eso no se usa para crear usuarios.
7. **Auditoría** por triggers en tablas clave (insert/update/delete, con valores anterior/nuevo) más registros explícitos en cada RPC. `audit_logs` no tiene políticas de modificación.
8. Errores: las RPC lanzan mensajes de negocio claros (`ERP: ...`); el frontend no muestra detalles internos de PostgreSQL.

## 3. Concurrencia e integridad de inventario

- Cada confirmación bloquea el documento (`SELECT ... FOR UPDATE`) y verifica su estado: un doble clic o dos usuarios a la vez no confirman dos veces.
- Saldos bloqueados por fila y en orden estable (evita interbloqueos); restricciones `CHECK (qty_on_hand >= 0)`, `CHECK (qty_reserved <= qty_on_hand)`.
- Clave de idempotencia opcional en la creación de documentos.
- Movimientos protegidos por trigger contra `UPDATE`/`DELETE`.
- Períodos cerrados (`accounting_periods`): ninguna operación se registra en un mes cerrado.

## 4. Existencias

`stock_balances` por (material, almacén, ubicación, lote): `qty_on_hand`, `qty_reserved`.
- **Disponible** = en mano − reservado, solo en lotes con estado `disponible`.
- **Bloqueado** = en mano de lotes en `cuarentena`, `bloqueado` o `vencido`.
- **En tránsito** = despachado − recibido − diferencias resueltas, en las líneas de traslado (vista `v_stock_in_transit`).
- El lote tiene estado propio; "reservado" se expresa con la cantidad reservada (un lote puede estar parcialmente reservado).

## 5. Flujos

**Entrada/recepción:** borrador → confirmado (lo confirma quien puede ver costos; el costo es obligatorio). Crea lotes si no existen.
**Devolución:** borrador → confirmado (costo = costo vigente del material).
**Salida:** borrador → pendiente → aprobado (reserva FEFO) → confirmado (descuenta y valoriza). También rechazado/anulado (libera reservas).
**Ajuste:** borrador → pendiente → aprobado → confirmado. Cantidades positivas o negativas, con motivo obligatorio.
**Recuento:** abierto (se toma la foto del sistema) → contado → cerrado; al cerrar genera un **ajuste pendiente** con las diferencias, que sigue el flujo de aprobación.
**Traslado:** borrador → pendiente → aprobado (reserva en origen) → preparado (cantidades cargadas) → en_transito (despacho: sale del origen) → recibido_parcial / con_diferencias → cerrado. Las diferencias (faltantes o daños) se aprueban por un supervisor del destino distinto de quien recibió y se dan de baja con movimiento y costo.

## 6. Valoración

- Tabla `valuation_methods` (historial con `effective_from`, solicitante, aprobador) y `valuation_change_requests`.
- **Promedio ponderado:** `material_costs (qty, value)`; entradas suman, salidas consumen a costo promedio vigente.
- **FIFO:** `cost_layers` por entrada, consumo en orden de recepción.
- **Cambio de método:** al llegar la fecha de vigencia se convierte el saldo (prom. → una capa FIFO por material al costo promedio; FIFO → promedio = valor total / cantidad) y se guarda una **foto de reconciliación** (`valuation_change_snapshots`) con valor antes/después. Los movimientos anteriores conservan su costo en `movement_costs` y el método con que se valoraron. Nada histórico se reescribe.
- ⚠️ **Requiere validación del responsable financiero:** tratamiento contable/tributario del cambio de método en Bolivia, cierre mensual y diferencias de redondeo.

## 7. Archivos

Bucket privado **`erp-documents`**. Tabla única `documents` con FK opcionales (`material_id`, `lot_id`, `asset_id`, `work_order_id`, `incident_id`) y `CHECK` de que exactamente una esté presente; así se mantiene integridad referencial (reemplaza a `material_documents`/`asset_documents` con el mismo propósito). Ruta: `entidad/id/uuid-nombre`. Lectura por políticas de `storage.objects` que exigen un registro en `documents` visible para el usuario; descarga con **URL firmada de 60 s**. No hay borrado físico desde el cliente: "eliminar" o "reemplazar" marca el registro (`status`, `replaced_by`) y conserva el archivo.

## 8. Roles (resumen)

| Acción | Admin | Supervisor | Operador | Mantenimiento | Calidad | Consulta |
|---|---|---|---|---|---|---|
| Ver inventario de sus almacenes | ✔ (todos) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Ver costos | ✔ | ✔ | — | — | — | — |
| Catálogos y materiales | ✔ | ✔ | — | — | — | — |
| Crear entradas/salidas/ajustes/traslados | ✔ | ✔ | ✔ (borrador) | salidas para OT | — | — |
| Confirmar entradas | ✔ | ✔ | devoluciones | — | — | — |
| Aprobar (no lo propio) | ✔ | ✔ en sus almacenes | — | — | — | — |
| Liberar cuarentena / bloquear lotes | ✔ | ✔ | — | — | ✔ | — |
| Activos y órdenes de trabajo | ✔ | lectura | lectura | ✔ | lectura | lectura |
| Mediciones, limpieza, incidencias | ✔ | ✔ | registrar | registrar | ✔ | lectura |
| Subir documentos | ✔ | ✔ | — | ✔ | ✔ | — |
| Usuarios, configuración, valoración | ✔ | — | — | — | — | — |
| Auditoría | ✔ | — | — | — | — | — |

## 9. Despliegue

Variables **públicas** (frontend): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
Variables **secretas** (solo función Netlify): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`.
`netlify.toml` con redirect `/* → /index.html 200` para que las rutas internas no queden en blanco.

## 10. Riesgos y pendientes

- Validación contable del cambio de método y del cierre de períodos (responsable financiero).
- Se necesitan al menos **2 administradores** para aprobar un cambio de método.
- Alertas: se generan al abrir el panel (función `generate_alerts`). Para alertas aunque nadie entre, programar `pg_cron` en Supabase (opcional, documentado en el README).
- Escáner por cámara depende del navegador (Chrome/Edge/Android; en iOS Safari usa la librería ZXing incluida).
- Copias: el plan Pro de Supabase tiene backups diarios; para recuperación a un punto en el tiempo, activar PITR. **Probar una restauración antes de producción.**
- Las pruebas SQL incluidas se ejecutaron en PostgreSQL local con simulación de Auth/Storage; hay que repetir los criterios de aceptación en el proyecto real de Supabase.
