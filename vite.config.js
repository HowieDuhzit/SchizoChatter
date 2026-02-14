import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'SchizoChatter',
        short_name: 'SchizoChat',
        start_url: '/',
        display: 'standalone',
        background_color: '#111111',
        theme_color: '#ffcc35',
        description: 'Two random characters arguing about conspiracy theories in sync for all viewers.',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml'
          }
        ]
      }
    })
  ],
  server: {
    port: 5174,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true
      },
      '/images': 'http://localhost:3001'
    }
  }
});
