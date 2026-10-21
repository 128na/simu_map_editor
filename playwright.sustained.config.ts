import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir:'./tests/browser',testMatch:'sustained-performance.spec.ts',workers:1,reporter:'list',
  outputDir:'.validation/sustained-artifacts',
  projects:[{name:'sustained-chrome',use:{browserName:'chromium',channel:'chrome'}}],
  use:{baseURL:'http://127.0.0.1:4173',viewport:{width:1280,height:900},trace:'off'},
  webServer:{command:'npm run dev -- --port 4173 --strictPort',url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:30000},
});
