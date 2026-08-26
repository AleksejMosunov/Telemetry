import { analyze } from './core/pipeline';

self.onmessage = (e: MessageEvent<{ files: { name: string; text: string }[] }>) => {
  try {
    self.postMessage({ ok: true, result: analyze(e.data.files) });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
