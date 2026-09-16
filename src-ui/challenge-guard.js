/**
 * Cloudflare 挑战守卫 —— 注入到**每个站点 webview** 的初始脚本
 * （views.rs 的 create_view 用 include_str! 把它塞进 initialization_script，
 * 在页面脚本之前执行）。
 *
 * ## 它解决的问题
 *
 * Cloudflare 的 Managed Challenge 只能在一个**文档**里跑完：挑战页要加载
 * challenges.cloudflare.com 的 orchestrate 脚本、要点一遍自己的状态机。
 * 而当被拦的是一个 fetch/XHR 时，响应体只是那张 HTML，**没有任何文档会执行它**：
 * 页面拿到 403 + 一段 HTML，前端把它当业务响应解析，于是死在
 * `Route Error (403): "<!DOCTYPE html>..."`（ChatGPT 登录页的实际表现，
 * auth.openai.com 的 /api/accounts/email-otp/resend）。
 *
 * 所以守卫做的事不是「伪造指纹去过盾」（那既不可靠、也不是这个 app 该干的），
 * 而是把**本来该在文档里发生的挑战，挪到文档里去发生**：
 *
 *   1. XHR/fetch 拿到 403 挑战 → 记住当前页面，然后顶层导航到那个被拦的 URL，
 *      让 Cloudflare 的挑战以文档形式真正跑一次；
 *   2. 过盾之后浏览器会停在那次请求的响应上（Cloudflare 就是这么设计的：
 *      它重放原请求）——守卫在新文档里发现「我是回来的路上」，把用户送回
 *      刚才那一页；
 *   3. 同一个 URL 在一个时间窗内只自动重放一次。第二次说明 clearance 拿不到
 *      （指纹被拒、或网络侧就是过不去），此时**停手**并挂一条提示，
 *      绝不无限刷新。
 *
 * ## 边界（别假装它更强）
 *
 * - 拿不到 clearance 时它只能提示，没法变通过盾 —— 那取决于出口 IP 和客户端指纹；
 * - 只在**同源**的挑战上能送回原处（跨源跳转时 sessionStorage 带不过去）；
 * - Service Worker / Worker 里的请求不走这里（登录链路都是页面级请求）。
 */
