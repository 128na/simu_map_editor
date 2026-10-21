import { defineConfig } from 'vite';
export default defineConfig(({isPreview})=>({
  base: isPreview ? (process.env.PREVIEW_BASE ? '/'+process.env.PREVIEW_BASE.replace(/^\/+|\/+$/g,'')+'/' : '/') : './',
  server: { watch: { ignored: ['**/.validation/**', '**/dist/**'] } }
}));
