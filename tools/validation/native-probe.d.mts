export interface NativeConfig {root:string;output:string;source:string|undefined;compilerBin:string|undefined;executable:string;env:NodeJS.ProcessEnv}
export const NATIVE_SOURCE_COMMIT:string;
export function nativeEnvironment(env:NodeJS.ProcessEnv,compilerBin?:string,platform?:string):NodeJS.ProcessEnv;
export function nativeProbeConfig(options?:{env?:NodeJS.ProcessEnv;platform?:string;root?:string}):NativeConfig;
export function verifyNativeBuild(config:NativeConfig):Record<string,unknown>;
export function verifyNativeManifest(config:NativeConfig):Record<string,unknown>;
