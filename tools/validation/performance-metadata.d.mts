export interface PerformanceMetadata {
 schemaVersion: 1;
 benchmarkVersion: string;
 recordedAt: string;
 revision: string | null;
 repository: string | null;
 runId: string | null;
 runAttempt: string | null;
 runUrl: string | null;
 workflow: string | null;
 environment: { node: string; os: string; arch: string; cpu: string | null; runnerOS: string | null; runnerName: string | null };
}
export function createPerformanceMetadata(benchmarkVersion: string): PerformanceMetadata;
