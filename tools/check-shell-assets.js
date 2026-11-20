// 校验打包后的外壳页面自洽：引用的资源都存在，CSP 也允许加载它们。
//
// 开发模式下 Vite 把样式以 <style> 注入页面，生产构建才换成外链 .css，
// 所以「CSP 挡住样式表」这类问题只在打包后出现，本地跑 dev 看不出来。
// 曾经发布过一版 style-src 只写了 'unsafe-inline' 的包，用户装上后整页无样式。
//
// 用法：node tools/check-shell-assets.js（需先构建 src-ui）

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'src-ui', 'dist');
const htmlPath = path.join(dist, 'index.html');

if (!fs.existsSync(htmlPath)) {
  console.error('[shell-assets] 找不到 src-ui/dist/index.html，先跑一次前端构建');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const failures = [];

/** CSP 里的某个指令是否包含指定来源 */
function hasSource(directive, source) {
  const meta = /<meta[^>]+Content-Security-Policy[^>]*>/i.exec(html)?.[0] || '';
  const policy = /content="([^"]*)"/i.exec(meta)?.[1] || '';
  const rule = policy
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.toLowerCase().startsWith(directive + ' '));
  if (!rule) return false;
  return rule.slice(directive.length).split(/\s+/).includes(source);
}

// 引用的本地资源必须真的在 dist 里
const refs = [
  ...html.matchAll(/<script[^>]+src="([^"]+)"/g),
  ...html.matchAll(/<link[^>]+href="([^"]+)"/g),
].map((m) => m[1]);

const local = refs.filter((ref) => !/^[a-z]+:|^\/\//i.test(ref));
if (!local.length) failures.push('index.html 没有引用任何本地资源，构建产物不完整');

for (const ref of local) {
  const file = path.join(dist, ref.replace(/^\.\//, ''));
  if (!fs.existsSync(file)) failures.push(`引用 ${ref} 但 ${path.relative(root, file)} 不存在`);
}

// 有外链样式表时，style-src 必须放行 'self'
const hasStylesheet = local.some((ref) => ref.endsWith('.css'));
if (hasStylesheet && !hasSource('style-src', "'self'")) {
  failures.push("存在外链样式表，但 CSP 的 style-src 没有 'self'，样式会被拦掉");
}

// 图标表里登记的每个文件都得真的在 dist 里。
// public/icons 由 Vite 原样拷贝，一旦目录被清掉或路径写错，标签栏和设置页会静默变成
// 一排空圆点——本地 dev 正常、打包后才暴露。这条以前由 check-package.js 翻 app.asar 查，
// Tauri 没有 asar，直接查 dist 就是等价的门禁。
const iconsTablePath = path.join(dist, 'icons.js');
let iconCount = 0;
if (!fs.existsSync(iconsTablePath)) {
  failures.push('dist/icons.js 不存在（标签栏读不到图标表，全部退化成圆点）');
} else {
  const fake = {};
  try {
    new Function('window', fs.readFileSync(iconsTablePath, 'utf8'))(fake);
  } catch (err) {
    failures.push('dist/icons.js 求值失败：' + err.message);
  }
  const table = fake.AIHUB_ICONS;
  if (!table) {
    failures.push('dist/icons.js 里没有 AIHUB_ICONS');
  } else {
    const iconPaths = new Set();
    for (const rel of Object.values(table.files || {})) if (rel) iconPaths.add(rel);
    for (const variant of Object.values(table.variants || {})) {
      for (const rel of [variant && variant.dark, variant && variant.light]) if (rel) iconPaths.add(rel);
    }
    const missingIcons = [...iconPaths].filter(
      (rel) => !fs.existsSync(path.join(dist, rel.replace(/^\//, ''))),
    );
    iconCount = iconPaths.size;
    if (!iconPaths.size) {
      failures.push('icons.js 的图标表是空的，manifest 没读到？');
    } else if (missingIcons.length) {
      failures.push(
        `图标表登记了 ${iconPaths.size} 个，其中 ${missingIcons.length} 个不在 dist 里：` +
          missingIcons.slice(0, 5).join(' ') +
          '（跑 npm run icons 重新生成）',
      );
    }
  }
}

if (!hasSource('img-src', "'self'")) {
  failures.push("CSP 的 img-src 没有 'self'，本地图标会被拦掉");
}

if (!hasSource('script-src', "'self'")) {
  failures.push("CSP 的 script-src 没有 'self'，打包后的脚本会被拦掉");
}

if (failures.length) {
  console.error('[shell-assets] 失败：');
  for (const item of failures) console.error('  ✗ ' + item);
  process.exit(1);
}

console.log(
  `[shell-assets] ${local.length} 个本地资源齐全，${iconCount} 个图标到位，CSP 放行 self`,
);
