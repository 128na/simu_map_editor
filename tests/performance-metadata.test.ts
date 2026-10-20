import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerformanceMetadata } from '../tools/validation/performance-metadata.mjs';

test('performance provenance records CI run identity and attempt', () => {
 const values = {GITHUB_SHA:'abc123',GITHUB_REPOSITORY:'owner/editor',GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'2',GITHUB_SERVER_URL:'https://github.example',GITHUB_WORKFLOW:'Performance',RUNNER_OS:'Linux',RUNNER_NAME:'runner-1'};
 const previous = Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
 try {
  Object.assign(process.env, values);
  const result = createPerformanceMetadata('cpu-v1');
  assert.equal(result.schemaVersion,1);
  assert.equal(result.benchmarkVersion,'cpu-v1');
  assert.equal(result.revision,'abc123');
  assert.equal(result.runAttempt,'2');
  assert.equal(result.runUrl,'https://github.example/owner/editor/actions/runs/42');
  assert.equal(result.workflow,'Performance');
  assert.equal(result.environment.runnerOS,'Linux');
  assert.equal(result.environment.runnerName,'runner-1');
  assert.equal(new Date(result.recordedAt).toISOString(),result.recordedAt);
 } finally {
  for(const [key,value] of Object.entries(previous)) {
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 }
});
