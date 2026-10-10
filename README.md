# ERP Industrial

ERP web para una empresa con varios almacenes. Cubre inventario por lote y ubicación, vencimientos con FEFO, aprobaciones con regla de cuatro ojos, traslados con stock en tránsito, valoración por promedio ponderado o FIFO con cambio auditado, activos y mantenimiento, temperatura y limpieza, incidencias, documentos privados y auditoría.

**Stack:** React + TypeScript + Vite + Tailwind · Supabase (PostgreSQL, Auth, RLS, Storage privado) · Netlify (hosting y 1 función de servidor). Moneda base **BOB**.

Las decisiones de diseño, los riesgos y la matriz de permisos están en `ARQUITECTURA.md`.

---

## 1. Estructura

```
supabase/migrations/   0001 … 0009  → esquema, RLS, funciones, Storage, vistas (ejecutar en orden)
supabase/tests/        pruebas locales de la base (PGlite) + simulación de Auth/Storage
netlify/functions/     admin-users.ts → alta, invitación y cambio de rol de usuarios (service_role)
src/                   aplicación React
netlify.toml           build, función y fallback del SPA
```

## 2. Configurar Supabase

1. Cree un proyecto en Supabase.
2. En **SQL Editor**, ejecute los archivos de `supabase/migrations/` **en orden**, del `0001` al `0009`. También puede usar `supabase db push` con la CLI.
   ⚠️ No ejecute `supabase/tests/supabase_stub.sql`: es solo para las pruebas locales.
3. **Authentication → Providers → Email:** desactive *Allow new users to sign up*. Los usuarios solo se crean desde el ERP.
4. **Authentication → URL Configuration:**
   - *Site URL:* `https://SU-SITIO.netlify.app`
   - *Redirect URLs:* `https://SU-SITIO.netlify.app/restablecer`
5. Para crear el **primer administrador**:
   - En **Authentication → Users → Add user**, cree su usuario con contraseña.
   - Luego ejecute en el SQL Editor:
     ```sql
     update public.profiles set role = 'admin', full_name = 'Su Nombre'
     where email = 'su-correo@empresa.com';
     ```
   - A partir de ahí, el resto de usuarios se crean desde **Usuarios y permisos** en el ERP.
6. El bucket privado `erp-documents` se crea con la migración 0008. Verifique en **Storage** que figure como **Private**.

## 3. Variables de entorno

| Variable | Dónde | Tipo |
|---|---|---|
| `VITE_SUPABASE_URL` | Netlify y `.env` local | Pública |
| `VITE_SUPABASE_ANON_KEY` | Netlify y `.env` local | Pública (la protege RLS) |
| `SUPABASE_URL` | Solo Netlify | Secreta (servidor) |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo Netlify | **Secreta**: nunca con prefijo `VITE_` |
| `APP_URL` | Solo Netlify | URL pública del sitio |

Copie `.env.example` a `.env` para el desarrollo local.

## 4. Desarrollo local

```bash
npm install
npm run dev        # http://localhost:5173
npm run test:db    # 81 pruebas de seguridad y reglas de negocio sobre PostgreSQL local
npm run build      # typecheck + build de producción
```

La función de usuarios solo corre en Netlify o con `netlify dev`. Sin ella, la pantalla de usuarios muestra un aviso.

## 5. Desplegar en Netlify

1. Suba el proyecto a GitHub y conecte el repositorio en Netlify. Alternativa: `netlify deploy --prod`.
2. Netlify toma build, publish y functions de `netlify.toml`.
3. Cargue las 5 variables de la tabla anterior en **Site settings → Environment variables**.
4. El redirect `/* → /index.html 200` ya está configurado, así que abrir o recargar cualquier ruta interna no da página en blanco.

## 6. Alertas automáticas (opcional)

Las alertas de vencimiento, las OT preventivas, las tareas de limpieza y los incumplimientos se generan al abrir el panel principal, como máximo una vez cada 30 minutos. Para que se generen aunque nadie entre, active la extensión **pg_cron** (Database → Extensions) y ejecute:

```sql
-- Todos los días a las 06:00 de Bolivia (10:00 UTC)
select cron.schedule('erp-alertas', '0 10 * * *', $$select public.generate_alerts(true)$$);
```

## 7. Copias de seguridad y recuperación

- El plan Pro de Supabase incluye backups diarios. Para restaurar a un momento exacto, active **PITR**.
- Además, exporte periódicamente con `pg_dump` (Database → Connection string) y guarde las copias fuera de Supabase.
- Los archivos de Storage **no** se incluyen en el backup de la base. Haga una copia periódica del bucket `erp-documents`.
- **Antes de producción**, haga una restauración de prueba en un proyecto separado y verifique saldos, valoración y documentos.

## 8. Qué está probado y qué falta probar

Lo que `npm run test:db` verifica sobre PostgreSQL 18 (PGlite) con Auth y Storage simulados:

- Un usuario no puede elevar su rol, ni con `update` directo ni con `user_metadata` en el alta.
- Las tablas de saldos, movimientos, costos y estados solo se modifican mediante funciones; las llamadas directas a la API se rechazan.
- Aislamiento por almacén y visibilidad de costos solo para administrador y supervisor.
- FEFO en reservas. Los lotes bloqueados, en cuarentena o vencidos no se usan en salidas.
- Regla de cuatro ojos en salidas, ajustes, recuentos, traslados, diferencias y cambio de método.
- Idempotencia, doble confirmación rechazada y movimientos inmutables.
- Traslados con stock en tránsito, recepción parcial, daños y faltantes, y baja valorizada.
- Promedio ponderado, cambio a FIFO con reconciliación y FIFO consumiendo la capa más antigua.
- Documentos privados: autorización por entidad, documentos controlados y retiro lógico.
- Mediciones fuera de rango que generan incidencia y alerta, limpieza, OT preventivas y cierre de incidencias.

Lo que **debe probarse en su proyecto real de Supabase** antes de producción:

- **Concurrencia real.** El entorno local tiene una sola conexión. El diseño usa bloqueos de fila (`FOR UPDATE`) y restricciones `CHECK`. Pruébelo confirmando la misma salida desde dos navegadores a la vez y lanzando salidas simultáneas sobre el mismo lote.
- Las políticas de `storage.objects` con el Storage real: subir, descargar con URL firmada y acceder sin permiso.
- La función `admin-users` desplegada: invitación, creación, cambio de rol, desactivación y rechazo a no administradores.
- Las rutas internas al recargar en Netlify.
- La restauración de un backup.

## 9. Pendiente de validación profesional

- El tratamiento contable y tributario del cambio de método de valoración en Bolivia y el cierre de períodos los debe validar el responsable financiero.
- El cambio de método requiere **dos administradores**: uno solicita y otro aprueba.
- Los números de serie son un registro documental. Las cantidades se mueven por documentos de inventario, no por serie.
