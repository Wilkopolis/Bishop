import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev, /api is proxied to the .NET host started with `npm run dev:api`
// (Bishop.exe --api-only), which listens on the fixed dev port below.
const API_PORT = Number(process.env.BISHOP_API_PORT || 45900);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // With the default target, esbuild rewrites `||=` in xterm.js and drops a variable it still assigns to.
    // xterm then throws on the first mode query from agy and the Terminal stays blank. WebView2 is always current.
    target: 'esnext',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        ws: true, // terminal WebSocket
      },
    },
  },
});
