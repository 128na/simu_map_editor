/// <reference lib="webworker" />
import {decodeHeightmap, exportBmp, exportPng} from './codecs.ts';
import {LIMITS, normalizeImport} from './terrain.ts';
import type {ImageIoArrayEstimate, ImageIoMessage, ImageIoRequest, ImageIoResponse, ImageIoStage, ImageIoTiming} from './image-io-protocol.ts';

const context = self as unknown as DedicatedWorkerGlobalScope;
let acceptDimensions: (() => void) | undefined;
let activeId: number | undefined;
class DimensionsFound extends Error {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) { super('dimensions'); this.width = width; this.height = height; }
}
const send = (message: ImageIoResponse, transfer: Transferable[] = []) => context.postMessage(message, transfer);

async function execute(request: ImageIoRequest): Promise<void> {
  const id = request.id, started = performance.now(), timings: ImageIoTiming[] = [], arrays: ImageIoArrayEstimate[] = [];
  if (!Number.isSafeInteger(request.limits.maxTiles) || request.limits.maxTiles < 1 || !Number.isSafeInteger(request.limits.maxFileBytes) || request.limits.maxFileBytes < 1) throw new Error('Invalid image resource limits');
  LIMITS.maxTiles = request.limits.maxTiles; LIMITS.maxFileBytes = request.limits.maxFileBytes;
  const progress = (stage: ImageIoStage) => send({kind: 'progress', id, progress: {stage, elapsedMs: performance.now() - started}});
  const measure = async <T>(stage: ImageIoStage, action: () => T | Promise<T>): Promise<T> => {
    progress(stage); const begin = performance.now();
    try { return await action(); } finally { timings.push({stage, ms: performance.now() - begin}); }
  };
  if (request.operation === 'import') {
    if (request.file.size > LIMITS.maxFileBytes) throw new Error(`画像ファイルは${LIMITS.maxFileBytes / 1048576} MiB以下にしてください`);
    const bytes = await measure('read', async () => new Uint8Array(await request.file.arrayBuffer()));
    arrays.push({name: 'input-file', bytes: bytes.byteLength, note: 'Worker input bytes; file storage and decoder internals excluded'});
    const dimensions = await measure('inspect', async () => {
      try { await decodeHeightmap(bytes, request.profile, (width, height) => { throw new DimensionsFound(width, height); }); }
      catch (error) { if (error instanceof DimensionsFound) return error; throw error; }
      throw new Error('画像寸法を確認できませんでした');
    });
    progress('confirm-dimensions');
    await new Promise<void>(resolve => { acceptDimensions = resolve; send({kind: 'dimensions', id, width: dimensions.width, height: dimensions.height}); });
    acceptDimensions = undefined;
    const pixels = dimensions.width * dimensions.height;
    arrays.push(
      {name: 'decoded-samples', bytes: pixels, note: 'One grayscale decoder sample array; PNG filtered rows, channels and compressed copies are additional'},
      {name: 'decoded-heights', bytes: pixels * 4, note: 'Float32 source heights returned by decoder'},
      {name: 'normalized-heights', bytes: pixels * 4, note: 'Normalized Float32 output transferred to main thread'},
      {name: 'normalization-samples', bytes: pixels * 2, note: 'Two grayscale sample allocations across quantization report and normalization; not a simultaneous peak'},
    );
    const decoded = await measure('decode', () => decodeHeightmap(bytes, request.profile));
    const normalized = await measure('normalize', () => normalizeImport(decoded, request.profile));
    progress('complete');
    send({kind: 'result', id, operation: 'import', result: {...normalized, timings, arrays}}, [normalized.map.heights.buffer as ArrayBuffer]);
  } else {
    const pixels = request.map.width * request.map.height;
    arrays.push(
      {name: 'cloned-source-heights', bytes: request.map.heights.byteLength, note: 'Structured-clone copy in Worker; editor source remains attached'},
      {name: 'encoded-samples', bytes: pixels, note: 'Grayscale encoder samples'},
      {name: 'output-rows', bytes: request.format === 'png' ? (request.map.width + 1) * request.map.height : 54 + Math.ceil(request.map.width * 3 / 4) * 4 * request.map.height, note: 'PNG filtered rows or BMP output; compression/chunk copies are additional'},
    );
    const bytes = await measure(request.format === 'png' ? 'encode-png' : 'encode-bmp', () => request.format === 'png' ? exportPng(request.map, request.profile) : exportBmp(request.map, request.profile));
    arrays.push({name: 'output-file', bytes: bytes.byteLength, note: 'Encoded result transferred to main thread; for BMP aliases output-rows (do not sum twice); Blob/download copies are additional'});
    progress('complete');
    send({kind: 'result', id, operation: 'export', result: {bytes, timings, arrays}}, [bytes.buffer as ArrayBuffer]);
  }
}

context.onmessage = ({data}: MessageEvent<ImageIoMessage>) => {
  if (data.kind === 'dimensions-accepted') { if (data.id === activeId) acceptDimensions?.(); return; }
  if (activeId !== undefined) return;
  activeId = data.id;
  void execute(data).catch(error => {
    const reason = error instanceof Error ? error : new Error(String(error));
    send({kind: 'error', id: data.id, error: {name: reason.name, message: reason.message}});
  });
};
