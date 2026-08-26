import { useMemo, useRef, useState } from 'react';
import {
  deleteSession, signOut, renameDriver, deleteDriver, reassignSession,
  renameConfig, deleteConfig, createDriver, type SessionRow,
} from '../../data/api';
import { clockwise, directionName } from '../../core/trackid';
import type { CloudState } from './state';
import { Shell } from './Auth';
import { Upload } from './Upload';
import { lapTime, plural } from '../format';

/** Библиотека заездов: загрузили один раз — дальше открываете из списка. */
export function Library({ cloud, picked, onPick, onClose, max }: {
  cloud: CloudState;
  picked: string[];
  onPick: (rows: SessionRow[]) => void;
  onClose: () => void;
  max: number;
}) {
  const [tab, setTab] = useState<'sessions' | 'manage'>('sessions');
  const [sel, setSel] = useState<string[]>(picked);
  const [q, setQ] = useState('');
  const [cfg, setCfg] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [confirmDel, setConfirmDel] = useState<SessionRow | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Границы включительные: «по 16.08» должно захватывать весь этот день.
    const lo = from ? new Date(from + 'T00:00:00').getTime() : -Infinity;
    const hi = to ? new Date(to + 'T23:59:59').getTime() : Infinity;
    return cloud.sessions.filter(s => {
      if (cfg && s.configId !== cfg) return false;
      if (needle && !(s.driverName ?? '').toLowerCase().includes(needle)) return false;
      if (from || to) {
        if (!s.recordedAt) return false;
        const t = new Date(s.recordedAt).getTime();
        if (t < lo || t > hi) return false;
      }
      return true;
    });
  }, [cloud.sessions, q, cfg, from, to]);

  const dirty = Boolean(q || cfg || from || to);
  const reset = () => { setQ(''); setCfg(''); setFrom(''); setTo(''); };

  // Группируем по конфигурации: сравнивать заезды имеет смысл внутри одной.
  const groups = useMemo(() => {
    const m = new Map<string, {
      track: string; config: string; dir: string; length: number; rows: SessionRow[];
    }>();
    for (const s of filtered) {
      const key = s.configId ?? 'нет';
      if (!m.has(key)) {
        const c = cloud.configs.find(x => x.id === s.configId);
        m.set(key, {
          track: s.trackName ?? 'Трасса не определена',
          config: s.configName ?? '',
          dir: c ? `${clockwise(c.signature) ? '↻' : '↺'} ${directionName(c.signature)}` : '',
          length: c?.length ?? 0,
          rows: [],
        });
      }
      m.get(key)!.rows.push(s);
    }
    return [...m.values()].sort((a, b) => a.track.localeCompare(b.track));
  }, [filtered, cloud.configs]);

  const toggle = (id: string) => setSel(v =>
    v.includes(id) ? v.filter(x => x !== id) : v.length >= max ? v : [...v, id]);

  const open = () => {
    const byId = new Map(cloud.sessions.map(s => [s.id, s]));
    onPick(sel.map(id => byId.get(id)!).filter(Boolean));
  };

  const del = async (row: SessionRow) => {
    try {
      await deleteSession(row);
      setSel(v => v.filter(x => x !== row.id));
      await cloud.refresh();
    } catch (e) {
      cloud.setError(e instanceof Error ? e.message : String(e));
    } finally { setConfirmDel(null); }
  };

  if (pendingFiles) {
    return (
      <Upload cloud={cloud} files={pendingFiles}
        onClose={() => setPendingFiles(null)} onDone={() => setPendingFiles(null)} />
    );
  }

  return (
    <Shell title="Библиотека заездов" onClose={onClose} wide>
      <div className="flex items-center gap-2 flex-wrap mb-3 text-[12px]">
        <span className="text-[var(--muted)]">{cloud.team?.name} · {cloud.email}</span>
        <button onClick={() => { signOut(); onClose(); }}
          className="text-[var(--muted-2)] hover:text-[var(--text)] transition">
          выйти
        </button>

        <div className="flex rounded-lg border border-[var(--line)] overflow-hidden ml-2">
          {([['sessions', 'Заезды'], ['manage', 'Пилоты и трассы']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-3 py-1.5 transition ${tab === id ? 'bg-[var(--panel-2)] text-[var(--text)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
              {label}
            </button>
          ))}
        </div>

        <button onClick={() => input.current?.click()}
          className="ml-auto px-3 py-1.5 rounded-lg border border-[var(--line)]
            hover:bg-[var(--panel-2)] transition">Загрузить CSV</button>
        <input ref={input} type="file" accept=".csv" multiple hidden
          onChange={e => {
            const f = [...(e.target.files ?? [])];
            e.target.value = '';
            if (f.length) setPendingFiles(f);
          }} />
      </div>

      {cloud.error && (
        <div className="text-[12px] text-[#ffb3b3] mb-3 leading-relaxed">{cloud.error}</div>
      )}

      {tab === 'sessions' && cloud.sessions.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-3 pb-3 border-b border-[var(--line-soft)]">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="пилот"
            className={`${fld} w-[150px]`} />
          <select value={cfg} onChange={e => setCfg(e.target.value)} className={fld}>
            <option value="">все трассы</option>
            {cloud.configs.map(c => (
              <option key={c.id} value={c.id}>
                {c.trackName} · {c.name} ({clockwise(c.signature) ? '↻' : '↺'})
              </option>
            ))}
          </select>
          <span className="text-[11px] text-[var(--muted-2)]">с</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={fld} />
          <span className="text-[11px] text-[var(--muted-2)]">по</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className={fld} />
          {dirty && (
            <button onClick={reset}
              className="text-[11px] text-[var(--muted-2)] hover:text-[var(--text)] transition">
              сбросить
            </button>
          )}
          <span className="ml-auto text-[11px] text-[var(--muted-2)] num">
            {dirty ? `${filtered.length} из ${cloud.sessions.length}` : `${cloud.sessions.length} ${plural(cloud.sessions.length, 'заезд', 'заезда', 'заездов')}`}
          </span>
        </div>
      )}

      {tab === 'manage' ? (
        <Manage cloud={cloud} />
      ) : !cloud.sessions.length ? (
        <div className="py-10 text-center text-[13px] text-[var(--muted)] leading-relaxed">
          Библиотека пуста.<br />
          Загрузите первые CSV — дальше они будут открываться отсюда, без перезаливки.
        </div>
      ) : !filtered.length ? (
        <div className="py-10 text-center text-[13px] text-[var(--muted)]">
          Под фильтр ничего не подошло.{' '}
          <button onClick={reset} className="underline hover:text-[var(--text)]">сбросить</button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 max-h-[52vh] overflow-y-auto pr-1">
          {groups.map(g => (
            <div key={g.track + g.config}>
              <div className="flex items-baseline gap-2 flex-wrap mb-1.5 sticky top-0 bg-[var(--panel)] py-1">
                <span className="text-[13px] font-medium">{g.track}</span>
                <span className="text-[12px] text-[var(--muted)]">{g.config}</span>
                {g.dir && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--muted)' }}>
                    {g.dir}
                  </span>
                )}
                <span className="text-[10px] text-[var(--muted-2)] num">
                  {g.length ? `${g.length.toFixed(0)} м · ` : ''}
                  {g.rows.length} {plural(g.rows.length, 'заезд', 'заезда', 'заездов')}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {g.rows.map(s => {
                  const on = sel.includes(s.id);
                  const full = !on && sel.length >= max;
                  return (
                    <div key={s.id} onClick={() => !full && toggle(s.id)}
                      className={`group flex items-center gap-3 px-3 py-2 rounded-lg border transition
                        ${on ? 'border-[var(--line)] bg-[var(--panel-2)]' : 'border-transparent hover:bg-white/[0.03]'}
                        ${full ? 'opacity-40 cursor-default' : 'cursor-pointer'}`}>
                      <span className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[10px]
                        ${on ? 'border-[var(--text)] bg-[var(--text)] text-[#0a0c10]' : 'border-[var(--muted-2)]'}`}>
                        {on ? '✓' : ''}
                      </span>
                      <span className="text-[13px] w-[160px] truncate">{s.driverName ?? '— без пилота —'}</span>
                      <span className="text-[11px] text-[var(--muted)] num w-[130px]">
                        {s.recordedAt
                          ? new Date(s.recordedAt).toLocaleString('ru', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                          : '—'}
                      </span>
                      <span className="text-[11px] num text-[var(--muted)]">
                        {s.summary?.laps?.length ?? 0} кругов
                      </span>
                      <span className="text-[12px] num ml-auto">
                        {s.summary?.stats ? lapTime(s.summary.stats.best) : '—'}
                      </span>
                      <button onClick={e => { e.stopPropagation(); setConfirmDel(s); }}
                        title="Удалить заезд из библиотеки"
                        className="w-6 h-6 shrink-0 rounded flex items-center justify-center
                          text-[var(--muted-2)] hover:bg-white/10 hover:text-[var(--bad)] transition">×</button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmDel && (
        <div className="mt-3 rounded-lg p-3 text-[12px] leading-relaxed"
          style={{ background: 'rgba(255,107,107,0.09)' }}>
          Удалить заезд {confirmDel.driverName ?? ''}
          {confirmDel.recordedAt && <> от {new Date(confirmDel.recordedAt).toLocaleDateString('ru')}</>}?
          Файл телеметрии и вся статистика пропадут безвозвратно.
          <div className="flex gap-2 mt-2">
            <button onClick={() => del(confirmDel)}
              className="px-3 py-1.5 rounded-lg border border-[#5a2b2b] bg-[#1a1113] text-[#ffb3b3] hover:bg-[#241618] transition">
              удалить
            </button>
            <button onClick={() => setConfirmDel(null)}
              className="px-3 py-1.5 rounded-lg border border-[var(--line)] hover:bg-[var(--panel-2)] transition">
              отмена
            </button>
          </div>
        </div>
      )}

      {tab === 'sessions' && (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--line-soft)]">
          <span className="text-[11px] text-[var(--muted-2)]">
            {sel.length ? `выбрано ${sel.length} из ${max}` : `отметьте до ${max} заездов для сравнения`}
          </span>
          <button onClick={open} disabled={!sel.length}
            className="ml-auto px-4 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--line)]
              text-[13px] hover:bg-[#1d222d] transition disabled:opacity-40 disabled:cursor-default">
            Открыть
          </button>
        </div>
      )}
    </Shell>
  );
}

/** Справочники: пилоты и конфигурации трасс. */
function Manage({ cloud }: { cloud: CloudState }) {
  const [ask, setAsk] = useState<{ kind: 'driver' | 'config'; id: string; name: string; n: number } | null>(null);
  const [add, setAdd] = useState('');

  const run = async (fn: () => Promise<void>) => {
    try { await fn(); await cloud.refresh(); }
    catch (e) { cloud.setError(e instanceof Error ? e.message : String(e)); }
    finally { setAsk(null); }
  };

  const driverCount = (id: string) => cloud.sessions.filter(s => s.driverId === id).length;
  const configCount = (id: string) => cloud.sessions.filter(s => s.configId === id).length;
  const orphans = cloud.sessions.filter(s => !s.driverId);

  return (
    <div className="flex flex-col gap-5 max-h-[52vh] overflow-y-auto pr-1">
      <Section title="Пилоты" hint="Удаление пилота не стирает его заезды — они останутся в библиотеке без пилота, и их можно назначить заново.">
        {cloud.drivers.map(d => (
          <Line key={d.id}
            name={d.name}
            meta={`${driverCount(d.id)} ${plural(driverCount(d.id), 'заезд', 'заезда', 'заездов')}`}
            onRename={v => run(() => renameDriver(d.id, v))}
            onDelete={() => setAsk({ kind: 'driver', id: d.id, name: d.name, n: driverCount(d.id) })} />
        ))}
        <div className="flex gap-2 mt-1">
          <input value={add} onChange={e => setAdd(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && add.trim() && cloud.team) {
                const name = add.trim();
                setAdd('');
                run(() => createDriver(cloud.team!.id, name).then(() => undefined));
              }
            }}
            placeholder="имя нового пилота" className={`${fld} w-[200px]`} />
          <button
            disabled={!add.trim() || !cloud.team}
            onClick={() => {
              const name = add.trim();
              setAdd('');
              run(() => createDriver(cloud.team!.id, name).then(() => undefined));
            }}
            className="px-3 py-1.5 rounded-lg border border-[var(--line)] text-[12px]
              hover:bg-[var(--panel-2)] transition disabled:opacity-40">
            добавить
          </button>
        </div>
        {!cloud.drivers.length && <Empty text="Пилотов пока нет." />}
      </Section>

      {orphans.length > 0 && (
        <Section title="Заезды без пилота" hint="Назначьте пилота — иначе они не попадут ни в чью статистику.">
          {orphans.map(s => (
            <div key={s.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03]">
              <span className="text-[12px] text-[var(--muted)] num w-[130px]">
                {s.recordedAt ? new Date(s.recordedAt).toLocaleString('ru', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
              </span>
              <span className="text-[11px] text-[var(--muted-2)]">{s.trackName} · {s.configName}</span>
              <select defaultValue="" onChange={e => e.target.value && run(() => reassignSession(s.id, e.target.value))}
                className="ml-auto bg-[var(--panel-2)] border border-[var(--line)] rounded px-2 py-1
                  text-[12px] outline-none focus:border-[var(--muted-2)]">
                <option value="">— назначить пилота —</option>
                {cloud.drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          ))}
        </Section>
      )}

      <Section title="Трассы" hint="Конфигурация удаляется только пустой: иначе заезды остались бы без привязки, а восстановить её потом нечем.">
        {cloud.configs.map(c => (
          <Line key={c.id}
            name={`${c.trackName} · ${c.name}`}
            meta={`${clockwise(c.signature) ? '↻' : '↺'} ${directionName(c.signature)} · ${c.length.toFixed(0)} м · `
              + `${configCount(c.id)} ${plural(configCount(c.id), 'заезд', 'заезда', 'заездов')}`}
            renameValue={c.name}
            onRename={v => run(() => renameConfig(c.id, v))}
            onDelete={() => setAsk({ kind: 'config', id: c.id, name: c.name, n: configCount(c.id) })} />
        ))}
        {!cloud.configs.length && <Empty text="Трассы появятся после первой загрузки." />}
      </Section>

      {ask && (
        <div className="rounded-lg p-3 text-[12px] leading-relaxed sticky bottom-0"
          style={{ background: 'rgba(255,107,107,0.12)' }}>
          {ask.kind === 'driver' ? (
            <>Удалить пилота «{ask.name}»?{' '}
              {ask.n > 0
                ? <>Его {ask.n} {plural(ask.n, 'заезд останется', 'заезда останутся', 'заездов останутся')} в
                  библиотеке, но без пилота — назначить заново можно тут же.</>
                : <>Заездов у него нет.</>}
            </>
          ) : (
            <>Удалить конфигурацию «{ask.name}»?{' '}
              {ask.n > 0
                ? <>В ней {ask.n} {plural(ask.n, 'заезд', 'заезда', 'заездов')} — сначала удалите их.</>
                : <>Она пуста, заезды не пострадают.</>}
            </>
          )}
          <div className="flex gap-2 mt-2">
            <button
              disabled={ask.kind === 'config' && ask.n > 0}
              onClick={() => run(() => (ask.kind === 'driver' ? deleteDriver(ask.id) : deleteConfig(ask.id)))}
              className="px-3 py-1.5 rounded-lg border border-[#5a2b2b] bg-[#1a1113] text-[#ffb3b3]
                hover:bg-[#241618] transition disabled:opacity-40 disabled:cursor-default">
              удалить
            </button>
            <button onClick={() => setAsk(null)}
              className="px-3 py-1.5 rounded-lg border border-[var(--line)] hover:bg-[var(--panel-2)] transition">
              отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const fld = 'bg-[var(--panel-2)] border border-[var(--line)] rounded-lg px-2.5 py-1.5 '
  + 'text-[12px] outline-none focus:border-[var(--muted-2)] transition '
  + 'placeholder:text-[var(--muted-2)] [color-scheme:dark]';

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[12px] font-medium mb-0.5">{title}</div>
      <div className="text-[11px] text-[var(--muted-2)] leading-relaxed mb-2">{hint}</div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

const Empty = ({ text }: { text: string }) =>
  <div className="text-[12px] text-[var(--muted-2)] py-2">{text}</div>;

function Line({ name, meta, renameValue, onRename, onDelete }: {
  name: string; meta: string; renameValue?: string;
  onRename: (v: string) => void; onDelete: () => void;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const value = renameValue ?? name;

  return (
    <div className="group flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.03]">
      {edit == null ? (
        <span className="text-[13px]">{name}</span>
      ) : (
        <input autoFocus value={edit} onChange={e => setEdit(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && edit.trim()) { onRename(edit.trim()); setEdit(null); }
            if (e.key === 'Escape') setEdit(null);
          }}
          onBlur={() => setEdit(null)}
          className="bg-[var(--panel-2)] border border-[var(--line)] rounded px-2 py-1
            text-[13px] outline-none focus:border-[var(--muted-2)]" />
      )}
      <span className="text-[11px] text-[var(--muted)] num">{meta}</span>
      <button onClick={() => setEdit(value)}
        className="ml-auto text-[11px] text-[var(--muted-2)] hover:text-[var(--text)] transition">
        переименовать
      </button>
      <button onClick={onDelete} title="Удалить"
        className="w-6 h-6 shrink-0 rounded flex items-center justify-center
          text-[var(--muted-2)] hover:bg-white/10 hover:text-[var(--bad)] transition">×</button>
    </div>
  );
}
