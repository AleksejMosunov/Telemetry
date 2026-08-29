import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Analysis, DriverResult } from '../core/pipeline';
import { driverColor, buildComparison } from '../core/pipeline';
import { lapTime, plural } from './format';
import type { WorkerSource } from '../worker';
import {
  downloadSamples, setExclusions, listExclusions, saveConfigSectors, type SessionRow,
} from '../data/api';
import { sectorsFromCuts, type Sector } from '../core/analysis';
import { useCloud } from './cloud/state';
import { Auth } from './cloud/Auth';
import { Library } from './cloud/Library';
import { Overview } from './views/Overview';
import { Corners } from './views/Corners';
import { Traces } from './views/Traces';
import { Consistency } from './views/Consistency';
import { Replay } from './views/Replay';
import { Findings } from './views/Findings';

export type LapMode = 'median' | 'best';

/** Заезд может прийти с диска или из библиотеки — дальше путь один и тот же. */
export interface Source {
  key: string;
  name: string;
  /** Имя привязанного пилота из библиотеки — сильнее поля Racer в файле. */
  displayName?: string;
  file?: File;
  row?: SessionRow;
}
const fileKey = (f: File) => `f:${f.name}|${f.size}|${f.lastModified}`;

/** Снятые вручную круги: отпечаток заезда -> номера кругов. */
export type Excluded = Record<string, number[]>;

const NAME_KEY = 'karting.driverNames';
const EXCL_KEY = 'karting.excludedLaps';
const OPEN_KEY = 'karting.openSessions';
const SEC_KEY = 'karting.sectors';

/** Что было открыто из библиотеки. Файлы с диска так не сохранить: браузер
 *  не даёт держать ссылку на файл между перезагрузками. */
function loadOpen(): string[] {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'); } catch { return []; }
}
function persistOpen(ids: string[]) {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(ids)); } catch { /* приватный режим */ }
}

/** Ключ трассы для локального хранения границ секторов: площадка плюс длина круга.
 *  Для заездов из библиотеки границы живут в базе и общие для команды, а этот
 *  запасной путь нужен файлам с диска и работе без облака. */
function trackKey(sig: { lat: number; lon: number; length: number }) {
  return `${sig.lat.toFixed(3)}|${sig.lon.toFixed(3)}|${Math.round(sig.length / 5)}`;
}
function loadLocalSectors(): Record<string, number[]> {
  try { return JSON.parse(localStorage.getItem(SEC_KEY) || '{}'); } catch { return {}; }
}
function persistLocalSectors(key: string, cuts: number[] | null) {
  try {
    const all = loadLocalSectors();
    if (cuts?.length) all[key] = cuts; else delete all[key];
    localStorage.setItem(SEC_KEY, JSON.stringify(all));
  } catch { /* приватный режим */ }
}

/** Имена пилотов переживают перезагрузку: ключ — отпечаток заезда, а не порядок файлов. */
function loadNames(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(NAME_KEY) || '{}'); } catch { return {}; }
}
function persistName(fingerprint: string, value: string) {
  try {
    const all = loadNames();
    const v = value.trim();
    if (v) all[fingerprint] = v; else delete all[fingerprint];
    localStorage.setItem(NAME_KEY, JSON.stringify(all));
  } catch { /* приватный режим — просто не запоминаем */ }
}

/** Снятые круги тоже запоминаются: разбор заезда обычно идёт в несколько заходов. */
function loadExcluded(): Excluded {
  try { return JSON.parse(localStorage.getItem(EXCL_KEY) || '{}'); } catch { return {}; }
}
function persistExcluded(v: Excluded) {
  try { localStorage.setItem(EXCL_KEY, JSON.stringify(v)); } catch { /* см. выше */ }
}

const TABS = [
  ['overview', 'Обзор'], ['corners', 'Повороты'], ['traces', 'Графики'],
  ['consistency', 'Стабильность'], ['replay', 'Повтор'], ['findings', 'Выводы'],
] as const;
type Tab = typeof TABS[number][0];

