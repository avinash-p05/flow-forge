import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path/win32';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../static/client/public'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
