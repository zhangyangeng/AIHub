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
 * ## 最重要的一条不变量
 *
 * **只要是守卫把用户送到某个地址的，就必须始终存在一条回去的路。**
 *
 * 站点 webview 没有地址栏、没有后退按钮：用户一旦停在 `/backend-api/models`
 * 这种接口地址上，看到的就是一整屏原始 JSON，且毫无自救手段——只能关标签。
 * 这个不变量被破坏过一次（见下面 returns 分键那段注释），代价就是用户被
 * 永久锁在一坨 JSON 上。任何改动都别把它弄丢。
 *
 * ## 边界（别假装它更强）
 *
 * - 拿不到 clearance 时它只能提示 + 给一条返回的路，没法变通过盾 ——
 *   那取决于出口 IP 和客户端指纹；
 * - 只在**同源**的挑战上能送回原处（跨源跳转时 sessionStorage 带不过去）；
 * - Service Worker / Worker 里的请求不走这里（登录链路都是页面级请求）。
 *
 * ## 回归
 *
 * - `tools/cloudflare-guard-loop.sh`：真 app + fixture，验「挑战能不能被挪进
 *   文档里跑完」；
 * - `tools/cloudflare-guard-strand-test.js`：Node + Chromium 注入这同一份脚本，
 *   验**状态机**（并发、状态掉落、连续失败），确定性、秒级。
 */
