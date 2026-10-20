import { validateDimensions, type Heightmap } from './terrain.ts';

export interface HistoryStore {
  put(key: string, buffer: ArrayBuffer): Promise<void>;
  get(key: string): Promise<ArrayBuffer | undefined>;
  delete(keys: string[]): Promise<void>;
  dispose(): Promise<void>;
}
export interface HistoryPatch { width: number; height: number; indices: Uint32Array; before: Float32Array; after: Float32Array; byteLength: number }
const HEADER = 20, MAGIC = 0x48535431;
function validatePatch(p: HistoryPatch): void {
  validateDimensions(p.width, p.height);
  if (!p.indices.length || p.indices.length !== p.before.length || p.indices.length !== p.after.length || p.byteLength !== HEADER + p.indices.length * 12) throw new Error('Invalid history patch');
  let previous = -1;
  for (let n = 0; n < p.indices.length; n++) {
    if (p.indices[n] <= previous || p.indices[n] >= p.width * p.height || !Number.isFinite(p.before[n]) || !Number.isFinite(p.after[n]) || p.before[n] === p.after[n]) throw new Error('Invalid history patch');
    previous = p.indices[n];
  }
}
export function createPatch(before: Heightmap, after: Heightmap, indices?: Iterable<number>): HistoryPatch | null {
  validateDimensions(before.width, before.height);
  if (before.width !== after.width || before.height !== after.height || before.heights.length !== before.width * before.height || after.heights.length !== before.heights.length) throw new Error('History dimensions differ');
  const selected: number[] = [];
  const add = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= before.heights.length) throw new Error('Invalid history index');
    if (!Number.isFinite(before.heights[i]) || !Number.isFinite(after.heights[i])) throw new Error('Invalid history height');
    if (before.heights[i] !== after.heights[i]) selected.push(i);
  };
  if (indices) for (const i of new Set(indices)) add(i);
  else for (let i = 0; i < before.heights.length; i++) add(i);
  if (!selected.length) return null;
  selected.sort((a, b) => a - b);
  return { width: before.width, height: before.height, indices: Uint32Array.from(selected), before: Float32Array.from(selected, i => before.heights[i]), after: Float32Array.from(selected, i => after.heights[i]), byteLength: HEADER + selected.length * 12 };
}
function encode(p: HistoryPatch): ArrayBuffer {
  validatePatch(p);
  const buffer = new ArrayBuffer(p.byteLength), view = new DataView(buffer);
  [MAGIC, 1, p.width, p.height, p.indices.length].forEach((v, i) => view.setUint32(i * 4, v, true));
  for (let i = 0; i < p.indices.length; i++) {
    const at = HEADER + i * 12;
    view.setUint32(at, p.indices[i], true); view.setFloat32(at + 4, p.before[i], true); view.setFloat32(at + 8, p.after[i], true);
  }
  return buffer;
}
function decode(buffer: ArrayBuffer): HistoryPatch {
  if (buffer.byteLength < HEADER) throw new Error('Invalid history record');
  const v = new DataView(buffer), count = v.getUint32(16, true);
  if (v.getUint32(0, true) !== MAGIC || v.getUint32(4, true) !== 1 || count * 12 + HEADER !== buffer.byteLength) throw new Error('Invalid history record');
  const p: HistoryPatch = {width: v.getUint32(8, true), height: v.getUint32(12, true), indices: new Uint32Array(count), before: new Float32Array(count), after: new Float32Array(count), byteLength: buffer.byteLength};
  for (let i = 0; i < count; i++) { const at = HEADER + i * 12; p.indices[i] = v.getUint32(at, true); p.before[i] = v.getFloat32(at + 4, true); p.after[i] = v.getFloat32(at + 8, true); }
  validatePatch(p); return p;
}
interface Entry { key: string; bytes: number; hot?: ArrayBuffer; stored: boolean; active: boolean; generation: number }
export class HistoryBudgetError extends Error {
  readonly reason: 'ram' | 'disk' | 'entries';
  readonly requiredBytes: number;
  constructor(reason: 'ram' | 'disk' | 'entries', requiredBytes: number) {
    super('History budget exceeded; wait or explicitly discard history'); this.name = 'HistoryBudgetError'; this.reason = reason; this.requiredBytes = requiredBytes;
  }
}
export interface HistoryState { undoCount: number; redoCount: number; queuedBytes: number; storedBytes: number; failed: boolean; reading: boolean }
export interface HistoryOptions { ramBudgetBytes?: number; diskBudgetBytes?: number; maxEntries?: number; onChange?: () => void; onError?: (error: Error) => void }
export class AsyncHistory {
  private entries: Entry[] = [];
  private pending = new Set<Entry>();
  private cursor = 0;
  private generation = 0;
  private serial = 0;
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  private reading = false;
  private disposed = false;
  private options: Required<Pick<HistoryOptions, 'ramBudgetBytes' | 'diskBudgetBytes' | 'maxEntries'>> & HistoryOptions;
  private store: HistoryStore;
  constructor(store: HistoryStore, options: HistoryOptions = {}) {
    this.store = store;
    this.options = { ramBudgetBytes: 64 * 1024 ** 2, diskBudgetBytes: 512 * 1024 ** 2, maxEntries: 1000, ...options };
    for (const value of [this.options.ramBudgetBytes, this.options.diskBudgetBytes, this.options.maxEntries]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid history budget');
  }
  getState(): HistoryState {
    return { undoCount: this.cursor, redoCount: this.entries.length - this.cursor, queuedBytes: [...this.pending].reduce((s, e) => s + (e.hot?.byteLength ?? 0), 0), storedBytes: this.entries.reduce((s, e) => s + (e.stored ? e.bytes : 0), 0), failed: this.failed, reading: this.reading };
  }
  private notify(): void { this.options.onChange?.(); }
  private error(error: unknown): void { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }
  private async cleanup(entries: Entry[]): Promise<void> {
    try { if (entries.length) await this.store.delete(entries.map(e => e.key)); }
    catch (error) { if (entries.some(e => e.generation === this.generation)) { this.failed = true; this.error(error); } }
    finally { for (const e of entries) { e.hot = undefined; this.pending.delete(e); } this.notify(); }
  }
  private assertIdle(): void { if (this.disposed || this.reading) throw new Error('History is busy or closed'); }
  private enqueue(task: () => Promise<void>): void { this.queue = this.queue.then(task).catch(error => this.error(error)); }
  record(patch: HistoryPatch): void {
    this.assertIdle(); if (this.failed) throw new Error('History storage failed; keep or discard history before continuing');
    validatePatch(patch);
    const retained = this.entries.slice(0, this.cursor), state = this.getState();
    if (state.queuedBytes + patch.byteLength > this.options.ramBudgetBytes) throw new HistoryBudgetError('ram', patch.byteLength);
    if (retained.reduce((s, e) => s + e.bytes, 0) + patch.byteLength > this.options.diskBudgetBytes) throw new HistoryBudgetError('disk', patch.byteLength);
    if (retained.length + 1 > this.options.maxEntries) throw new HistoryBudgetError('entries', patch.byteLength);
    const buffer = encode(patch);
    const removed = this.entries.slice(this.cursor); removed.forEach(e => { e.active = false; });
    this.entries = retained;
    const entry: Entry = { key: `${this.generation}-${++this.serial}`, bytes: buffer.byteLength, hot: buffer, stored: false, active: true, generation: this.generation };
    this.entries.push(entry); this.cursor++; this.pending.add(entry);
    if (removed.length) this.enqueue(() => this.cleanup(removed));
    this.enqueue(async () => {
      if (!entry.active || entry.generation !== this.generation) { entry.hot = undefined; this.pending.delete(entry); this.notify(); return; }
      if (this.failed) return;
      try {
        await this.store.put(entry.key, buffer);
        if (!entry.active || entry.generation !== this.generation) { await this.cleanup([entry]); return; }
        entry.stored = true; entry.hot = undefined; this.pending.delete(entry);
      } catch (error) { if (entry.active && entry.generation === this.generation) { this.failed = true; this.error(error); } else { entry.hot = undefined; this.pending.delete(entry); } }
      this.notify();
    });
    this.notify();
  }
  private async move(current: Heightmap, apply: (next: Heightmap) => void, redo: boolean): Promise<boolean> {
    this.assertIdle();
    const entry = this.entries[redo ? this.cursor : this.cursor - 1];
    if (!entry) return false;
    this.reading = true; this.notify();
    try {
      const buffer = entry.hot ?? await this.store.get(entry.key);
      if (!buffer) throw new Error('History record is missing');
      const patch = decode(buffer);
      if (patch.width !== current.width || patch.height !== current.height || current.heights.length !== patch.width * patch.height) throw new Error('History map dimensions differ');
      const heights = current.heights.slice(), source = redo ? patch.before : patch.after, target = redo ? patch.after : patch.before;
      for (let i = 0; i < patch.indices.length; i++) { const at = patch.indices[i]; if (heights[at] !== source[i]) throw new Error('History does not match current terrain'); heights[at] = target[i]; }
      apply({ width: current.width, height: current.height, heights });
      this.cursor += redo ? 1 : -1; return true;
    } finally { this.reading = false; this.notify(); }
  }
  undo(current: Heightmap, apply: (next: Heightmap) => void): Promise<boolean> { return this.move(current, apply, false); }
  redo(current: Heightmap, apply: (next: Heightmap) => void): Promise<boolean> { return this.move(current, apply, true); }
  reset(): void {
    this.assertIdle(); const old = this.entries; old.forEach(e => { e.active = false; });
    this.entries = []; this.cursor = 0; this.generation++; this.failed = false;
    this.enqueue(() => this.cleanup(old)); this.notify();
  }
  async settled(): Promise<void> { let pending: Promise<void>; do { pending = this.queue; await pending; } while (pending !== this.queue); }
  async dispose(): Promise<void> { this.assertIdle(); this.reset(); this.disposed = true; await this.settled(); await this.store.dispose(); }
}







