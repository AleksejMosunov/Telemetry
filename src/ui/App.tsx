import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Analysis, DriverResult } from '../core/pipeline';
import { driverColor } from '../core/pipeline';
import { lapTime } from './format';
import { Overview } from './views/Overview';
import { Corners } from './views/Corners';
import { Traces } from './views/Traces';
import { Consistency } from './views/Consistency';
import { Findings } from './views/Findings';

export type LapMode = 'median' | 'best';
const TABS = [
  ['overview', 'Обзор'], ['corners', 'Повороты'], ['traces', 'Графики'],
  ['consistency', 'Стабильность'], ['findings', 'Выводы'],
] as const;
type Tab = typeof TABS[number][0];

export interface ViewCtx {
  a: Analysis;
  ref: DriverResult;
  refId: string;
  lapMode: LapMode;
  cursorS: number | null;
  setCursorS: (s: number | null) => void;
  name: (d: DriverResult) => string;
  color: (d: DriverResult) => string;
  V: (d: DriverResult) => Float64Array;
  T: (d: DriverResult) => Float64Array;
  LAT: (d: DriverResult) => Float64Array;
  Z: (d: DriverResult) => DriverResult['zoneMed'];
}

export function App() {
  const [a, setA] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refId, setRefId] = useState('d0');
  const [lapMode, setLapMode] = useState<LapMode>('median');
  const [tab, setTab] = useState<Tab>('overview');
  const [cursorS, setCursorS] = useState<number | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async (files: File[]) => {
    const csv = files.filter(f => /\.csv$/i.test(f.name));
    if (!csv.length) { setErr('Нужны CSV-файлы, выгруженные из RaceStudio 3'); return; }
    if (csv.length > 6) { setErr('Больше 6 заездов за раз пока не поддерживается'); return; }
    setBusy(true); setErr(null);
    try {
      const payload = await Promise.all(csv.map(async f => ({ name: f.name, text: await f.text() })));
      const w = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
      const result = await new Promise<Analysis>((res, rej) => {
        w.onmessage = (e) => (e.data.ok ? res(e.data.result) : rej(new Error(e.data.error)));
        w.onerror = () => rej(new Error('Сбой при разборе файлов'));
        w.postMessage({ files: payload });
      });
      w.terminate();
      setA(result);
      setNames({});
      // опорным берём самого быстрого — от него считаются все дельты
      setRefId(result.drivers.reduce((p, q) => (p.stats.best <= q.stats.best ? p : q)).id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); setDrag(true); };
    const leave = (e: DragEvent) => { if (e.relatedTarget === null) setDrag(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault(); setDrag(false);
      if (e.dataTransfer?.files.length) load([...e.dataTransfer.files]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [load]);

  const ctx: ViewCtx | null = useMemo(() => {
    if (!a) return null;
    const ref = a.drivers.find(d => d.id === refId) ?? a.drivers[0];
    const idx = (d: DriverResult) => a.drivers.indexOf(d);
    return {
      a, ref, refId: ref.id, lapMode, cursorS, setCursorS,
      name: (d) => names[d.id] ?? d.name,
      color: (d) => driverColor(idx(d)),
      V: (d) => (lapMode === 'best' ? d.bestV : d.medV),
      T: (d) => (lapMode === 'best' ? d.bestT : d.medT),
      LAT: (d) => (lapMode === 'best' ? d.bestLat : d.medLat),
      Z: (d) => (lapMode === 'best' ? d.zoneBest : d.zoneMed),
    };
  }, [a, refId, lapMode, cursorS, names]);

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-[#0a0c10]/95 backdrop-blur">
        <div className="max-w-[1500px] mx-auto px-5 py-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="font-semibold tracking-tight">Телеметрия</span>
            <span className="text-[var(--muted-2)] text-xs">картинг</span>
          </div>

          {a && (
            <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
              {a.drivers.map((d, i) => (
                <button
                  key={d.id}
                  onClick={() => setRefId(d.id)}
                  title="Сделать опорным — от него считаются все дельты"
                  className={`group flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg border text-left transition
                    ${d.id === refId ? 'border-[var(--line)] bg-[var(--panel-2)]' : 'border-transparent hover:bg-[var(--panel)]'}`}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: driverColor(i) }} />
                  <span className="flex flex-col leading-tight">
                    <input
                      value={names[d.id] ?? d.name}
                      onChange={e => setNames(n => ({ ...n, [d.id]: e.target.value }))}
                      onClick={e => e.stopPropagation()}
                      className="bg-transparent outline-none text-[13px] font-medium w-[150px] focus:border-b focus:border-[var(--line)]"
                    />
                    <span className="num text-[11px] text-[var(--muted)]">
                      {lapTime(d.stats.best)} · σ {d.stats.sd.toFixed(3)}
                      {d.id === refId && <span className="text-[var(--muted-2)]"> · опорный</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {a && (
              <div className="flex rounded-lg border border-[var(--line)] overflow-hidden text-xs">
                {(['median', 'best'] as const).map(m => (
                  <button key={m} onClick={() => setLapMode(m)}
                    className={`px-3 py-1.5 transition ${lapMode === m ? 'bg-[var(--panel-2)] text-[var(--text)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
                    {m === 'median' ? 'медианный круг' : 'лучший круг'}
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => input.current?.click()}
              className="px-3 py-1.5 rounded-lg border border-[var(--line)] text-xs hover:bg-[var(--panel-2)] transition">
              {a ? 'Загрузить другие' : 'Выбрать файлы'}
            </button>
            <input ref={input} type="file" accept=".csv" multiple hidden
              onChange={e => e.target.files && load([...e.target.files])} />
          </div>
        </div>

        {a && (
          <div className="max-w-[1500px] mx-auto px-5 flex gap-1 -mb-px">
            {TABS.map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-3.5 py-2 text-[13px] border-b-2 transition
                  ${tab === id ? 'border-[var(--text)] text-[var(--text)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 max-w-[1500px] w-full mx-auto px-5 py-5">
        {err && (
          <div className="panel p-4 mb-4 border-[#5a2b2b] bg-[#1a1113] text-[#ffb3b3] text-[13px]">{err}</div>
        )}
        {a?.warnings.map((w, i) => (
          <div key={i} className="panel p-3 mb-3 border-[#5a4a2b] bg-[#191510] text-[#ffd9a0] text-[13px]">{w}</div>
        ))}

        {busy && <Splash busy />}
        {!a && !busy && <Splash />}

        {a && ctx && !busy && (
          <>
            {tab === 'overview' && <Overview ctx={ctx} />}
            {tab === 'corners' && <Corners ctx={ctx} />}
            {tab === 'traces' && <Traces ctx={ctx} />}
            {tab === 'consistency' && <Consistency ctx={ctx} />}
            {tab === 'findings' && <Findings ctx={ctx} />}
          </>
        )}
      </main>

      {drag && (
        <div className="fixed inset-0 z-50 bg-[#0a0c10]/85 flex items-center justify-center pointer-events-none">
          
          <div className="text-lg text-[var(--muted)]">Отпустите файлы</div>
        </div>
      )}
    </div>
  );
}

function Splash({ busy }: { busy?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-28 text-center">
      {busy ? (
        <>
          <div className="w-7 h-7 rounded-full border-2 border-[var(--line)] border-t-[var(--text)] animate-spin mb-4" />
          <div className="text-[var(--muted)] text-sm">Разбираю логи, строю трассу…</div>
        </>
      ) : (
        <>
          <div className="text-[15px] mb-2">Перетащите сюда CSV-файлы заездов</div>
          <div className="text-[var(--muted)] text-[13px] max-w-md leading-relaxed">
            Экспорт из RaceStudio 3 с включёнными каналами GPS Latitude и GPS Longitude.
            Один файл — анализ заезда, несколько — сравнение пилотов.
            Трасса и повороты определяются из логов сами.
          </div>
        </>
      )}
    </div>
  );
}
