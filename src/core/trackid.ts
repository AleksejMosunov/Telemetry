/**
 * Опознание трассы по форме траектории.
 *
 * Название площадки ничего не решает: у одной и той же трассы бывает несколько
 * конфигураций. Поэтому сравниваем сами линии. Делается в два шага: сперва
 * площадка по координатам, затем конфигурация по взаимному покрытию осевых.
 */
import type { Centerline } from './track';

/** Шаг прореживания осевой для отпечатка, м. */
const STEP = 5;
/** Насколько близко должны лежать линии, чтобы считаться одной трассой, м.
 *  На реальных данных две сессии одной трассы расходятся максимум на 2.5 м —
 *  запас втрое. Ширина картинговой трассы около 8 м, поэтому расхождение больше
 *  этого уже не объяснить выбором траектории. */
const TOL = 8;

export interface TrackSignature {
  /** средняя точка трассы, градусы — по ней опознаётся площадка */
  lat: number; lon: number;
  /** длина круга, м */
  length: number;
  /** осевая: метры от собственной средней точки, [x0,y0,x1,y1,...] */
  outline: number[];
}

export function trackSignature(cl: Centerline): TrackSignature {
  let sx = 0, sy = 0;
  for (let i = 0; i < cl.n; i++) { sx += cl.x[i]; sy += cl.y[i]; }
  const cx = sx / cl.n, cy = sy / cl.n;

  const outline: number[] = [];
  for (let s = 0; s < cl.n; s += Math.max(1, Math.round(STEP / cl.step))) {
    outline.push(+(cl.x[s] - cx).toFixed(2), +(cl.y[s] - cy).toFixed(2));
  }
  return {
    // проекция локальная и плоская, поэтому обратный ход — простое деление
    lat: cl.proj.lat0 + cy / cl.proj.mPerLat,
    lon: cl.proj.lon0 + cx / cl.proj.mPerLon,
    length: +cl.length.toFixed(2),
    outline,
  };
}

export interface TrackMatch {
  /** расстояние между центрами трасс, км */
  km: number;
  /** та же площадка */
  sameVenue: boolean;
  /** доля круга, где линии сходятся ближе TOL */
  cover: number;
  /** расхождение линий по 98-му процентилю, м — основной признак */
  spread: number;
  /** относительная разница длин круга */
  lengthDiff: number;
  /** едут в одну сторону */
  sameDirection: boolean;
  /** та же конфигурация трассы */
  sameConfig: boolean;
}

/** Число точек, к которому приводятся обе линии перед сравнением. */
const M = 256;

/** Линия -> M точек, равномерно по доле круга. */
function resample(outline: number[]): Float64Array {
  const n = outline.length / 2;
  const out = new Float64Array(M * 2);
  for (let k = 0; k < M; k++) {
    const t = (k * n) / M;
    const i = Math.floor(t) % n, j = (i + 1) % n, f = t - Math.floor(t);
    out[k * 2] = outline[i * 2] + (outline[j * 2] - outline[i * 2]) * f;
    out[k * 2 + 1] = outline[i * 2 + 1] + (outline[j * 2 + 1] - outline[i * 2 + 1]) * f;
  }
  return out;
}

const pct = (d: number[], q: number) => {
  const v = [...d].sort((x, y) => x - y);
  return v[Math.min(v.length - 1, Math.floor(v.length * q))];
};

/**
 * Сравнение линий по порядку обхода, а не «каждая точка ищет ближайшую».
 *
 * Свободный поиск ближайшей точки на петляющей трассе обманывается: участок,
 * уведённый в сторону на два десятка метров, находит рядом соседнюю прямую
 * и считается совпавшим. Здесь точка k линии A сопоставляется точке k+r линии B,
 * то есть топология обхода обязана совпасть. Сдвиг r подбирается — линия
 * старта у разных конфигураций своя.
 */
function bestAlignment(A: Float64Array, B: Float64Array) {
  let best = { dist: [] as number[], rms: Infinity, dir: 1 };
  for (const dir of [1, -1] as const) {
    for (let r = 0; r < M; r++) {
      let sum = 0;
      const d: number[] = new Array(M);
      for (let k = 0; k < M; k++) {
        const j = dir === 1 ? (k + r) % M : ((r - k) % M + M) % M;
        const dx = A[k * 2] - B[j * 2], dy = A[k * 2 + 1] - B[j * 2 + 1];
        d[k] = Math.hypot(dx, dy);
        sum += d[k] * d[k];
      }
      const rms = Math.sqrt(sum / M);
      if (rms < best.rms) best = { dist: d, rms, dir };
    }
  }
  return best;
}

export function matchTracks(a: TrackSignature, b: TrackSignature): TrackMatch {
  const km = Math.hypot(
    (a.lat - b.lat) * 111,
    (a.lon - b.lon) * 111 * Math.cos((a.lat * Math.PI) / 180),
  );
  // Линии уже приведены к собственным центрам — этим снимается систематический
  // сдвиг GPS между днями, а он доходит до нескольких метров.
  const al = bestAlignment(resample(a.outline), resample(b.outline));

  const lengthDiff = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  // 98-й процентиль, а не максимум: одна кривая точка не должна решать всё.
  const spread = pct(al.dist, 0.98);

  return {
    km,
    sameVenue: km < 2,
    cover: al.dist.filter(v => v <= TOL).length / al.dist.length,
    spread,
    lengthDiff,
    sameDirection: al.dir === 1,
    sameConfig: km < 2 && al.dir === 1 && spread < TOL && lengthDiff < 0.02,
  };
}

/** Выбор конфигурации из известных: лучшая по совпадению или null, если новая. */
export function findConfig<T extends { signature: TrackSignature }>(
  sig: TrackSignature, known: T[],
): { config: T; match: TrackMatch } | null {
  let best: { config: T; match: TrackMatch } | null = null;
  for (const c of known) {
    const match = matchTracks(sig, c.signature);
    if (!match.sameConfig) continue;
    if (!best || match.spread < best.match.spread) best = { config: c, match };
  }
  return best;
}
