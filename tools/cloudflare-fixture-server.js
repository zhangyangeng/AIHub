#!/usr/bin/env node
/**
 * Cloudflare 挑战的本地 fixture 服务器（回路的「环境」那一半）。
 *
 *   node tools/cloudflare-fixture-server.js            # 默认 127.0.0.1:8791
 *   CF_FIXTURE_PORT=9000 node tools/cloudflare-fixture-server.js
 *
 * 它模拟的是 Cloudflare 在 auth.openai.com 上的行为，只模拟我们关心的那一条：
 *
 *   - XHR / fetch 打到 API   → 403 + `cf-mitigated: challenge` + 挑战页 HTML
 *                              （挑战页在 XHR 里永远跑不起来 —— 这就是 bug 的根）
 *   - 文档导航打到同一个 URL → 挑战页（这一份**可解**）→ 过盾 → 发 cf_clearance
 *                              → 跳回应用
 *   - 带 cf_clearance 的请求 → 200
 *
 * 所以「恢复」这件事在本 fixture 里的定义是：
 *   页面被顶层导航过一次 → 拿到 clearance → 重新请求成功。
 * 这与真实 Cloudflare 的机制同构（挑战必须在文档里跑，XHR 里跑不了）。
 *
 * 服务器把每一步都记进 events，`GET /__status` 返回它 —— 自检脚本据此断言，
 * 不靠猜、也不靠页面文字这一条弱证据。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CF_FIXTURE_PORT || 8791);
/**
 * normal = 挑战能过（真实场景：拿到 cf_clearance 后一切照旧）
 * stuck  = 挑战**永远过不去**：文档导航也拿不到 clearance，还会被弹回应用。
 *          用来验守卫的防死循环闸门（H4）——没有闸门时这里会无限刷新。
 */
const MODE = process.env.CF_FIXTURE_MODE === 'stuck' ? 'stuck' : 'normal';
const API = '/api/accounts/email-otp/resend';
const NONCE = 'jHOlwubXWS3cFx6TAc7QSl'; // 与挑战页 CSP 里的一致，否则注入的解法会被 CSP 挡掉

const challengeHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'cloudflare-challenge.html'), 'utf8');
const spaHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'cloudflare-spa.html'), 'utf8');

const state = {
  events: [],
  sawXhrChallenge: false,   // 复现：XHR 拿到了 403 挑战
  sawDocumentChallenge: false, // 恢复：有一次顶层文档导航落到了挑战页
  documentNavigations: 0,   // H4 要断言的就是它「有界」，不是无限刷新
  sawRetryOk: false,        // 恢复成功：clearance 之后的请求 200
};

function log(line) {
  state.events.push(line);
  console.log(`[fixture] ${line}`);
}

const hasClearance = (req) => /(?:^|;\s*)cf_clearance=1(?:;|$)/.test(req.headers.cookie || '');
/** 顶层导航 vs XHR：Accept 最稳（WebKit 和 Chromium 都发 text/html） */
const isDocument = (req) =>
  req.headers['sec-fetch-dest'] === 'document' || String(req.headers.accept || '').includes('text/html');

function send(res, status, headers, body) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*', // 外壳要 fetch /__status
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}
const html = (res, status, body, extra = {}) =>
  send(res, status, { 'Content-Type': 'text/html; charset=UTF-8', ...extra }, body);
const json = (res, status, obj) =>
  send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj));

/**
 * 挑战页。
 *
 * normal：过盾后**回到这次请求的 URL** —— 这是 Cloudflare 的真实行为（它重放原请求，
 *   而不是把你送回应用）。正因如此，守卫必须自己完成「回到刚才那一页」这一步，
 *   否则用户会停在一个 JSON 响应上。
 * stuck：模拟「盾永远过不去」，弹回应用，用来验防死循环闸门。
 */
function challengeDoc(res, backUrl) {
  const solver = MODE === 'stuck'
    ? `setTimeout(function(){location.replace('/')},800)`
    : `document.cookie='cf_clearance=1; path=/';location.replace(${JSON.stringify(backUrl)})`;
  html(res, 403, challengeHtml.replace('</body>', `<script nonce="${NONCE}">${solver}</script></body>`));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/__status') {
    return json(res, 200, state);
  }
  // 页面自己上报「我渲染成了什么」——这就是用户看到的 symptom，见 spa fixture 里的注释
  if (url.pathname === '/__report') {
    log(`页面渲染: ${JSON.stringify(url.searchParams.get('text') || '')}`);
    return send(res, 204, {}, '');
  }
  if (url.pathname === '/favicon.ico') {
    return send(res, 204, {}, '');
  }
  if (url.pathname === '/') {
    log(`GET / → 假登录页（clearance=${hasClearance(req) ? '有' : '无'}）`);
    return html(res, 200, spaHtml);
  }
  if (url.pathname === API) {
    if (hasClearance(req)) {
      state.sawRetryOk = true;
      log('带 clearance 的请求 → 200（恢复成功）');
      return json(res, 200, { ok: true });
    }
    if (isDocument(req)) {
      state.sawDocumentChallenge = true;
      state.documentNavigations += 1;
      log(MODE === 'stuck'
        ? '文档导航 → 挑战页（stuck 模式：过不去，800ms 后弹回应用）'
        : '文档导航 → 挑战页（可解：过盾后回到这次请求的 URL，即 Cloudflare 重放原请求）');
      return challengeDoc(res, req.url);
    }
    state.sawXhrChallenge = true;
    log('XHR/fetch → 403 + cf-mitigated: challenge（挑战在 XHR 里跑不起来）');
    return html(res, 403, challengeHtml, { 'cf-mitigated': 'challenge', 'Server': 'cloudflare' });
  }
  return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fixture] 监听 http://127.0.0.1:${PORT}/ mode=${MODE}（API=${API}）`);
});

// 自检脚本跑完会 kill 我们；收到信号就干净退出
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
