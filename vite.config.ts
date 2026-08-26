import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  server: {
    watch: {
      // Пути абсолютные намеренно. Шаблон вида '**/data/**' заодно глушил
      // src/data — правки в модулях облака переставали доезжать до браузера.
      ignored: [`${root}dist/**`, `${root}csv/**`, `${root}data/**`, `${root}tmp_*.csv`],
    },
  },
  build: { target: 'es2022' },
});
