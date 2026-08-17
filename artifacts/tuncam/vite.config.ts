import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';

const port = Number(process.env.PORT || 5173);
const basePath = process.env.BASE_PATH || '/';

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

const plugins: PluginOption[] = [react(), tailwindcss()];

if (process.env.NODE_ENV !== 'production') {
  plugins.push((await import('@replit/vite-plugin-runtime-error-modal')).default());
  if (process.env.REPL_ID) {
    plugins.push(
      await import('@replit/vite-plugin-cartographer').then((module) =>
        module.cartographer({
          root: path.resolve(import.meta.dirname, '..'),
        }),
      ),
      await import('@replit/vite-plugin-dev-banner').then((module) => module.devBanner()),
    );
  }
}

export default defineConfig({
  base: basePath,
  plugins,
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(import.meta.dirname, '..', '..', 'attached_assets'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
