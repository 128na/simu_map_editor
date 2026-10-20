import { execFileSync } from 'node:child_process';
import { cpus, platform, arch } from 'node:os';

/** Build the shared provenance envelope without affecting the timed workload. */
export function createPerformanceMetadata(benchmarkVersion) {
 let revision = process.env.GITHUB_SHA || null;
 if (!revision) {
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* A source archive may have no Git metadata. */ }
 }
 const repository = process.env.GITHUB_REPOSITORY || null;
 const runId = process.env.GITHUB_RUN_ID || null;
 return {
  schemaVersion: 1,
  benchmarkVersion,
  recordedAt: new Date().toISOString(),
  revision,
  repository,
  runId,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  runUrl: repository && runId ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repository}/actions/runs/${runId}` : null,
  workflow: process.env.GITHUB_WORKFLOW || null,
  environment: {
   node: process.version,
   os: platform(),
   arch: arch(),
   cpu: cpus()[0]?.model || null,
   runnerOS: process.env.RUNNER_OS || null,
   runnerName: process.env.RUNNER_NAME || null,
  },
 };
}
