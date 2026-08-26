import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareSession, type PreparedSession } from '../../data/upload';
import { commitSession, createConfig, createDriver, aliasHint, findDuplicate, type SessionRow } from '../../data/api';
import { matchTracks, findConfig } from '../../core/trackid';
import type { CloudState } from './state';
import { Shell } from './Auth';
import { lapTime } from '../format';

interface Pending {
  key: string;
  p: PreparedSession;
  duplicate: SessionRow | null;
  /** найденная конфигурация трассы, если узнали */
  configId: string | null;
  /** площадка, к которой линия ближе двух километров — новая конфигурация ляжет к ней */
  venueId: string | null;
  venueName: string;
  note: string;
  driverId: string;
  newTrackName: string;
  newConfigName: string;
  state: 'ready' | 'saving' | 'done' | 'error';
  error?: string;
}

export function Upload({ cloud, files, onClose, onDone }: {
  cloud: CloudState;
  files: File[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [items, setItems] = useState<Pending[] | null>(null);
  const [progress, setProgress] = useState('');
  const [newDriver, setNewDriver] = useState('');
  const started = useRef(false);

  const prepare = useCallback(async () => {
    const out: Pending[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setProgress(`Разбираю ${f.name} (${i + 1} из ${files.length})…`);
      try {
        const p = await prepareSession(f.name, await f.text());
        const dup = cloud.team ? await findDuplicate(cloud.team.id, p.contentHash, p.fingerprint) : null;
        const hit = findConfig(p.signature, cloud.configs);

        // Конфигурацию не узнали — но площадка может быть знакомой.
        let venueId: string | null = null, venueName = '';
        if (!hit) {
          for (const c of cloud.configs) {
            if (matchTracks(p.signature, c.signature).sameVenue) { venueId = c.trackId; venueName = c.trackName; break; }
          }
        }
        const hint = cloud.team ? await aliasHint(cloud.team.id, p.racer) : null;
        out.push({
          key: `${f.name}|${f.size}|${f.lastModified}`,
          p, duplicate: dup,
          configId: hit?.config.id ?? null,
          venueId, venueName,
          note: hit
            ? `${hit.config.trackName} · ${hit.config.name} — узнал по траектории (расхождение ${hit.match.spread.toFixed(1)} м)`
            : venueId
              ? `Площадка «${venueName}» знакома, но конфигурация новая`
              : 'Новая трасса',
          driverId: hint ?? '',
          newTrackName: venueId ? venueName : '',
          newConfigName: hit ? '' : 'Основная',
          state: 'ready',
        });
      } catch (e) {
        out.push({
          key: f.name, p: null as unknown as PreparedSession, duplicate: null,
          configId: null, venueId: null, venueName: '', note: '',
          driverId: '', newTrackName: '', newConfigName: '',
          state: 'error', error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    setProgress('');
    setItems(out);
  }, [files, cloud.team, cloud.configs]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    prepare();
  }, [prepare]);

  const patch = (key: string, v: Partial<Pending>) =>
    setItems(list => list?.map(it => (it.key === key ? { ...it, ...v } : it)) ?? null);

  const addDriver = async () => {
    const name = newDriver.trim();
    if (!name || !cloud.team) return;
    try {
      const d = await createDriver(cloud.team.id, name);
      setNewDriver('');
      await cloud.refresh();
      // новый пилот — самый вероятный ответ для строк, где пилот ещё не выбран
      setItems(list => list?.map(it => (it.driverId ? it : { ...it, driverId: d.id })) ?? null);
    } catch (e) {
      cloud.setError(e instanceof Error ? e.message : String(e));
    }
  };

  const uploadable = (items ?? []).filter(it => it.state === 'ready' && !it.duplicate);
  const incomplete = uploadable.filter(it =>
    !it.driverId || (!it.configId && (!it.newConfigName.trim() || (!it.venueId && !it.newTrackName.trim()))));

  const run = async () => {
    if (!cloud.team) return;
    for (const it of uploadable) {
      patch(it.key, { state: 'saving' });
      try {
        let configId = it.configId;
        if (!configId) {
          const cfg = await createConfig(cloud.team.id, it.p.signature, {
            trackId: it.venueId ?? undefined,
            trackName: it.venueId ? undefined : it.newTrackName.trim(),
            configName: it.newConfigName.trim(),
          });
          configId = cfg.id;
          await cloud.refresh();
        }
        await commitSession(cloud.team.id, it.p, { driverId: it.driverId, configId });
        patch(it.key, { state: 'done' });
      } catch (e) {
        patch(it.key, { state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    await cloud.refresh();
    onDone();
  };

  const allDone = items?.length && items.every(it => it.state === 'done' || it.duplicate || it.state === 'error');

  return (
    <Shell title="Загрузка заездов" onClose={onClose} wide>
      {!items && (
        <div className="py-8 text-center text-[13px] text-[var(--muted)]">
          <div className="w-6 h-6 mx-auto mb-3 rounded-full border-2 border-[var(--line)] border-t-[var(--text)] animate-spin" />
          {progress || 'Готовлю…'}
        </div>
      )}

      {items && (
        <>
          <div className="flex flex-col gap-2 mb-3">
            {items.map(it => (
              <Row key={it.key} it={it} cloud={cloud} patch={patch} />
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap border-t border-[var(--line-soft)] pt-3">
            <input
              value={newDriver} onChange={e => setNewDriver(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addDriver(); }}
              placeholder="добавить пилота"
              className="bg-[var(--panel-2)] border border-[var(--line)] rounded-lg px-3 py-1.5
                text-[12px] outline-none focus:border-[var(--muted-2)] w-[200px]" />
            <button onClick={addDriver} disabled={!newDriver.trim()}
              className="px-3 py-1.5 rounded-lg border border-[var(--line)] text-[12px]
                hover:bg-[var(--panel-2)] transition disabled:opacity-40">добавить</button>

            <button
              onClick={allDone ? onClose : run}
              disabled={!allDone && (!uploadable.length || incomplete.length > 0)}
              className="ml-auto px-4 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--line)]
                text-[13px] hover:bg-[#1d222d] transition disabled:opacity-40 disabled:cursor-default">
              {allDone ? 'Готово' : `Загрузить ${uploadable.length}`}
            </button>
          </div>

          {!allDone && incomplete.length > 0 && (
            <div className="text-[11px] text-[var(--muted-2)] mt-2 text-right">
              Осталось указать пилота и трассу
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

function Row({ it, cloud, patch }: {
  it: Pending; cloud: CloudState; patch: (k: string, v: Partial<Pending>) => void;
}) {
  if (it.state === 'error' && !it.p) {
    return (
      <div className="rounded-lg p-3 text-[12px]" style={{ background: 'rgba(255,107,107,0.08)' }}>
        <span className="text-[#ffb3b3]">{it.key}: {it.error}</span>
      </div>
    );
  }

  const s = it.p.summary;
  return (
    <div className="rounded-lg p-3" style={{
      background: it.state === 'done' ? 'rgba(81,207,102,0.08)'
        : it.duplicate ? 'rgba(255,212,59,0.07)' : 'rgba(255,255,255,0.03)',
    }}>
      <div className="flex items-baseline gap-2 flex-wrap mb-1.5">
        <span className="text-[13px] font-medium">{it.p.fileName}</span>
        <span className="text-[11px] text-[var(--muted)] num">
          {s.laps.length} кругов · лучший {lapTime(s.stats.best)} · {s.trackLength.toFixed(0)} м ·
          {' '}{(it.p.sizes.csv / 1048576).toFixed(1)} МБ → {(it.p.sizes.packed / 1024).toFixed(0)} КБ
        </span>
        {it.state === 'saving' && <span className="text-[11px] text-[var(--muted)] ml-auto">сохраняю…</span>}
        {it.state === 'done' && <span className="text-[11px] text-[var(--good)] ml-auto">загружен</span>}
      </div>

      {it.duplicate ? (
        <div className="text-[12px] text-[#ffd9a0] leading-relaxed">
          Этот заезд уже в библиотеке
          {it.duplicate.driverName && <> — {it.duplicate.driverName}</>}
          {it.duplicate.recordedAt && <>, {new Date(it.duplicate.recordedAt).toLocaleString('ru')}</>}.
          Повторно грузить нечего.
        </div>
      ) : it.state === 'error' ? (
        <div className="text-[12px] text-[#ffb3b3]">{it.error}</div>
      ) : it.state === 'done' ? null : (
        <div className="flex gap-2 flex-wrap items-end">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[var(--muted-2)]">
              пилот{it.p.racer && <> · в логе «{it.p.racer}»</>}
            </span>
            <select value={it.driverId} onChange={e => patch(it.key, { driverId: e.target.value })}
              className={sel}>
              <option value="">— выберите —</option>
              {cloud.drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>

          {it.configId ? (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-[var(--muted-2)]">трасса</span>
              <span className="text-[12px] text-[var(--good)] py-1.5">{it.note}</span>
            </div>
          ) : (
            <>
              {!it.venueId && (
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-[var(--muted-2)]">название трассы</span>
                  <input value={it.newTrackName} onChange={e => patch(it.key, { newTrackName: e.target.value })}
                    placeholder="например, Kartland" className={inp} />
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-[var(--muted-2)]">
                  конфигурация{it.venueId && <> на «{it.venueName}»</>}
                </span>
                <input value={it.newConfigName} onChange={e => patch(it.key, { newConfigName: e.target.value })}
                  placeholder="например, Большое кольцо" className={inp} />
              </label>
              <span className="text-[11px] text-[var(--muted-2)] py-2">{it.note}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const sel = 'bg-[var(--panel-2)] border border-[var(--line)] rounded px-2 py-1.5 text-[12px] '
  + 'outline-none focus:border-[var(--muted-2)] min-w-[160px]';
const inp = sel + ' placeholder:text-[var(--muted-2)]';
