// 把 src/og-source.svg 渲染成 public/og.png（1200×630）。
// 改文案就改那个 SVG，然后 `npm run og`。
// 单独成脚本的原因：OG 卡在社交平台上的点击率影响比 SEO 大得多，
// 而它没法用 Astro 的图片管线生成（需要固定的 1200×630 画布）。
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const info = await sharp(join(root, 'tools/og-source.svg'), { density: 144 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(join(root, 'public/og.png'));

console.log(`og.png ${info.width}×${info.height} · ${Math.round(info.size / 1024)} KB`);
