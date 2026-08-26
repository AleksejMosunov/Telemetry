import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  // сборка и временные выгрузки не должны дёргать перезагрузку страницы
  server: { watch: { ignored: ['**/dist/**', '**/tmp_*.csv', '**/csv/**', '**/data/**'] } },
  build: { target: 'es2022' },
});