(() => {
  'use strict';

  const MARK = '[aihub-cf-guard]';
  const KEY = 'aihub_cf_guard';
  const RETRY_WINDOW_MS = 60 * 1000;
  const BANNER_ID = 'aihub-cf-guard-banner';
  const BODY_SCAN_LIMIT = 200000;
  const PRUNE_MS = 10 * RETRY_WINDOW_MS;
  /** 一个时间窗里最多允许把用户的页面甩走几次（见 recover 里的总闸门） */
  const MAX_REPLAYS = 3;

  /** 本文档内是否已经发起过顶层重放（单飞闸门，刻意不跨导航：每个文档一份） */
  let navigating = false;

  // --- 跨导航的状态：sessionStorage 优先，cookie 只作兜底 -------------------
  // 为什么需要一道跨导航的闸门：重放之后新文档会重新注入本脚本，没有跨导航的
  // 记忆就会无限刷新。sessionStorage 正好够用（同源导航保留，关标签即清）。
  // cookie 只在 sessionStorage 抛异常时写（隐私模式等），为的是**不**在站点域名
  // 下留任何东西 —— 那是别人的地盘，能不留痕迹就不留。
  //
  // 状态形状（三个字段各管一件事，别再塞回一个槽里）：
  //   tried:   { [目标URL]: 毫秒 }           重放闸门，防无限刷
  //   returns: { [目标URL]: {from, at} }     按**目标 URL** 记返回点
  //   home:    最近一次「用户自己那一页」     returns 掉了时的兜底
  //   replays: [毫秒, ...]                   总闸门，限制整体重放次数
  //
  // ⚠️ returns 必须按目标 URL 分键，不能是单槽。踩过的坑（v0.3.3 的现场）：
  // 页面对同一个接口并发发两次请求，两个 403 前后脚到；第一次记下返回点并
  // 发起顶层导航，第二次撞上重放闸门——而当时闸门那条路会顺手 `delete
  // state.return`，把单槽的返回点擦掉。可导航已经在路上了，新文档里于是一个
  // 返回点都没有，用户**永久停在那坨接口 JSON 上**。
  // 分键之后并发互不干扰，闸门也不再碰返回点。

  function readState() {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) return JSON.parse(raw) || {};
    } catch { /* 忽略 */ }
    try {
      const m = document.cookie.match(/(?:^|;\s*)aihub_cf_guard=([^;]+)/);
      if (m) return JSON.parse(decodeURIComponent(m[1])) || {};
    } catch { /* 忽略 */ }
    return {};
  }

  function writeState(state) {
    // 顺手修剪过期条目：这两张表跟着会话走，不剪的话长会话里会一直涨
    const now = Date.now();
    try {
      for (const k of Object.keys(state.tried || {})) {
        if (now - state.tried[k] > PRUNE_MS) delete state.tried[k];
      }
      for (const k of Object.keys(state.returns || {})) {
        const at = state.returns[k] && state.returns[k].at;
        if (!at || now - at > PRUNE_MS) delete state.returns[k];
      }
    } catch { /* 忽略 */ }

    const text = JSON.stringify(state);
    try {
      sessionStorage.setItem(KEY, text);
      return;
    } catch { /* 落到 cookie 兜底 */ }
    try {
      document.cookie = `${KEY}=${encodeURIComponent(text)}; path=/; max-age=120`;
    } catch { /* 两条路都断了就只能放弃闸门，但至少不会更糟 */ }
  }

  /** 这一页是守卫自己把用户送过来的吗（而不是用户自己点过来的） */
  const isOurOwnLanding = (state) =>
    Boolean((state.returns && state.returns[location.href])
      || (state.tried && state.tried[location.href]));

  /** 从当前这页出发能回到哪儿；没有可回之处就返回空串 */
  function wayBack(state) {
    const entry = state.returns && state.returns[location.href];
    const to = (entry && entry.from) || state.home || '';
    return to && to !== location.href ? to : '';
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
  /**
   * 提示条。`backTo` 非空时带一颗「返回上一页」按钮 —— 这是唯一的逃生口：
   * 站点 webview 没有地址栏也没有后退按钮，用户停在接口地址或过不去的挑战页
   * 上时，没有这颗按钮就只能关标签。
   */
  function banner(backTo) {
    try {
      if (document.getElementById(BANNER_ID) || !document.body) return;
      const el = document.createElement('div');
      el.id = BANNER_ID;
      el.setAttribute('style', [
        'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647',
        'max-width:320px', 'padding:10px 12px', 'border-radius:8px',
        'background:#3a2a12', 'color:#ffd79a', 'font:12px/1.6 system-ui,sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,.35)',
      ].join(';'));

      const text = document.createElement('div');
      text.textContent = backTo
        ? 'Aihub：Cloudflare 人机验证没有通过，已停止自动重试。可以返回上一页，或刷新／换个网络再试。'
        : 'Aihub：Cloudflare 人机验证没有通过，已停止自动重试。请刷新页面或更换网络后再试。';
      el.appendChild(text);

      if (backTo) {
        const btn = document.createElement('button');
        btn.textContent = '返回上一页';
        btn.setAttribute('style', [
          'margin-top:8px', 'padding:4px 10px', 'border-radius:6px', 'cursor:pointer',
          'border:1px solid rgba(255,215,154,.35)', 'background:transparent',
          'color:#ffd79a', 'font:12px/1.4 system-ui,sans-serif',
        ].join(';'));
        btn.addEventListener('click', () => {
          // 手动返回时把这一页的痕迹清掉，免得回去之后又被闸门当成「刚重放过」
          const state = readState();
          if (state.returns) delete state.returns[location.href];
          if (state.tried) delete state.tried[location.href];
          writeState(state);
          location.replace(backTo);
        });
        el.appendChild(btn);
      }

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

    // 单飞：这份文档已经在往外跳了，后到的 403 一律闭嘴。
    // 不加这道闸门的话，并发请求会叠着调 location.replace，还会往一个**马上
    // 就要被替换掉**的页面上挂提示条（用户根本看不到），纯属添乱。
    if (navigating) return;

    const state = readState();
    const tried = (state.tried && state.tried[target]) || 0;
    if (Date.now() - tried < RETRY_WINDOW_MS) {
      console.warn(`${MARK} 同一个 URL 刚重放过，停止自动恢复：${target}`);
      // 注意：这里**不能**动 returns。认输的职责是「别再导航」，
      // 不是「把回家的路擦掉」—— 擦掉就等于把用户锁死在接口响应上。
      banner(wayBack(state));
      return;
    }

    // 总闸门：per-URL 的闸门只拦得住「同一个地址反复重放」，拦不住「站点有
    // 一串被拦的接口，于是用户被一个接一个地甩过去」。顶层导航是很重的动作
    // （整页没了），必须有个总数上限。
    state.replays = (state.replays || []).filter((t) => Date.now() - t < RETRY_WINDOW_MS);
    if (state.replays.length >= MAX_REPLAYS) {
      console.warn(`${MARK} 短时间内已经重放 ${state.replays.length} 次，停止自动恢复`);
      writeState(state);
      banner(wayBack(state));
      return;
    }
    state.replays.push(Date.now());

    state.tried = state.tried || {};
    state.tried[target] = Date.now();
    // 只记同源的返回点：跨源时 sessionStorage 带不过去，记了也没用
    try {
      if (new URL(target).origin === location.origin) {
        state.returns = state.returns || {};
        state.returns[target] = { from: location.href, at: Date.now() };
        state.home = location.href;
      }
    } catch { /* 忽略 */ }
    writeState(state);

    navigating = true;
    console.warn(`${MARK} 检测到 Cloudflare 挑战（HTTP ${status}），顶层导航重放一次：${target}`);
    location.replace(target);
  }

  /**
   * 新文档落地时做两件事：记住「用户自己那一页」，以及该回去就回去。
   *
   * 回去的判据：这一页是守卫自己送过来的（URL 在 returns/tried 里），而且它
   * 不是挑战页 —— 那说明我们正停在「那次被拦请求的响应」上（Cloudflare 重放
   * 原请求的结果，通常就是一坨接口 JSON）。
   *
   * 必须等 DOMContentLoaded：挑战页的 title/`_cf_chl_opt` 要到那时候才在，
   * 早一步判断就会把正在跑的挑战自己打断。
   *
   * （已验过的前提，别再怀疑这一层：application/json 这种非 HTML 文档上，
   * document-start 注入脚本照跑、DOMContentLoaded 照触发、同源 sessionStorage
   * 照样带得过去。所以「停在 JSON 上回不去」从来不是注入没生效，
   * 而是返回点被擦了。）
   */
  function onLanded() {
    const state = readState();
    const ours = isOurOwnLanding(state);

    if (isChallengeDocument()) {
      // 挑战在跑，绝不插手（打断它 = 登录必挂）。但如果是我们把用户送到这儿的，
      // 就得给一条逃生口 —— 否则盾一直过不去就是永久卡死。
      if (ours) banner(wayBack(state));
      return;
    }

    if (!ours) {
      // 用户自己的页面：记成兜底返回点
      if (state.home !== location.href) {
        state.home = location.href;
        writeState(state);
      }
      return;
    }

    const back = wayBack(state);
    if (!back) return;
    if (state.returns) delete state.returns[location.href];
    writeState(state);
    console.warn(`${MARK} 挑战已过，回到刚才的页面：${back}`);
    location.replace(back);
  }

  document.addEventListener('DOMContentLoaded', onLanded, { once: true });

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
