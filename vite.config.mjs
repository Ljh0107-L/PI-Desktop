import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'app/renderer',
  base: './',
  plugins: [react()],
  // Fonts (KaTeX's) stay files: the renderer's CSP allows fonts from 'self', not data: URIs.
  build: { outDir: '../../dist/renderer', emptyOutDir: true, sourcemap: true, assetsInlineLimit: file => /\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined },
  server: { port: 5199, strictPort: true },
});
