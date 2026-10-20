import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const config=JSON.parse(readFileSync(new URL('./performance-issue.json',import.meta.url),'utf8'));
const median=values=>{if(!values.length||values.some(n=>!Number.isFinite(n)||n<0))throw new Error('Invalid performance samples');const a=[...values].sort((a,b)=>a-b),m=a.length>>1;return a.length%2?a[m]:(a[m-1]+a[m])/2;};
export function rows(report){
 if(report.schemaVersion!==1||!['cpu','browser'].includes(report.kind))throw new Error('Unsupported report schema');
 return report.results.flatMap(r=>report.kind==='cpu'?r.samples.map(s=>({size:s.size,operation:s.tool,medianMs:median(s.ms),samples:s.ms.length})): [
  ...Object.entries(r.strokes).map(([operation,values])=>({size:r.size,operation,medianMs:median(values.map(v=>v.ms)),samples:values.length})),
  ...['create','undo','redo','drag','rotate'].map(operation=>({size:r.size,operation,medianMs:median([r[operation+'Ms']]),samples:1})),
  {size:r.size,operation:'frameInterval',medianMs:median(r.frameIntervals),samples:r.frameIntervals.length}
 ]);
}
export function makeReport(kind,results){
 if(!results.length)throw new Error('No measurement data');
 const metadata=results[0].metadata;
 if(!metadata?.runId||!metadata?.runAttempt||!metadata?.revision||!metadata?.benchmarkVersion)throw new Error('Missing CI measurement identity');
 for(const r of results)if(JSON.stringify(r.metadata)!==JSON.stringify(metadata)){
  // Separate sizes have different measurement timestamps, but must share the run and version.
  for(const key of ['runId','runAttempt','revision','benchmarkVersion','repository'])if(r.metadata?.[key]!==metadata[key])throw new Error('Mixed measurement runs');
 }
 const report={schemaVersion:1,kind,metadata,results};rows(report);return report;
}
export const marker=r=>`<!-- performance-history:v1:${r.kind}:${r.metadata.runId}:${r.metadata.runAttempt} -->`;
export function render(report){
 const m=report.metadata;
 const safe=s=>String(s??'').replace(/[\r\n|`<>]/g,' ');
 const table=rows(report).map(r=>`| ${r.size}² | ${safe(r.operation)} | ${r.medianMs.toFixed(2)} | ${r.samples} |`).join('\n');
 const raw=JSON.stringify(report,null,2).replaceAll('<','\\u003c');
 const body=`${marker(report)}
### ${report.kind} / ${safe(m.recordedAt)}

Commit: ${safe(m.revision)} · Run: ${safe(m.runUrl)} · Attempt: ${safe(m.runAttempt)}

Benchmark: ${safe(m.benchmarkVersion)}

Environment: ${safe(m.environment?.os)} / ${safe(m.environment?.cpu)} / Node ${safe(m.environment?.node)}

${report.kind==='browser'?`Browser: ${safe(report.results[0].browser)} ${safe(report.results[0].browserVersion)} / ${safe(report.results[0].metrics?.renderer)}`:'CPU-only measurement'}

| Size | Operation | Median (ms) | Samples |
| --- | --- | ---: | ---: |
${table}

UI timings include automated input and waits. Rendering environments must be compared separately.

<details><summary>Machine-readable JSON (permanent measurement record)</summary>

\`\`\`json
${raw}
\`\`\`

</details>
`;
 if(body.length>60000)throw new Error('Measurement comment exceeds safe GitHub size');return body;
}
export function parseComment(body){
 if(!body.startsWith('<!-- performance-history:v1:'))return null;
 const match=body.match(/```json\n([\s\S]*?)\n```/);if(!match)throw new Error('Missing measurement JSON');
 const r=JSON.parse(match[1]);rows(r);if(!body.startsWith(marker(r)))throw new Error('Measurement identity mismatch');return r;
}
const columns=['kind','benchmarkVersion','recordedAt','revision','runId','runAttempt','runUrl','size','operation','medianMs','samples','node','os','arch','cpu','browser','browserVersion','playwrightVersion','renderer','conditions','environment','commentUrl'];
export function toCsv(entries){
 const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
 const out=[columns.join(',')];
 for(const {report,commentUrl} of entries)for(const row of rows(report)){
  const m=report.metadata;const value={...m,...row,kind:report.kind,node:m.environment?.node,os:m.environment?.os,arch:m.environment?.arch,cpu:m.environment?.cpu,browser:report.results[0].browser,browserVersion:report.results[0].browserVersion,playwrightVersion:report.results[0].playwrightVersion,renderer:report.results[0].metrics?.renderer,conditions:JSON.stringify(report.results[0].conditions),environment:JSON.stringify({host:m.environment,browser:report.results[0].browser,browserVersion:report.results[0].browserVersion,playwrightVersion:report.results[0].playwrightVersion,renderer:report.results[0].metrics?.renderer}),commentUrl};
  out.push(columns.map(c=>quote(value[c])).join(','));
 }return out.join('\n')+'\n';
}
function api(args,input){return JSON.parse(execFileSync('gh',['api',...args],{encoding:'utf8',input:input?JSON.stringify(input):undefined,maxBuffer:64*1024*1024}));}
function comments(){return api([`repos/${config.repository}/issues/${config.issue}/comments`,'--paginate','--slurp']).flat().filter(c=>c.user?.login==='github-actions[bot]');}
export function validatePublication(report,env=process.env){
 const m=report.metadata,attempt=Number(m.runAttempt),current=Number(env.GITHUB_RUN_ATTEMPT);
 if(m.repository!==config.repository||String(m.runId)!==env.GITHUB_RUN_ID||m.revision!==env.GITHUB_SHA||!Number.isSafeInteger(attempt)||attempt<1||!Number.isSafeInteger(current)||attempt>current)throw new Error('Measurement does not belong to this workflow run');
 // A retry of only the publisher may reuse a successful earlier measurement attempt.
}
function main(){
 const [command,kind,...paths]=process.argv.slice(2);
 if(command==='publish'){
  if(process.env.GITHUB_REPOSITORY!==config.repository||process.env.GITHUB_REF!=='refs/heads/main'||!['push','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME))throw new Error('Issue publication is restricted to trusted main push/manual runs');
  const files=kind==='browser'?readdirSync(paths[0]).filter(n=>/^operations-.*\.json$/.test(n)).map(n=>resolve(paths[0],n)):paths;
  const report=makeReport(kind,files.map(p=>JSON.parse(readFileSync(p,'utf8'))));
  validatePublication(report);
  const body=render(report),existing=comments().find(c=>c.body.startsWith(marker(report)));
  if(existing){console.log(`Already recorded: ${existing.html_url}`);return;}
  console.log(api([`repos/${config.repository}/issues/${config.issue}/comments`,'--method','POST','--input','-'],{body}).html_url);
 }else if(command==='export'){
  const entries=[],seen=new Set();
  for(const c of comments()){
   const report=parseComment(c.body);if(!report)continue;
   if(seen.has(marker(report)))continue;seen.add(marker(report));entries.push({report,commentUrl:c.html_url});
  }
  const output=kind??'.validation/performance-history.csv';mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,toCsv(entries));console.log(`${entries.length} reports -> ${output}`);
 }else throw new Error('Usage: performance-history.mjs publish cpu FILE | publish browser DIR | export [CSV]');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
