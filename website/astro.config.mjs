import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://aihub.wrysmile.cn',
  integrations: [sitemap()],
  build: {
    inlineStylesheets: 'auto',
  },
});
