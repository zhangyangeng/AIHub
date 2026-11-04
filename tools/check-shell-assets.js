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

if (!hasSource('script-src', "'self'")) {
  failures.push("CSP 的 script-src 没有 'self'，打包后的脚本会被拦掉");
}

if (failures.length) {
  console.error('[shell-assets] 失败：');
  for (const item of failures) console.error('  ✗ ' + item);
  process.exit(1);
}

console.log(`[shell-assets] ${local.length} 个本地资源齐全，CSP 放行 self`);
