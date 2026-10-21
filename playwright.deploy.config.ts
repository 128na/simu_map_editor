import {defineConfig} from '@playwright/test';
const deployed=process.env.DEPLOYMENT_URL;
export default defineConfig({
 testDir:'./tests/deployment',timeout:60000,workers:1,reporter:'list',outputDir:'.validation/deployment-artifacts',
 use:{browserName:'chromium',baseURL:deployed??'http://127.0.0.1:4174/preview/subdir/',viewport:{width:1280,height:900},trace:'retain-on-failure'},
 webServer:deployed?undefined:{command:'npm run preview -- --port 4174 --strictPort',url:'http://127.0.0.1:4174/preview/subdir/',reuseExistingServer:false,timeout:30000,env:{PREVIEW_BASE:'preview/subdir'}},
});
