/** Сжатие через стандартные веб-потоки: работает и в браузере, и в Node 18+. */

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const src = new Blob([data as BlobPart]).stream();
  const buf = await new Response(src.pipeThrough(stream as ReadableWritablePair)).arrayBuffer();
  return new Uint8Array(buf);
}

export const gzip = (data: Uint8Array) => through(data, new CompressionStream('gzip'));
export const gunzip = (data: Uint8Array) => through(data, new DecompressionStream('gzip'));
