/**
 * Función de servidor (Netlify) para operaciones administrativas de Supabase Auth.
 *
 * Seguridad:
 *  1. Verifica el JWT del solicitante contra Supabase Auth (no confía en el navegador).
 *  2. Comprueba en la base de datos que el solicitante es administrador ACTIVO.
 *  3. Valida estrictamente las entradas.
 *  4. Usa SUPABASE_SERVICE_ROLE_KEY solo aquí (variable secreta del servidor, nunca VITE_*).
 *  5. Registra cada acción en audit_logs.
 *
 * Nota: un segundo cliente de Supabase en el navegador con `persistSession: false` solo evita que
 * `signUp` reemplace la sesión del administrador; sigue usando la clave pública y NO otorga privilegios.
 * Por eso la creación de usuarios se hace aquí y no en el frontend.
 */
import { createClient } from '@supabase/supabase-js';

const ROLES = ['admin', 'supervisor', 'operador', 'mantenimiento', 'calidad', 'consulta'] as const;
type Role = (typeof ROLES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'Método no permitido.' });

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const appUrl = process.env.APP_URL ?? new URL(req.url).origin;
  if (!url || !serviceKey) return json(500, { error: 'La función no está configurada (faltan variables secretas en Netlify).' });

  // Mismo origen: rechaza llamadas desde otros sitios
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(appUrl).origin && origin !== new URL(req.url).origin) return json(403, { error: 'Origen no permitido.' });

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sesión requerida.' });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1) Identidad del solicitante
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who.user) return json(401, { error: 'Sesión inválida o expirada.' });

  // 2) Permiso administrativo vigente (se lee de la BD, no del token)
  const { data: me } = await admin.from('profiles').select('id, role, active').eq('id', who.user.id).maybeSingle();
  if (!me || me.role !== 'admin' || !me.active) return json(403, { error: 'Solo un administrador activo puede gestionar usuarios.' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'Solicitud inválida.' }); }

  const audit = (action: string, recordId: string | null, context: Record<string, unknown>) =>
    admin.from('audit_logs').insert({ user_id: me.id, action, table_name: 'auth.users', record_id: recordId, context });

  const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const role = str(body.role) as Role;
  const action = str(body.action);

  try {
    if (action === 'invite' || action === 'create') {
      const email = str(body.email).toLowerCase();
      const fullName = str(body.full_name);
      if (!EMAIL.test(email)) return json(400, { error: 'Correo inválido.' });
      if (!ROLES.includes(role)) return json(400, { error: 'Rol inválido.' });
      if (!fullName) return json(400, { error: 'Indique el nombre.' });
      const whIds = Array.isArray(body.warehouse_ids) ? (body.warehouse_ids as unknown[]).filter((x): x is string => typeof x === 'string' && UUID.test(x)) : [];

      let userId: string;
      // app_metadata solo puede escribirla el servidor: es la fuente del rol inicial
      if (action === 'invite') {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${appUrl}/restablecer`, data: { full_name: fullName } });
        if (error) return json(400, { error: traducir(error.message) });
        userId = data.user.id;
        await admin.auth.admin.updateUserById(userId, { app_metadata: { role, full_name: fullName } });
      } else {
        const password = str(body.password, 128);
        if (password.length < 10) return json(400, { error: 'La contraseña temporal debe tener al menos 10 caracteres.' });
        const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role, full_name: fullName }, user_metadata: { full_name: fullName } });
        if (error) return json(400, { error: traducir(error.message) });
        userId = data.user.id;
      }
      // El trigger crea el perfil; aseguramos rol y nombre (idempotente)
      await admin.from('profiles').upsert({ id: userId, email, full_name: fullName, role, active: true });
      if (role !== 'admin' && whIds.length) {
        await admin.from('user_warehouse_access').upsert(whIds.map((w) => ({ user_id: userId, warehouse_id: w })));
      }
      await audit(action === 'invite' ? 'user_invited' : 'user_created', userId, { email, role, warehouses: whIds });
      return json(200, { ok: true, user_id: userId });
    }

    if (action === 'update') {
      const userId = str(body.user_id);
      if (!UUID.test(userId)) return json(400, { error: 'Usuario inválido.' });
      if (!ROLES.includes(role)) return json(400, { error: 'Rol inválido.' });
      const active = body.active !== false;
      const fullName = str(body.full_name);
      if (userId === me.id && (role !== 'admin' || !active)) return json(400, { error: 'No puede quitarse su propio rol de administrador ni desactivarse.' });

      const { data: before } = await admin.from('profiles').select('role, active, full_name').eq('id', userId).maybeSingle();
      if (!before) return json(404, { error: 'Usuario no encontrado.' });
      if (before.role === 'admin' && (role !== 'admin' || !active)) {
        const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
        if ((count ?? 0) <= 1) return json(400, { error: 'Debe quedar al menos un administrador activo.' });
      }
      await admin.from('profiles').update({ role, active, full_name: fullName || before.full_name }).eq('id', userId);
      // Mantener el rol también en app_metadata y bloquear el inicio de sesión si se desactiva
      await admin.auth.admin.updateUserById(userId, { app_metadata: { role }, ban_duration: active ? 'none' : '876000h' });
      await audit('user_updated', userId, { before, after: { role, active, full_name: fullName } });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Acción desconocida.' });
  } catch (e) {
    console.error('admin-users', e);
    return json(500, { error: 'Error interno al procesar la solicitud.' });
  }
};

function traducir(msg: string) {
  if (/already been registered|already exists/i.test(msg)) return 'Ya existe un usuario con ese correo.';
  if (/rate limit/i.test(msg)) return 'Demasiadas invitaciones seguidas. Intente en unos minutos.';
  if (/password/i.test(msg)) return 'La contraseña no cumple los requisitos de seguridad.';
  return 'No se pudo completar la operación en Supabase Auth.';
}
