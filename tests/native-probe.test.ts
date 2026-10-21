import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {nativeEnvironment,nativeProbeConfig,verifyNativeBuild,verifyNativeManifest,NATIVE_SOURCE_COMMIT} from '../tools/validation/native-probe.mjs';

test('native paths use explicit source and platform executable names, not developer drives',()=>{
 const root=resolve('sample workspace');
 const linux=nativeProbeConfig({root,env:{PATH:'system-bin'},platform:'linux'}),windows=nativeProbeConfig({root,env:{Path:'system-bin',SIMUTRANS_COMPILER_BIN:'compiler-bin'},platform:'win32'});
 assert.equal(linux.source,undefined);assert.equal(linux.executable,join(root,'.validation','simutrans-probe'));assert.equal(windows.executable,join(root,'.validation','simutrans-probe.exe'));
 assert.equal(windows.env.PATH,'compiler-bin;system-bin');assert.equal(windows.env.Path,undefined);
 assert.equal(nativeEnvironment({PATH:'system-bin'},'compiler-bin','linux').PATH,'compiler-bin:system-bin');
 assert.throws(()=>verifyNativeBuild(linux),/SIMUTRANS_SOURCE/);
 const configured=nativeProbeConfig({root,env:{SIMUTRANS_SOURCE:'source folder',SIMUTRANS_PROBE:'probe folder/probe'},platform:'linux'});assert.equal(configured.source,resolve('source folder'));assert.equal(configured.executable,resolve('probe folder/probe'));
});

test('native manifests reject stale binary, harness, build script and target revision',()=>{
 const root=mkdtempSync(join(tmpdir(),'simu-native-test-')),output=join(root,'.validation'),tools=join(root,'tools','validation');mkdirSync(output,{recursive:true});mkdirSync(tools,{recursive:true});
 const executable=join(output,'probe'),probe=join(tools,'simutrans-probe.cc'),script=join(tools,'build-probe.ps1');
 const paths=[executable,probe,script];const keys=['executableSha256','probeSha256','buildScriptSha256'];
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 const stamp={sourceCommit:NATIVE_SOURCE_COMMIT,executableSha256:hash('probe binary'),probeSha256:hash('harness'),buildScriptSha256:hash('build script')};
 const contents=['probe binary','harness','build script'];const manifest=join(output,'probe-build.json');
 const config={root,output,source:undefined,compilerBin:undefined,executable,env:{}};
 try{
  paths.forEach((path,i)=>writeFileSync(path,contents[i]));writeFileSync(manifest,JSON.stringify(stamp));assert.equal(verifyNativeManifest(config).sourceCommit,NATIVE_SOURCE_COMMIT);
  for(let i=0;i<paths.length;i++){writeFileSync(paths[i],contents[i]+' changed');assert.throws(()=>verifyNativeManifest(config),/Stale native build/);writeFileSync(paths[i],contents[i]);assert.equal(verifyNativeManifest(config)[keys[i]],stamp[keys[i] as keyof typeof stamp]);}
  writeFileSync(manifest,JSON.stringify({...stamp,sourceCommit:'wrong revision'}));assert.throws(()=>verifyNativeManifest(config),/Unexpected native build revision/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
