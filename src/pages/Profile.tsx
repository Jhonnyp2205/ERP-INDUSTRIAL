import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { errMsg, rpc, run, useAsync } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, ROLE_LABEL } from '../lib/format';
import { Alert, Button, Card, Empty, Field, Input, KV, PageHeader, Spinner, useToast } from '../components/ui';

export function ProfilePage() {
  const { profile, warehouses, refresh } = useAuth();
  const [name, setName] = useState(profile?.full_name ?? '');
  const [pw, setPw] = useState('');
  const t = useToast();
  return (
    <div>
      <PageHeader title="Mi perfil" />
      {t.node}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Datos">
          <KV items={[['Correo', profile?.email], ['Rol', ROLE_LABEL[profile?.role ?? '']], ['Almacenes', warehouses.map((w) => w.code).join(', ') || '—']]} />
          <p className="mt-3 text-xs text-slate-400">El rol y los almacenes solo los cambia un administrador.</p>
          <div className="mt-4 flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
            <Button onClick={async () => { try { await rpc('update_my_name', { p_full_name: name }); await refresh(); t.ok('Nombre actualizado.'); } catch (e) { t.fail(e); } }}>Guardar</Button>
          </div>
        </Card>
        <Card title="Cambiar contraseña">
          <Field label="Nueva contraseña (mín. 10 caracteres)"><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Button className="mt-3" disabled={pw.length < 10} onClick={async () => {
            const { error } = await supabase.auth.updateUser({ password: pw });
            if (error) t.fail(new Error(errMsg(error))); else { setPw(''); t.ok('Contraseña actualizada.'); }
          }}>Actualizar</Button>
        </Card>
      </div>
    </div>
  );
}

export function NotificationsPage() {
  const { data, loading, error, reload } = useAsync(() =>
    run(supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(200)), []);
  const markAll = async () => {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
    reload();
  };
  return (
    <div>
      <PageHeader title="Notificaciones" actions={<Button variant="secondary" onClick={markAll}>Marcar todas como leídas</Button>} />
      <Alert>{error}</Alert>
      <Card padded={false}>
        {loading ? <Spinner /> : !data?.length ? <Empty>Sin notificaciones.</Empty> : (
          <ul className="divide-y divide-slate-100">
            {data.map((n) => (
              <li key={n.id} className={`flex items-start justify-between gap-3 px-4 py-3 ${n.read_at ? '' : 'bg-brand-50/50'}`}>
                <div>
                  <div className="text-sm font-medium">{n.title}</div>
                  {n.body && <div className="text-sm text-slate-600">{n.body}</div>}
                  <div className="text-xs text-slate-400">{fmtDateTime(n.created_at)}</div>
                </div>
                {n.link && <Link className="whitespace-nowrap text-sm text-brand-700 hover:underline" to={n.link}
                  onClick={() => supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id).then(() => {})}>Abrir</Link>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
