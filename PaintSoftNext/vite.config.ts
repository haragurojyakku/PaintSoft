import { defineConfig } from 'vite';

// base: './' keeps every asset URL relative, so the same build works from a plain
// static host (Cloudflare Pages) and from the desktop shell's virtual host mapping
// (https://paintsoft.local/) without a rebuild.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5273,
  },
});
