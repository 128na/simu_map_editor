import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Keep this target identical to the compatibility profile and native build script.
export const NATIVE_SOURCE_COMMIT='af90444e46dfd422bfdf80518aaa568659ec6b00';
export function nativeProbeConfig(options={}){
 const env=options.env??process.env,platform=options.platform??process.platform;
 const root=options.root??resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const output=join(root,'.validation');
 const compilerBin=env.SIMUTRANS_COMPILER_BIN||(env.SIMUTRANS_COMPILER&&/[\\/]/.test(env.SIMUTRANS_COMPILER)?dirname(resolve(env.SIMUTRANS_COMPILER)):undefined);
 const source=env.SIMUTRANS_SOURCE?resolve(env.SIMUTRANS_SOURCE):undefined;
 const executable=env.SIMUTRANS_PROBE?resolve(env.SIMUTRANS_PROBE):join(output,platform==='win32'?'simutrans-probe.exe':'simutrans-probe');
 return {root,output,source,compilerBin,executable,env:nativeEnvironment(env,compilerBin,platform)};
}
export function nativeEnvironment(env,compilerBin,platform=process.platform){
 const key=Object.keys(env).find(k=>k.toLowerCase()==='path'),path=key?env[key]:'';
 const result=Object.fromEntries(Object.entries(env).filter(([k])=>k.toLowerCase()!=='path'));
 result.PATH=compilerBin?compilerBin+(platform==='win32'?';':':')+(path??''):(path??'');
 return result;
}
export function verifyNativeBuild(config){
 if(!config.source)throw new Error('Native validation requires SIMUTRANS_SOURCE (or an explicit source argument). Frontend build and ordinary browser tests do not require it.');
 const git=(args)=>{const r=spawnSync('git',['-C',config.source,...args],{env:config.env,encoding:'utf8',timeout:30000,windowsHide:true});if(r.error)throw r.error;assert.equal(r.status,0,`Source validation failed: ${r.stderr}`);return r.stdout;};
 assert.equal(git(['rev-parse','HEAD']).trim(),NATIVE_SOURCE_COMMIT,'Unexpected Simutrans source revision');
 git(['diff','--exit-code','HEAD','--','src/simutrans']);
 return verifyNativeManifest(config);
}
export function verifyNativeManifest(config){
 const build=JSON.parse(readFileSync(join(config.output,'probe-build.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(build.sourceCommit,NATIVE_SOURCE_COMMIT,'Unexpected native build revision');
 for(const [path,key] of [[config.executable,'executableSha256'],[join(config.root,'tools/validation/simutrans-probe.cc'),'probeSha256'],[join(config.root,'tools/validation/build-probe.ps1'),'buildScriptSha256']])assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),build[key],`Stale native build: ${path}; rebuild with npm run validate:heightmaps`);
 return build;
}
