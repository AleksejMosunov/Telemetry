import { useState } from 'react';
import { signIn, signUp, bootstrapTeam } from '../../data/api';
import type { CloudState } from './state';

/** Вход и первый запуск команды. Пока не вошли, приложение работает с файлами
 *  как раньше — облако ничего не блокирует. */
export function Auth({ cloud, onClose }: { cloud: CloudState; onClose: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      if (mode === 'up') {
        const { needsConfirmation } = await signUp(email.trim(), pass);
        if (needsConfirmation) {
          setMsg('Аккаунт создан. На почту ушло письмо — подтвердите адрес и войдите.');
          setMode('in');
          return;
        }
      } else {
        await signIn(email.trim(), pass);
      }
      await cloud.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const makeTeam = async () => {
    setBusy(true); setErr(null);
    try {
      await bootstrapTeam(teamName.trim() || 'Моя команда');
      await cloud.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  // Вошли, но команды ещё нет — первый запуск.
  if (cloud.signedIn && !cloud.team) {
    return (
      <Shell title="Первый запуск" onClose={onClose}>
        <p className="text-[12px] text-[var(--muted)] leading-relaxed mb-3">
          Заезды хранятся внутри команды: так их видят все, кому вы дадите доступ.
          Создайте её один раз — вы станете тренером и сможете добавлять пилотов.
        </p>
        <Field label="Название команды" value={teamName} onChange={setTeamName}
          placeholder="например, Marafon" onEnter={makeTeam} />
        {err && <Err text={err} />}
        <button disabled={busy} onClick={makeTeam} className={btn}>
          {busy ? 'Создаю…' : 'Создать команду'}
        </button>
      </Shell>
    );
  }

  return (
    <Shell title={mode === 'in' ? 'Вход' : 'Регистрация'} onClose={onClose}>
      <p className="text-[12px] text-[var(--muted)] leading-relaxed mb-3">
        Библиотека заездов хранится в облаке: загрузили один раз — дальше открываете
        из списка. Без входа приложение работает как прежде, с файлами на диске.
      </p>
      <Field label="Почта" value={email} onChange={setEmail} type="email"
        placeholder="you@example.com" onEnter={submit} />
      <Field label="Пароль" value={pass} onChange={setPass} type="password"
        placeholder="не короче шести символов" onEnter={submit} />
      {msg && <div className="text-[12px] text-[var(--good)] mb-2 leading-relaxed">{msg}</div>}
      {err && <Err text={err} />}
      <button disabled={busy || !email || pass.length < 6} onClick={submit} className={btn}>
        {busy ? 'Минуту…' : mode === 'in' ? 'Войти' : 'Создать аккаунт'}
      </button>
      <button
        onClick={() => { setMode(m => (m === 'in' ? 'up' : 'in')); setErr(null); setMsg(null); }}
        className="w-full mt-2 text-[12px] text-[var(--muted)] hover:text-[var(--text)] transition">
        {mode === 'in' ? 'Аккаунта ещё нет — создать' : 'У меня уже есть аккаунт'}
      </button>
    </Shell>
  );
}

const btn = 'w-full mt-1 px-3 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--line)] '
  + 'text-[13px] hover:bg-[#1d222d] transition disabled:opacity-40 disabled:cursor-default';

function Err({ text }: { text: string }) {
  return <div className="text-[12px] text-[#ffb3b3] mb-2 leading-relaxed">{text}</div>;
}

function Field({ label, value, onChange, type = 'text', placeholder, onEnter }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; onEnter?: () => void;
}) {
  return (
    <label className="block mb-2.5">
      <span className="block text-[11px] text-[var(--muted)] mb-1">{label}</span>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onEnter?.(); }}
        className="w-full bg-[var(--panel-2)] border border-[var(--line)] rounded-lg px-3 py-2
          text-[13px] outline-none focus:border-[var(--muted-2)] transition
          placeholder:text-[var(--muted-2)]"
      />
    </label>
  );
}

export function Shell({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-[#0a0c10]/80 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-10"
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className={`panel p-5 ${wide ? 'w-[min(920px,92vw)]' : 'w-[min(400px,92vw)]'}`}>
        <div className="flex items-center mb-3">
          <span className="text-[14px] font-medium">{title}</span>
          <button onClick={onClose}
            className="ml-auto w-7 h-7 rounded-lg flex items-center justify-center
              text-[var(--muted-2)] hover:bg-white/10 hover:text-[var(--text)] transition">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