export interface ViewCtx {
  a: Analysis;
  /** Кого показывать в сравнительных вкладках: заезды плюс включённые призраки
   *  «свой лучший круг». «Обзор», «Стабильность» и «Выводы» этим списком не
   *  пользуются — они считают по всем кругам заезда и берут a.drivers. */
  cmp: DriverResult[];
  /** id заездов, для которых включён призрак лучшего круга */
  ghosts: string[];
  /** включить/выключить призрака для заезда */
  toggleGhost: (d: DriverResult) => void;
  /** заезд -> номер круга, которым он участвует в сравнении; нет записи = как у всех */
  lapPick: Record<string, number>;
  /** привязать заезд к кругу; null — вернуть общий режим */
  setLapPick: (d: DriverResult, lapIndex: number | null) => void;
  /** Каким участником сравнения представлен этот заезд: копией с выбранным
   *  кругом, если круг выбран, иначе им самим. «Обзор» рисует настоящие заезды,
   *  но карту трассы должен строить по тому, что реально сравнивается. */
  view: (d: DriverResult) => DriverResult;
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
  /** длина реально пройденной траектории по зонам, м */
  ZP: (d: DriverResult) => Float64Array;
  /** где карт распрямляется после апекса, м от апекса; NaN — гироскопа нет */
  ZU: (d: DriverResult) => Float64Array;
  /** разброс траектории по кругам, м; в режиме лучшего круга его нет */
  LATSD: (d: DriverResult) => Float64Array | null;
  /** снятые вручную круги заезда */
  exclOf: (d: DriverResult) => number[];
  /** заменить набор снятых кругов и пересчитать весь анализ */
  setExcl: (d: DriverResult, indices: number[]) => void;
  /** идёт пересчёт — на это время клики блокируются */
  busy: boolean;
  /** действующие сектора: ручные границы трассы, если заданы, иначе автоматические */
  sectors: Sector[];
  /** ручные границы этой трассы в долях круга; null — сейчас работает автоматика */
  sectorCuts: number[] | null;
  /** сохранить границы для трассы (null — вернуть автоматические) */
  saveSectors: (cuts: number[] | null) => Promise<void>;
}