(() => {
  'use strict';

  const MARK = '[aihub-cf-guard]';
  const KEY = 'aihub_cf_guard';
  const RETRY_WINDOW_MS = 60 * 1000;
  const BANNER_ID = 'aihub-cf-guard-banner';
  const BODY_SCAN_LIMIT = 200000;

  // --- 跨导航的状态：sessionStorage 优先，cookie 只作兜底 -------------------
  // 为什么需要一道跨导航的闸门：重放之后新文档会重新注入本脚本，没有跨导航的
  // 记忆就会无限刷新。sessionStorage 正好够用（同源导航保留，关标签即清）。
  // cookie 只在 sessionStorage 抛异常时写（隐私模式等），为的是**不**在站点域名
  // 下留任何东西 —— 那是别人的地盘，能不留痕迹就不留。
  function readState() {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* 忽略 */ }
    try {
      const m = document.cookie.match(/(?:^|;\s*)aihub_cf_guard=([^;]+)/);
      if (m) return JSON.parse(decodeURIComponent(m[1]));
    } catch { /* 忽略 */ }
    return {};
  }
  function writeState(state) {
    const text = JSON.stringify(state);
    try {
      sessionStorage.setItem(KEY, text);
      return;
    } catch { /* 落到 cookie 兜底 */ }
    try {
      document.cookie = `${KEY}=${encodeURIComponent(text)}; path=/; max-age=120`;
    } catch { /* 两条路都断了就只能放弃闸门，但至少不会更糟 */ }
  }

  // --- 判定：这是挑战吗 ----------------------------------------------------
  const bodySaysChallenge = (body) =>
    typeof body === 'string' && body.length > 0 && body.length < BODY_SCAN_LIMIT &&
    (body.includes('Just a moment') ||
     body.includes('_cf_chl_opt') ||
     body.includes('cf-chl') ||
     body.includes('challenges.cloudflare.com'));

  /** 响应头是最硬的信号；没有头时退回到「403/503 + HTML + 特征串」 */
  function looksChallenged(status, mitigated, contentType, body) {
    if (String(mitigated || '').toLowerCase() === 'challenge') return true;
    return (status === 403 || status === 503) &&
      /text\/html/i.test(contentType || '') && bodySaysChallenge(body);
  }

  /** 当前这份文档**本身**就是挑战页吗（是的话必须让 Cloudflare 自己跑完，别插手） */
  function isChallengeDocument() {
    try {
      if (/just a moment|attention required|checking your browser|verifying you are human/i
        .test(document.title || '')) return true;
      const head = document.head ? document.head.innerHTML.slice(0, 50000) : '';
      return head.includes('_cf_chl_opt') || head.includes('challenges.cloudflare.com');
    } catch {
      return false;
    }
  }

  // --- 动作 ---------------------------------------------------------------
  function banner() {
    try {
      if (document.getElementById(BANNER_ID) || !document.body) return;
      const el = document.createElement('div');
      el.id = BANNER_ID;
      el.textContent = 'Aihub：Cloudflare 人机验证没有通过，已停止自动重试。请刷新页面或更换网络后再试。';
      el.setAttribute('style', [
        'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647',
        'max-width:320px', 'padding:10px 12px', 'border-radius:8px',
        'background:#3a2a12', 'color:#ffd79a', 'font:12px/1.6 system-ui,sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,.35)',
      ].join(';'));
      document.body.appendChild(el);
    } catch { /* 忽略 */ }
  }

  const absolute = (raw) => {
    try {
      const u = new URL(String(raw || ''), location.href);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch { return ''; }
  };

  /** 被拦了：要么顶层重放一次，要么认输提示 */
  function recover(rawUrl, status) {
    const target = absolute(rawUrl);
    if (!target) return;

    const state = readState();
    const tried = (state.tried && state.tried[target]) || 0;
    if (Date.now() - tried < RETRY_WINDOW_MS) {
      console.warn(`${MARK} 同一个 URL 刚重放过，停止自动恢复：${target}`);
      delete state.return;
      writeState(state);
      banner();
      return;
    }

    state.tried = state.tried || {};
    state.tried[target] = Date.now();
    // 只记同源的返回点：跨源时 sessionStorage 带不过去，记了也没用
    try {
      if (new URL(target).origin === location.origin) {
        state.return = { from: location.href, to: target };
      }
    } catch { /* 忽略 */ }
    writeState(state);

    console.warn(`${MARK} 检测到 Cloudflare 挑战（HTTP ${status}），顶层导航重放一次：${target}`);
    location.replace(target);
  }

  /**
   * 回到原处：新文档如果不是挑战页、又不是用户原本那一页，说明我们正停在
   * 「那次被拦请求的响应」上（Cloudflare 重放原请求的结果）——把用户送回去。
   *
   * 必须等 DOMContentLoaded：挑战页的 title/`_cf_chl_opt` 要到那时候才在，
   * 早一步判断就会把正在跑的挑战自己打断。
   */
  function maybeReturn() {
    const state = readState();
    const back = state.return;
    if (!back || !back.from || !back.to) return;
    if (isChallengeDocument()) return;      // 挑战在跑，别插手
    if (location.href === back.from) {      // 已经回到原处了，闸门清掉
      delete state.return;
      writeState(state);
      return;
    }
    delete state.return;
    writeState(state);
    console.warn(`${MARK} 挑战已过，回到刚才的页面：${back.from}`);
    location.replace(back.from);
  }

  document.addEventListener('DOMContentLoaded', maybeReturn, { once: true });

  // --- 打点 1：fetch ------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = origFetch.apply(this, arguments);
      return p.then((res) => {
        try {
          const mitigated = res.headers && res.headers.get ? res.headers.get('cf-mitigated') : '';
          // 头能直接判出来就不用读 body 了；读不到头（跨源不给看）才克隆一份看内容
          if (String(mitigated || '').toLowerCase() === 'challenge') {
            recover(url || res.url, res.status);
            return res;
          }
          if (res.status === 403 || res.status === 503) {
            const ct = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
            if (/text\/html/i.test(ct)) {
              res.clone().text()
                .then((body) => { if (bodySaysChallenge(body)) recover(url || res.url, res.status); })
                .catch(() => { /* body 读不了就算了，不是致命的 */ });
            }
          }
        } catch { /* 忽略：守卫本身绝不能把页面搞崩 */ }
        return res;
      });
    };
  }

  // --- 打点 2：XMLHttpRequest --------------------------------------------
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR && XHR.open && XHR.send) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (method, url) {
      this.__aihubCfUrl = url;
      return origOpen.apply(this, arguments);
    };
    XHR.send = function () {
      this.addEventListener('load', () => {
        try {
          if (this.status !== 403 && this.status !== 503) return;
          const mitigated = this.getResponseHeader('cf-mitigated');
          const ct = this.getResponseHeader('content-type') || '';
          let body = '';
          try { body = this.responseText || ''; } catch { /* responseType 非文本时会抛 */ }
          if (looksChallenged(this.status, mitigated, ct, body)) {
            recover(this.__aihubCfUrl || this.responseURL, this.status);
          }
        } catch { /* 忽略 */ }
      });
      return origSend.apply(this, arguments);
    };
  }
})();
