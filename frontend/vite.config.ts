import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split vendor libraries into separate chunks for better caching
          react: ['react', 'react-dom'],
          d3: ['d3'],
        },
      },
    },
  },
});
