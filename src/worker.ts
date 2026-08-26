import { analyze } from './core/pipeline';

interface Req {
  files: { name: string; text: string }[];
  excluded?: Record<string, number[]>;
}

self.onmessage = (e: MessageEvent<Req>) => {
  try {
    self.postMessage({ ok: true, result: analyze(e.data.files, e.data.excluded) });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
