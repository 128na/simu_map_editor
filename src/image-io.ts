import type {Heightmap, Profile} from './terrain.ts';
import type {ImageExportResult, ImageImportResult, ImageIoLimits, ImageIoProgress, ImageIoRequest, ImageIoResponse} from './image-io-protocol.ts';

export type {ImageIoLimits, ImageIoProgress, ImageIoStage, ImageIoTiming, ImageIoArrayEstimate} from './image-io-protocol.ts';
export type ImageIoImportOutput = ImageImportResult & {totalMs: number};
export type ImageIoExportOutput = ImageExportResult & {totalMs: number};
export interface ImageIoHooks {
  signal?: AbortSignal;
  onProgress?: (progress: ImageIoProgress) => void;
  onDimensions?: (width: number, height: number) => boolean | Promise<boolean>;
}
interface ClientOptions {workerFactory?: () => Worker; timeoutMs?: number}
const cancelled = () => new DOMException('画像処理を取り消しました', 'AbortError');

/** One replaceable image operation. Cancellation terminates CPU work, not just its result callback. */
export class ImageIoClient {
  private serial = 0;
  private active: {cancel: () => void} | undefined;
  private readonly workerFactory: () => Worker;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? (() => new Worker(new URL('./image-io-worker.ts', import.meta.url), {type: 'module'}));
    this.timeoutMs = options.timeoutMs ?? 120000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid image operation timeout');
  }

  import(file: File, profile: Profile, limits: ImageIoLimits, hooks: ImageIoHooks = {}): Promise<ImageIoImportOutput> {
    return this.run({kind: 'start', id: ++this.serial, operation: 'import', file, profile: {...profile}, limits: {...limits}}, hooks);
  }

  export(map: Heightmap, profile: Profile, format: 'bmp' | 'png', limits: ImageIoLimits, hooks: ImageIoHooks = {}): Promise<ImageIoExportOutput> {
    return this.run({kind: 'start', id: ++this.serial, operation: 'export', map, profile: {...profile}, format, limits: {...limits}}, hooks);
  }

  cancel(): void { this.active?.cancel(); }
  dispose(): void { this.cancel(); }

  private run<T extends ImageIoImportOutput | ImageIoExportOutput>(request: ImageIoRequest, hooks: ImageIoHooks): Promise<T> {
    this.cancel();
    return new Promise<T>((resolve, reject) => {
      if (hooks.signal?.aborted) { reject(cancelled()); return; }
      const started = performance.now();
      let worker: Worker;
      try { worker = this.workerFactory(); } catch (error) { reject(error); return; }
      let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
      const operation = {cancel: () => fail(cancelled())};
      const cleanup = () => {
        clearTimer();
        worker.removeEventListener('message', message);
        worker.removeEventListener('error', error);
        worker.removeEventListener('messageerror', messageError);
        hooks.signal?.removeEventListener('abort', operation.cancel);
        worker.terminate();
        if (this.active === operation) this.active = undefined;
      };
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true; cleanup(); reject(reason instanceof Error || reason instanceof DOMException ? reason : new Error(String(reason)));
      };
      const startTimer = () => {
        clearTimer(); timer = setTimeout(() => fail(new Error('画像処理がタイムアウトしました')), this.timeoutMs);
      };
      const message = (event: MessageEvent<ImageIoResponse>) => {
        const data = event.data;
        if (settled || this.active !== operation || data.id !== request.id) return;
        try {
          if (data.kind === 'progress') { hooks.onProgress?.(data.progress); return; }
          if (data.kind === 'dimensions') {
            // User confirmation may remain open indefinitely; only active processing has a deadline.
            clearTimer();
            void Promise.resolve().then(() => hooks.onDimensions?.(data.width, data.height) ?? true).then(accepted => {
              if (settled || this.active !== operation) return;
              if (!accepted) { fail(cancelled()); return; }
              startTimer(); worker.postMessage({kind: 'dimensions-accepted', id: request.id});
            }).catch(fail);
            return;
          }
          if (data.kind === 'error') { const reason = new Error(data.error.message); reason.name = data.error.name; fail(reason); return; }
          if (data.kind === 'result') {
            if (data.operation !== request.operation) { fail(new Error('Invalid image operation response')); return; }
            settled = true; cleanup(); resolve({...data.result, totalMs: performance.now() - started} as T);
          }
        } catch (reason) { fail(reason); }
      };
      const error = (event: ErrorEvent) => { event.preventDefault(); fail(new Error(event.message || '画像処理Workerを起動できませんでした')); };
      const messageError = () => fail(new Error('画像処理Workerの応答を読み取れませんでした'));
      this.active = operation;
      worker.addEventListener('message', message);
      worker.addEventListener('error', error);
      worker.addEventListener('messageerror', messageError);
      hooks.signal?.addEventListener('abort', operation.cancel, {once: true});
      startTimer();
      // No transfer list: source heights remain owned by the editor even on failure/cancel.
      try { worker.postMessage(request); } catch (reason) { fail(reason); }
    });
  }
}
