import { useMemo, useRef, useState } from 'react';
import { deleteSession, signOut, type SessionRow } from '../../data/api';
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
  const [sel, setSel] = useState<string[]>(picked);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [confirmDel, setConfirmDel] = useState<SessionRow | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Группируем по трассе: сравнивать заезды имеет смысл внутри одной конфигурации.
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; rows: SessionRow[] }>();
    for (const s of cloud.sessions) {
      const key = s.configId ?? 'нет';
      const title = s.trackName ? `${s.trackName} · ${s.configName}` : 'Трасса не определена';
      (m.get(key) ?? m.set(key, { title, rows: [] }).get(key)!).rows.push(s);
    }
    return [...m.values()];
  }, [cloud.sessions]);

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
        onClose={() => setPendingFiles(null)}
        onDone={() => setPendingFiles(null)} />
    );
  }

  return (
    <Shell title="Библиотека заездов" onClose={onClose} wide>
      <div className="flex items-center gap-2 flex-wrap mb-3 text-[12px]">
        <span className="text-[var(--muted)]">
          {cloud.team?.name} · {cloud.email}
          {cloud.sessions.length > 0 && (
            <> · {cloud.sessions.length} {plural(cloud.sessions.length, 'заезд', 'заезда', 'заездов')}</>
          )}
        </span>
        <button onClick={() => signOut()} className="text-[var(--muted-2)] hover:text-[var(--text)] transition">
          выйти
        </button>
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

      {!cloud.sessions.length ? (
        <div className="py-10 text-center text-[13px] text-[var(--muted)] leading-relaxed">
          Библиотека пуста.<br />
          Загрузите первые CSV — дальше они будут открываться отсюда, без перезаливки.
        </div>
      ) : (
        <div className="flex flex-col gap-4 max-h-[52vh] overflow-y-auto pr-1">
          {groups.map(g => (
            <div key={g.title}>
              <div className="text-[11px] text-[var(--muted-2)] mb-1.5 sticky top-0 bg-[var(--panel)] py-1">
                {g.title}
              </div>
              <div className="flex flex-col gap-1">
                {g.rows.map(s => {
                  const on = sel.includes(s.id);
                  const full = !on && sel.length >= max;
                  return (
                    <div key={s.id}
                      onClick={() => !full && toggle(s.id)}
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
                      <button
                        onClick={e => { e.stopPropagation(); setConfirmDel(s); }}
                        title="Удалить заезд из библиотеки"
                        className="w-6 h-6 shrink-0 rounded flex items-center justify-center text-[var(--muted-2)]
                          opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-[var(--text)] transition">×</button>
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
          Файл и вся статистика пропадут безвозвратно.
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
    </Shell>
  );
}
