import { analyzeSessions } from './core/pipeline';
import { parseAimCsv } from './core/parse';
import { unpackSession } from './core/pack';

/** Источник заезда: либо CSV с диска, либо распакованные байты из хранилища. */
export interface WorkerSource {
  name: string;
  /** Имя привязанного пилота, если заезд открыт из библиотеки. */
  displayName?: string;
  csv?: string;
  packed?: Uint8Array;
}

interface Req {
  sources: WorkerSource[];
  excluded?: Record<string, number[]>;
}

self.onmessage = (e: MessageEvent<Req>) => {
  try {
    const sessions = e.data.sources.map(s => {
      const parsed = s.csv != null ? parseAimCsv(s.csv, s.name) : unpackSession(s.packed!);
      parsed.sourceName = s.name;
      parsed.displayName = s.displayName;
      return parsed;
    });
    self.postMessage({ ok: true, result: analyzeSessions(sessions, e.data.excluded) });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
