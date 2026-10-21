import type {Heightmap, Profile, normalizeImport} from './terrain.ts';

export type ImageIoStage = 'read' | 'inspect' | 'confirm-dimensions' | 'decode' | 'normalize' | 'encode-bmp' | 'encode-png' | 'complete';
export interface ImageIoProgress {stage: ImageIoStage; elapsedMs: number}
export interface ImageIoTiming {stage: ImageIoStage; ms: number}
/** Named array sizes are allocation estimates, not simultaneous live-memory or process peaks. */
export interface ImageIoArrayEstimate {name: string; bytes: number; note: string}
export interface ImageIoLimits {maxTiles: number; maxFileBytes: number}
export interface ImageIoMeasurements {timings: ImageIoTiming[]; arrays: ImageIoArrayEstimate[]}
export type ImageImportResult = ReturnType<typeof normalizeImport> & ImageIoMeasurements;
export type ImageExportResult = {bytes: Uint8Array} & ImageIoMeasurements;
export type ImageIoRequest =
  | {kind: 'start'; id: number; operation: 'import'; file: File; profile: Profile; limits: ImageIoLimits}
  | {kind: 'start'; id: number; operation: 'export'; map: Heightmap; profile: Profile; format: 'bmp' | 'png'; limits: ImageIoLimits};
export type ImageIoMessage = ImageIoRequest | {kind: 'dimensions-accepted'; id: number};
export type ImageIoResponse =
  | {kind: 'progress'; id: number; progress: ImageIoProgress}
  | {kind: 'dimensions'; id: number; width: number; height: number}
  | {kind: 'result'; id: number; operation: 'import'; result: ImageImportResult}
  | {kind: 'result'; id: number; operation: 'export'; result: ImageExportResult}
  | {kind: 'error'; id: number; error: {name: string; message: string}};
