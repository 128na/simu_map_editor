import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/browser',testMatch:'performance.spec.ts',timeout:360000,workers:1,
 reporter:[['list'],['json',{outputFile:'.validation/performance-browser-results.json'}]],
 outputDir:'.validation/performance-artifacts',
 projects:[{name:'chromium'}],
 use:{browserName:'chromium',baseURL:'http://127.0.0.1:4173',viewport:{width:1280,height:900},trace:'off'},
 webServer:{command:'npm run dev -- --port 4173 --strictPort',url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:30000},
});
