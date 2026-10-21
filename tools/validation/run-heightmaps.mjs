import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(!process.env.SIMUTRANS_SOURCE)throw new Error('Set SIMUTRANS_SOURCE to the compatible checkout before native validation. Ordinary npm test/build do not require Simutrans.');
const shell=process.env.POWERSHELL||(process.platform==='win32'?'powershell.exe':'pwsh');
for(const [exe,args] of [[shell,['-NoProfile','-File',resolve(root,'tools/validation/build-probe.ps1')]],[process.execPath,[resolve(root,'tools/validation/verify-heightmaps.mjs')]]]){
 const result=spawnSync(exe,args,{cwd:root,env:process.env,stdio:'inherit',windowsHide:true});
 if(result.error)throw new Error(`Could not run ${exe}: ${result.error.message}. Install PowerShell 7 (pwsh) on non-Windows hosts, or set POWERSHELL.`);
 if(result.status!==0)process.exit(result.status??1);
}
