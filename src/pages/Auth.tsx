import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Field, Input } from '../components/ui';

function Shell({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-brand-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold text-slate-900"><Gauge className="h-6 w-6 text-brand-600" />ERP Industrial</div>
        <div className="card p-6">
          <h1 className="mb-4 text-base font-semibold">{title}</h1>
          {!supabaseConfigured && <Alert>Falta configurar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.</Alert>}
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (session) return <Navigate to="/" replace />;
  return (
    <Shell title="Iniciar sesión">
      <Alert>{err}</Alert>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) setErr(/Invalid login/i.test(error.message) ? 'Correo o contraseña incorrectos.' : errMsg(error));
        setBusy(false);
      }}>
        <Field label="Correo"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Contraseña"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button className="w-full" loading={busy}>Ingresar</Button>
      </form>
      <Link to="/recuperar" className="mt-4 block text-center text-sm text-brand-700 hover:underline">¿Olvidó su contraseña?</Link>
    </Shell>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="Recuperar acceso">
      {sent ? <Alert kind="success">Si el correo está registrado, recibirá un enlace para definir una nueva contraseña.</Alert> : (
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true);
          await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/restablecer` });
          setSent(true); setBusy(false);
        }}>
          <Field label="Correo"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button className="w-full" loading={busy}>Enviar enlace</Button>
        </form>
      )}
      <Link to="/login" className="mt-4 block text-center text-sm text-brand-700 hover:underline">Volver</Link>
    </Shell>
  );
}

/** Destino del enlace de invitación o recuperación: define la contraseña. */
export function ResetPage() {
  const { session } = useAuth();
  const nav = useNavigate();
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Shell title="Definir contraseña">
      {!session ? <Alert>El enlace no es válido o expiró. Solicite uno nuevo.</Alert> : (
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault(); setErr('');
          if (p1.length < 10) return setErr('Use al menos 10 caracteres.');
          if (p1 !== p2) return setErr('Las contraseñas no coinciden.');
          setBusy(true);
          const { error } = await supabase.auth.updateUser({ password: p1 });
          setBusy(false);
          if (error) setErr(errMsg(error)); else nav('/', { replace: true });
        }}>
          <Alert>{err}</Alert>
          <Field label="Nueva contraseña"><Input type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></Field>
          <Field label="Repetir contraseña"><Input type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></Field>
          <Button className="w-full" loading={busy}>Guardar</Button>
        </form>
      )}
    </Shell>
  );
}