export function App() {
  const [a, setA] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refId, setRefId] = useState('d0');
  const [lapMode, setLapMode] = useState<LapMode>('median');
  const [ghosts, setGhosts] = useState<string[]>([]);
  /** заезд -> номер круга, которым он участвует в сравнении; нет записи = как у всех */
  const [lapPick, setLapPickState] = useState<Record<string, number>>({});
  const setLapPick = useCallback((d: DriverResult, lapIndex: number | null) => {
    setLapPickState(m => {
      const next = { ...m };
      if (lapIndex == null) delete next[d.id]; else next[d.id] = lapIndex;
      return next;
    });
  }, []);
  const toggleGhost = useCallback((d: DriverResult) => {
    setGhosts(g => (g.includes(d.id) ? g.filter(x => x !== d.id) : [...g, d.id]));
  }, []);
  const [tab, setTab] = useState<Tab>('overview');
  const [cursorS, setCursorS] = useState<number | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [excl, setExclState] = useState<Excluded>(loadExcluded);
  const [drag, setDrag] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [panel, setPanel] = useState<'none' | 'auth' | 'library'>('none');
  const input = useRef<HTMLInputElement>(null);
  const refIdRef = useRef<string | undefined>(undefined);
  const exclRef = useRef<Excluded>(excl);
  const cloud = useCloud();
  const gatedRef = useRef(false);

  const sourcesRef = useRef<Source[]>([]);
  /** Уже прочитанное содержимое: пересчёт после снятия круга не должен
   *  заново поднимать с диска десятки мегабайт и тем более лезть в сеть. */
  const dataCache = useRef(new Map<string, WorkerSource>());
  /** отпечаток заезда -> id в библиотеке: по нему снятые круги пишутся в базу */
  const cloudIdByFp = useRef(new Map<string, string>());
  const MAX = 6;

  /** Пересчёт всего набора. Опорный пилот держится за отпечаток заезда,
   *  иначе он бы прыгал при каждом добавлении файла. */
  const runAnalysis = useCallback(async (list: Source[], keepRefFp?: string, excluded?: Excluded) => {
    sourcesRef.current = list;
    setSources(list);
    if (!list.length) { setA(null); setErr(null); persistOpen([]); return; }
    setBusy(true); setErr(null);
    try {
      const cache = dataCache.current;
      const keys = new Set(list.map(s => s.key));
      for (const k of [...cache.keys()]) if (!keys.has(k)) cache.delete(k);
      const payload = await Promise.all(list.map(async (src) => {
        let got = cache.get(src.key);
        if (!got) {
          got = src.file
            ? { name: src.name, csv: await src.file.text() }
            : { name: src.name, packed: await downloadSamples(src.row!) };
          cache.set(src.key, got);
        }
        // имя пилота могло смениться в библиотеке — обновляем и у кешированных байтов
        got.name = src.name;
        got.displayName = src.displayName;
        return got;
      }));
      const w = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
      const result = await new Promise<Analysis>((res, rej) => {
        w.onmessage = (e) => (e.data.ok ? res(e.data.result) : rej(new Error(e.data.error)));
        w.onerror = () => rej(new Error('Сбой при разборе заездов'));
        w.postMessage({ sources: payload, excluded: excluded ?? exclRef.current });
      });
      w.terminate();
      // Заезды из библиотеки помним по отпечатку: снятые круги хранятся в базе.
      cloudIdByFp.current = new Map(
        list.filter(s => s.row?.fingerprint).map(s => [s.row!.fingerprint!, s.row!.id]),
      );
      persistOpen(list.filter(s => s.row).map(s => s.row!.id));
      setA(result);
      const stored = loadNames();
      setNames(Object.fromEntries(result.drivers.map(d => [d.id, stored[d.fingerprint] ?? ''])));
      const keep = keepRefFp ? result.drivers.find(d => d.fingerprint === keepRefFp) : undefined;
      setRefId((keep ?? result.drivers.reduce((p, q) => (p.stats.best <= q.stats.best ? p : q))).id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, []);

  /** Снятие круга меняет медианы, потенциал и выводы — поэтому пересчитываем всё. */
  const applyExcl = useCallback((next: Excluded) => {
    for (const k of Object.keys(next)) if (!next[k]?.length) delete next[k];
    exclRef.current = next;
    setExclState(next);
    persistExcluded(next);
    // Для заездов из библиотеки снятые круги общие для команды — пишем в базу.
    for (const [fp, id] of cloudIdByFp.current) {
      setExclusions(id, next[fp] ?? []).catch(e => setErr(String(e)));
    }
    runAnalysis(sourcesRef.current, refIdRef.current, next);
  }, [runAnalysis]);

  const setExcl = useCallback((d: DriverResult, indices: number[]) => {
    applyExcl({ ...exclRef.current, [d.fingerprint]: [...indices].sort((x, y) => x - y) });
  }, [applyExcl]);

  /** Новые заезды добавляются к уже открытым, а не заменяют их. */
  const addSources = useCallback((incoming: Source[]) => {
    const have = new Set(sourcesRef.current.map(s => s.key));
    const fresh = incoming.filter(s => !have.has(s.key));
    if (!fresh.length) { setErr('Эти заезды уже открыты'); return; }
    const next = [...sourcesRef.current, ...fresh];
    if (next.length > MAX) {
      setErr(`Открыто ${sourcesRef.current.length}, добавляется ${fresh.length} — максимум ${MAX} заездов`);
      return;
    }
    setErr(null);
    runAnalysis(next, refIdRef.current);
  }, [runAnalysis]);

  const addFiles = useCallback((incoming: File[]) => {
    const csv = incoming.filter(f => /\.csv$/i.test(f.name));
    if (!csv.length) { setErr('Нужны CSV-файлы, выгруженные из RaceStudio 3'); return; }
    addSources(csv.map(f => ({ key: fileKey(f), name: f.name, file: f })));
  }, [addSources]);

  /** Открыть заезды из библиотеки: подтягиваем и снятые круги, они общие. */
  const openFromLibrary = useCallback(async (rows: SessionRow[]) => {
    setPanel('none');
    try {
      const fromDb = await listExclusions(rows.map(r => r.id));
      const merged = { ...exclRef.current };
      for (const r of rows) if (r.fingerprint) merged[r.fingerprint] = fromDb[r.id] ?? [];
      exclRef.current = merged;
      setExclState(merged);
      runAnalysis(rows.map(r => ({
        key: `c:${r.id}`,
        name: r.driverName ?? r.meta['Racer'] ?? 'заезд',
        displayName: r.driverName ?? undefined,
        row: r,
      })), refIdRef.current, merged);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [runAnalysis]);

  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); setDrag(true); };
    const leave = (e: DragEvent) => { if (e.relatedTarget === null) setDrag(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault(); setDrag(false);
      if (gatedRef.current) { setErr('Войдите, чтобы работать с телеметрией'); return; }
      if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [addFiles]);

  /** После перезагрузки возвращаем то, что было открыто из библиотеки. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || a || busy) return;
    if (!cloud.ready || !cloud.signedIn || !cloud.sessions.length) return;
    restored.current = true;
    const want = loadOpen();
    if (!want.length) return;
    const byId = new Map(cloud.sessions.map(s => [s.id, s]));
    const rows = want.map(id => byId.get(id)).filter((r): r is SessionRow => Boolean(r));
    if (rows.length) openFromLibrary(rows);
  }, [cloud.ready, cloud.signedIn, cloud.sessions, a, busy, openFromLibrary]);

  /** Привязка пилота в библиотеке применяется к уже открытым заездам сразу:
   *  байты лежат в кеше, пересчёт идёт без повторной загрузки. */
  useEffect(() => {
    const list = sourcesRef.current;
    if (!list.length || busy) return;
    const byFp = new Map(
      cloud.sessions.filter(s => s.fingerprint && s.driverName).map(s => [s.fingerprint!, s.driverName!]),
    );
    let changed = false;
    const next = list.map(s => {
      const nm = s.row?.fingerprint ? byFp.get(s.row.fingerprint) : undefined;
      if (!nm || nm === s.displayName) return s;
      changed = true;
      return { ...s, name: nm, displayName: nm };
    });
    if (changed) runAnalysis(next, refIdRef.current);
  }, [cloud.sessions, busy, runAnalysis]);

  gatedRef.current = cloud.enabled && cloud.ready && !cloud.signedIn;

  /** Конфигурация трассы, к которой относятся открытые заезды: у неё и живут
   *  ручные границы секторов. Для файлов с диска её нет — тогда работает
   *  локальная копия по ключу формы трассы. */
  const configId = useMemo(
    () => sources.find(s => s.row?.configId)?.row?.configId ?? null,
    [sources],
  );
  const localKey = a ? trackKey(a.signature) : null;

  const [localSectors, setLocalSectors] = useState<Record<string, number[]>>(loadLocalSectors);

  const sectorCuts = useMemo<number[] | null>(() => {
    if (!a) return null;
    const fromCloud = configId
      ? cloud.configs.find(c => c.id === configId)?.sectors ?? null
      : null;
    if (fromCloud?.length) return fromCloud;
    return (localKey && localSectors[localKey]?.length) ? localSectors[localKey] : null;
  }, [a, configId, cloud.configs, localKey, localSectors]);

  const sectors = useMemo<Sector[]>(() => {
    if (!a) return [];
    return sectorCuts?.length ? sectorsFromCuts(a.zones, a.track.length, sectorCuts) : a.sectors;
  }, [a, sectorCuts]);

  /** Границы трассы задаёт человек, и дальше они общие: в базе — для команды,
   *  локально — хотя бы для этого браузера. */
  const saveSectors = useCallback(async (cuts: number[] | null) => {
    if (localKey) {
      persistLocalSectors(localKey, cuts);
      setLocalSectors(loadLocalSectors());
    }
    if (configId && cloud.signedIn) {
      try {
        await saveConfigSectors(configId, cuts?.length ? cuts : null);
        await cloud.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
  }, [configId, localKey, cloud.signedIn, cloud.refresh]);

  // Курсор меняется на каждое движение мыши. Если бы он входил в этот useMemo,
  // все функции ctx получали бы новую identity, а вслед за ними пересчитывались
  // ряды графиков — отсюда рывки. Поэтому курсор подмешивается отдельно.
  const base = useMemo((): Omit<ViewCtx, 'cursorS' | 'setCursorS'> | null => {
    if (!a) return null;
    const ref = a.drivers.find(d => d.id === refId) ?? a.drivers[0];
    refIdRef.current = ref.fingerprint;
    // В режиме «лучший круг» призрак совпал бы с оригиналом, поэтому там его нет.
    const { cmp, colorOf } = buildComparison(a.drivers, lapPick, ghosts, lapMode);
    const own = (d: DriverResult) => (names[d.id]?.trim() ? names[d.id].trim() : d.name);
    return {
      a, cmp, ghosts, toggleGhost, lapPick, setLapPick, ref, refId: ref.id, lapMode, busy,
      sectors, sectorCuts, saveSectors,
      // Копия наследует имя своего заезда — в том числе вписанное вручную,
      // и подписывается номером круга: иначе две колонки одного пилота не различить.
      name: (d) => {
        if (!d.ghostOf || d.lapOf == null) return own(d);
        const p = a.drivers.find(x => x.id === d.ghostOf);
        const isBest = p && p.laps[p.bestIdx]?.index === d.lapOf;
        return `${p ? own(p) : d.name} · круг #${d.lapOf}${isBest ? ' (лучший)' : ''}`;
      },
      color: colorOf,
      view: (d) => cmp.find(x => x.id === d.id) ?? cmp.find(x => x.ghostOf === d.id) ?? d,
      V: (d) => (lapMode === 'best' ? d.bestV : d.medV),
      T: (d) => (lapMode === 'best' ? d.bestT : d.medT),
      LAT: (d) => (lapMode === 'best' ? d.bestLat : d.medLat),
      Z: (d) => (lapMode === 'best' ? d.zoneBest : d.zoneMed),
      ZP: (d) => (lapMode === 'best' ? d.bestPathByZone : d.medPathByZone),
      ZU: (d) => (lapMode === 'best'
        ? Float64Array.from(d.zoneBest, z => z.sUnwind)
        : d.unwindByZone),
      // У призрака один круг — коридора разброса нет.
      LATSD: (d) => (lapMode === 'best' || d.ghostOf ? null : d.medLatSd),
      exclOf: (d) => excl[d.fingerprint] ?? [],
      setExcl,
    };
  }, [a, refId, lapMode, names, excl, setExcl, busy, sectors, sectorCuts, saveSectors,
      ghosts, toggleGhost, lapPick, setLapPick]);

  const ctx: ViewCtx | null = useMemo(
    () => (base ? { ...base, cursorS, setCursorS } : null),
    [base, cursorS],
  );

  const cutCount = a ? a.drivers.reduce((n, d) => n + d.laps.filter(l => l.excluded).length, 0) : 0;
  /** Облако настроено, но пользователь не вошёл: работа с файлами закрыта.
   *  Это порядок в интерфейсе, а не защита — бандл статический, и разобрать
   *  собственный файл на своём диске гость технически всё равно смог бы. */
  const gated = cloud.enabled && cloud.ready && !cloud.signedIn;
  /** Ещё проверяем сохранённую сессию — не мигаем гостевым экраном. */
  const checking = cloud.enabled && !cloud.ready;

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-[#0a0c10]/95 backdrop-blur">
        <div className="max-w-[1500px] mx-auto px-3 sm:px-5 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-4 flex-wrap">
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="font-semibold tracking-tight">Телеметрия</span>
            <span className="text-[var(--muted-2)] text-xs">картинг</span>
          </div>

          {a && (
            <div className="flex items-center gap-2 min-w-0 grow shrink order-3 sm:order-none
              basis-full sm:basis-0 scroll-x">
              {a.drivers.map((d, i) => (
                <div
                  key={d.id}
                  onClick={() => setRefId(d.id)}
                  title="Сделать опорным — от него считаются все дельты"
                  className={`group flex items-center gap-2 shrink-0 pl-2 pr-1.5 py-1.5 rounded-lg border cursor-pointer transition
                    ${d.id === refId ? 'border-[var(--line)] bg-[var(--panel-2)]' : 'border-transparent hover:bg-[var(--panel)]'}`}
                >
                  {/* Цвет берём из контекста, а не по индексу: при выбранном круге
                      или включённом призраке порядок колонок сравнения отличается
                      от порядка заездов, и шапка разошлась бы с карточками. */}
                  <span className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: ctx ? ctx.color(d) : driverColor(a.drivers.indexOf(d)) }} />
                  <span className="flex flex-col leading-tight">
                    <span className="flex items-center gap-1">
                    <input
                      value={names[d.id] ?? ''}
                      placeholder={d.name}
                      title="Имя пилота — можно вписать своё, оно запомнится"
                      onChange={e => {
                        setNames(n => ({ ...n, [d.id]: e.target.value }));
                        persistName(d.fingerprint, e.target.value);
                      }}
                      onClick={e => e.stopPropagation()}
                      className="bg-transparent outline-none text-[13px] font-medium w-[118px] sm:w-[150px] rounded-sm
                        border-b border-dashed border-transparent hover:border-[var(--muted-2)]
                        focus:border-solid focus:border-[var(--text)]
                        placeholder:text-[var(--muted)] placeholder:font-normal transition-colors"
                    />
                    <span aria-hidden className="text-[10px] text-[var(--muted-2)] opacity-0 group-hover:opacity-100 transition-opacity">✎</span>
                    </span>
                    <span className="num text-[11px] text-[var(--muted)]">
                      {lapTime(d.stats.best)} · ±{d.stats.sd.toFixed(3)}
                      {d.id === refId && <span className="text-[var(--muted-2)]"> · опорный</span>}
                    </span>
                  </span>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      runAnalysis(sourcesRef.current.filter((_, k) => k !== i), refIdRef.current);
                    }}
                    title="Убрать этот заезд"
                    className="w-5 h-5 shrink-0 rounded flex items-center justify-center text-[var(--muted-2)]
                      opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-[var(--text)] transition"
                  >×</button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap ml-auto">
            {busy && a && (
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
                <span className="w-3 h-3 rounded-full border border-[var(--line)] border-t-[var(--text)] animate-spin" />
                пересчитываю
              </span>
            )}
            {cutCount > 0 && (
              <button
                onClick={() => applyExcl({})}
                title="Вернуть в расчёт все снятые круги"
                className="px-2.5 py-1.5 rounded-lg border border-[#5a4a2b] bg-[#191510] text-[#ffd9a0]
                  text-[11px] num hover:bg-[#221c12] transition"
              >
                снято {cutCount} {plural(cutCount, 'круг', 'круга', 'кругов')} · вернуть
              </button>
            )}
            {a && (
              <div className="flex rounded-lg border border-[var(--line)] overflow-hidden text-xs">
                {(['median', 'best'] as const).map(m => (
                  <button key={m} onClick={() => setLapMode(m)}
                    className={`px-3 py-1.5 transition ${lapMode === m ? 'bg-[var(--panel-2)] text-[var(--text)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
                    <span className="sm:hidden">{m === 'median' ? 'средний' : 'лучший'}</span>
                    <span className="hidden sm:inline">{m === 'median' ? 'усреднённый круг' : 'лучший круг'}</span>
                  </button>
                ))}
              </div>
            )}
            {cloud.enabled && cloud.ready && (
              <button
                onClick={() => setPanel(cloud.signedIn && cloud.team ? 'library' : 'auth')}
                title={cloud.signedIn ? 'Библиотека заездов' : 'Войти, чтобы хранить заезды в облаке'}
                className="px-3 py-1.5 rounded-lg border border-[var(--line)] text-xs
                  hover:bg-[var(--panel-2)] transition flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full"
                  style={{ background: cloud.signedIn ? 'var(--good)' : 'var(--muted-2)' }} />
                {cloud.signedIn
                  ? <>
                      <span className="sm:hidden">📁{cloud.sessions.length ? ` ${cloud.sessions.length}` : ''}</span>
                      <span className="hidden sm:inline">
                        Библиотека{cloud.sessions.length ? ` (${cloud.sessions.length})` : ''}
                      </span>
                    </>
                  : 'Войти'}
              </button>
            )}
            {!gated && (
              <button onClick={() => input.current?.click()}
                title="Разовый разбор файла с диска — в библиотеку он не попадёт"
                className="px-3 py-1.5 rounded-lg border border-[var(--line)] text-xs hover:bg-[var(--panel-2)] transition">
                {a
                  ? <>
                      <span className="sm:hidden">+ файл{sources.length ? ` ${sources.length}/${MAX}` : ''}</span>
                      <span className="hidden sm:inline">
                        Добавить файл{sources.length ? ` (${sources.length}/${MAX})` : ''}
                      </span>
                    </>
                  : 'Выбрать файлы'}
              </button>
            )}
            <input ref={input} type="file" accept=".csv" multiple hidden
              onChange={e => {
                if (e.target.files) addFiles([...e.target.files]);
                e.target.value = '';   // иначе тот же файл нельзя выбрать повторно после удаления
              }} />
          </div>
        </div>

        {a && (
          <div className="max-w-[1500px] mx-auto px-3 sm:px-5 flex gap-1 -mb-px scroll-x">
            {TABS.map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-3 sm:px-3.5 py-2 text-[13px] shrink-0 whitespace-nowrap border-b-2 transition
                  ${tab === id ? 'border-[var(--text)] text-[var(--text)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 max-w-[1500px] w-full mx-auto px-3 sm:px-5 py-4 sm:py-5">
        {err && (
          <div className="panel p-4 mb-4 border-[#5a2b2b] bg-[#1a1113] text-[#ffb3b3] text-[13px]">{err}</div>
        )}
        {a?.warnings.map((w, i) => (
          <div key={i} className="panel p-3 mb-3 border-[#5a4a2b] bg-[#191510] text-[#ffd9a0] text-[13px]">{w}</div>
        ))}

        {(busy || checking) && !a && <Splash busy />}
        {!a && !busy && !checking && (
          gated
            ? <Locked onSignIn={() => setPanel('auth')} />
            : <Splash cloud={cloud.enabled && cloud.signedIn} />
        )}

        {a && ctx && (
          <div style={{ opacity: busy ? 0.55 : 1, transition: 'opacity .15s' }}>
            {tab === 'overview' && <Overview ctx={ctx} />}
            {tab === 'corners' && <Corners ctx={ctx} />}
            {tab === 'traces' && <Traces ctx={ctx} />}
            {tab === 'consistency' && <Consistency ctx={ctx} />}
            {tab === 'replay' && <Replay ctx={ctx} />}
            {tab === 'findings' && <Findings ctx={ctx} />}
          </div>
        )}
      </main>

      {/* Вышли из аккаунта — библиотеку показывать нечем, возвращаем окно входа. */}
      {panel !== 'none' && (!cloud.signedIn || !cloud.team)
        ? <Auth cloud={cloud} onClose={() => setPanel('none')} />
        : panel === 'library' && (
          <Library cloud={cloud} max={MAX} picked={sources.filter(s => s.row).map(s => s.row!.id)}
            onPick={openFromLibrary} onClose={() => setPanel('none')} />
        )}

      {drag && !gated && (
        <div className="fixed inset-0 z-50 bg-[#0a0c10]/85 flex items-center justify-center pointer-events-none">
          <div className="text-lg text-[var(--muted)]">Отпустите файлы</div>
        </div>
      )}
    </div>
  );
}

/** Гостевой экран: без входа приложение ничего не разбирает. */
function Locked({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-28 text-center">
      <div className="text-[15px] mb-2">Нужен вход</div>
      <div className="text-[var(--muted)] text-[13px] max-w-md leading-relaxed mb-4">
        Телеметрия команды хранится в библиотеке заездов. Войдите, чтобы открыть
        уже загруженные заезды или добавить новые.
      </div>
      <button onClick={onSignIn}
        className="px-4 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--line)]
          text-[13px] hover:bg-[#1d222d] transition">
        Войти
      </button>
    </div>
  );
}

function Splash({ busy, cloud }: { busy?: boolean; cloud?: boolean }) {
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
            Один файл — анализ заезда, несколько — сравнение пилотов; заезды можно докидывать по одному.
            Трасса и повороты определяются из логов сами, а имена пилотов
            вписываются в шапке и запоминаются на будущее.
            {cloud && (
              <span className="block mt-2">
                Файл с диска разбирается разово и в библиотеку не попадает.
                Чтобы заезд сохранился, грузите его через «Библиотеку» — там же
                открываются все прежние.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
