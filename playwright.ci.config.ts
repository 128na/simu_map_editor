import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/browser',testMatch:['editor.spec.ts','settings.spec.ts','surface.spec.ts','compatibility.spec.ts','large-map.spec.ts','editing-tools.spec.ts','history-integration.spec.ts','history-store.spec.ts'],
 timeout:60000,workers:1,reporter:'list',outputDir:'.validation/ci-browser-artifacts',
 use:{browserName:'chromium',baseURL:'http://127.0.0.1:4173',viewport:{width:1280,height:900},screenshot:'only-on-failure',trace:'retain-on-failure'},
 webServer:{command:'npm run dev -- --port 4173 --strictPort',url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:30000},
});
