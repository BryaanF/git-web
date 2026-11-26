import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  DEFAULT_CLIENT_PORT,
  DEFAULT_SERVER_PORT,
  formatHostForUrl,
} from './src/server/ports.ts';

function parseEnvPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

const host = process.env.GITWEB_HOST?.trim() || '0.0.0.0';
const clientPort = parseEnvPort(
  process.env.GITWEB_CLIENT_PORT ?? process.env.VITE_PORT,
  DEFAULT_CLIENT_PORT,
);
const apiPort = parseEnvPort(
  process.env.GITWEB_SERVER_PORT ?? process.env.GITWEB_PORT,
  DEFAULT_SERVER_PORT,
);
const apiTarget =
  process.env.GITWEB_API_TARGET?.trim() ||
  `http://${formatHostForUrl(host)}:${apiPort}`;
const strictPort = process.env.GITWEB_STRICT_PORT === '1';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host,
    port: clientPort,
    strictPort,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler)/,
              priority: 30,
            },
            {
              name: 'syntax-vendor',
              test: /node_modules[\\/](highlight\.js|lowlight)/,
              priority: 20,
              minSize: 40 * 1024,
              maxSize: 420 * 1024,
            },
            {
              name: 'diff-vendor',
              test: /node_modules[\\/]@git-diff-view/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
