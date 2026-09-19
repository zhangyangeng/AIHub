//! 账号迁移：把各站点的登录态导出成一个文件，在另一台设备导入。
//!
//! ## 登录态由两部分组成
//!
//! 1. **Cookie**（会话令牌通常是 HttpOnly 的，也在内）—— 走 `webview.cookies()` /
//!    `set_cookie()`，和磁盘上的文件格式无关；
//! 2. **页面本地存储**（localStorage / sessionStorage）—— 只能在该站点的页面里用 JS 读写。
//!
//! 不含 IndexedDB 和 Service Worker 缓存：这几个站点的登录态都在上面两处，
//! 其余属于缓存内容，搬过去也会被服务端刷掉。
//!
//! ## 文件格式和 Electron 版**字节级兼容**
//!
//! 加密方案照搬：scrypt(N=16384, r=8, p=1) 派生 32 字节密钥 + AES-256-GCM，
//! salt / iv / tag / data 全部 base64。这组参数正是 Node `crypto.scryptSync` 的默认值，
//! 所以 v0.2.x 导出的文件（`format` 是旧名 `ai-multi-hub-login`）在这里仍然导得进来。
//! 改这里之前先想清楚：改了就等于让所有老文件作废。
//!
//! ## ⚠️ 线程纪律：这个模块的每一个入口都必须在非主线程上跑
//!
//! 三处都会「阻塞当前线程等主线程派发回调」，在主线程上调就是自己等自己：
//!
//! - `Window::add_child`（建 webview）—— 仓库里的布局线程就是为它存在的；
//! - `Webview::eval_with_callback` + 阻塞收结果 —— 见 `tools/cloudflare-guard-selftest.js`
//!   里记的那次死锁；
//! - `Webview::cookies()` —— Tauri 文档原话：「On Windows, this function deadlocks
//!   when used in a synchronous command or event handlers. You should use `async`
//!   commands and separate threads when reading cookies.」
//!
//! 所以两个命令都是 `async fn`，并且把实际工作整个丢进 `spawn_blocking`：
//! 既保证不在主线程，也不会把异步运行时的工作线程长时间占住。

/// 迁移过程的逐步计时打点。只在 debug 构建里出声 —— 自检靠它定位卡在哪一步
/// （建视图 / 等页面 / 读 cookie / 关视图），发布版里没人需要看这些。
macro_rules! trace {
    // 外层多一对花括号：属性不能直接挂在表达式上（attributes on expressions
    // 还是 unstable），挂在块里的语句上才合法。
    ($($arg:tt)*) => {{
        #[cfg(debug_assertions)]
        {
            println!($($arg)*);
        }
    }};
}

use std::collections::BTreeMap;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview, Window, Wry};

use crate::config::Config;
use crate::services::Service;
use crate::views::{self, MAIN_WINDOW};
use crate::AppState;

const FORMAT: &str = "aihub-login";
/// 改名成 Aihub 之前导出的文件写的是这个，导入时要继续认，不能让人重导一次。
const FORMAT_LEGACY: &[&str] = &["ai-multi-hub-login"];
const VERSION: u32 = 1;

/// 本地存储里和登录有关的是 token / 用户 id 这类短字符串。各家还会把
/// 「会话列表、模型目录、草稿」整个 JSON 塞进去，动辄几百 KB，搬过去也会被
/// 服务端刷新掉 —— 超过这个长度直接跳过，只搬登录态。
const STORAGE_VALUE_MAX: usize = 8 * 1024;

const PAGE_TIMEOUT: Duration = Duration::from_secs(25);
const EVAL_TIMEOUT: Duration = Duration::from_secs(20);
/// 「页面就绪了吗」这种一问一答要用短超时。用 EVAL_TIMEOUT 的话，
/// 单次探测就能阻塞 20 秒，PAGE_TIMEOUT 那个 deadline 等于没有。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// 埋点 / 广告类 Cookie 的名字前缀。这些和登录态无关，但数量常常比登录 Cookie
/// 还多（一个站点动辄十几条 `_ga_XXXX`），是导出文件里最主要的噪音来源。
/// 只列第三方统计工具的固定命名，宁可漏掉也不误伤。
const JUNK_COOKIE_PREFIXES: &[&str] = &[
    "_ga", "_gid", "_gat", "_gcl_", "__utm", "_dc_gtm_", // Google Analytics / Ads
    "_fbp", "_fbc", // Meta Pixel
    "_clck", "_clsk", "MUID", // Microsoft Clarity
    "_hjSession", "_hj",  // Hotjar
    "ajs_", "amplitude_", "mp_", "mixpanel", // Segment / Amplitude / Mixpanel
    "_uetsid", "_uetvid", // Bing UET
    "sensorsdata", "Hm_lvt_", "Hm_lpvt_", // 神策 / 百度统计
    "sajssdk", "_tt_enable_cookie", "_ttp", // TikTok Pixel
];

// ---------------------------------------------------------------------------
// 文件格式（纯数据，可单测）
// ---------------------------------------------------------------------------

fn is_false(b: &bool) -> bool {
    !*b
}

/// 一条 Cookie。只写「和默认值不一样」的字段：导入端会把缺省补回去
/// （path 补 `/`、secure/httpOnly 补 false），把默认值写进文件纯属占地方。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CookieRec {
    pub name: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub secure: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub http_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
    /// 必须显式写：它决定导入时带不带 domain，补错了 Cookie 会挂到父域上。
    #[serde(default, skip_serializing_if = "is_false")]
    pub host_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OriginEntry {
    pub origin: String,
    #[serde(default)]
    pub local_storage: BTreeMap<String, String>,
    #[serde(default)]
    pub session_storage: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub cookies: Vec<CookieRec>,
    #[serde(default)]
    pub origins: Vec<OriginEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginFile {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    #[serde(default)]
    pub app: Value,
    #[serde(default)]
    pub services: Vec<ServiceEntry>,
}

/// 加密后的外壳。字段名和 Electron 版一字不差。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub format: String,
    pub version: u32,
    pub encrypted: bool,
    pub cipher: String,
    pub kdf: String,
    pub salt: String,
    pub iv: String,
    pub tag: String,
    pub data: String,
}

#[derive(Debug)]
pub enum Parsed {
    Plain(Box<LoginFile>),
    Encrypted(Box<Envelope>),
}

pub fn is_junk_cookie(name: &str) -> bool {
    JUNK_COOKIE_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// 解析导出文件。认新旧两种 `format`，其余一律拒绝 —— 让人早点知道选错了文件，
/// 而不是在解密那步收到一句看不懂的报错。
pub fn parse_login_file(text: &str) -> Result<Parsed, String> {
    let trimmed = text.trim_start_matches('\u{feff}');
    let raw: Value = serde_json::from_str(trimmed)
        .map_err(|_| "这个文件不是有效的登录信息文件（JSON 解析失败）".to_string())?;
    if !raw.is_object() {
        return Err("登录信息文件内容为空".into());
    }
    let format = raw.get("format").and_then(Value::as_str).unwrap_or("");
    if format != FORMAT && !FORMAT_LEGACY.contains(&format) {
        return Err("文件格式不匹配：请选择由本应用「导出登录信息」生成的文件".into());
    }
    if raw.get("encrypted").and_then(Value::as_bool).unwrap_or(false) {
        let env: Envelope = serde_json::from_value(raw)
            .map_err(|e| format!("加密文件的结构不完整：{e}"))?;
        return Ok(Parsed::Encrypted(Box::new(env)));
    }
    let file: LoginFile =
        serde_json::from_value(raw).map_err(|e| format!("文件结构不完整：{e}"))?;
    Ok(Parsed::Plain(Box::new(file)))
}

/// scrypt 的参数必须钉死成 Node `crypto.scryptSync` 的默认值：
/// N=16384（log2 = 14）、r=8、p=1、输出 32 字节。动一个字节就解不开老文件。
fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = scrypt::Params::new(14, 8, 1, 32).map_err(|e| format!("scrypt 参数非法：{e}"))?;
    let mut key = [0u8; 32];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut key)
        .map_err(|e| format!("派生密钥失败：{e}"))?;
    Ok(key)
}

pub fn encrypt(payload: &LoginFile, password: &str) -> Result<Envelope, String> {
    use aes_gcm::aead::OsRng;
    use aes_gcm::aead::rand_core::RngCore;

    let mut salt = [0u8; 16];
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut iv);

    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("初始化加密失败：{e}"))?;
    let plaintext = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    // aes-gcm 把 tag 追加在密文尾部；Node 的 GCM 把 tag 单独给。
    // 文件格式是 Node 那种，所以这里要拆开写。
    let mut sealed = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload { msg: &plaintext, aad: b"" },
        )
        .map_err(|_| "加密失败".to_string())?;
    let tag = sealed.split_off(sealed.len() - 16);

    Ok(Envelope {
        format: FORMAT.into(),
        version: VERSION,
        encrypted: true,
        cipher: "aes-256-gcm".into(),
        kdf: "scrypt".into(),
        salt: B64.encode(salt),
        iv: B64.encode(iv),
        tag: B64.encode(tag),
        data: B64.encode(sealed),
    })
}

pub fn decrypt(env: &Envelope, password: &str) -> Result<LoginFile, String> {
    if password.is_empty() {
        return Err("这个文件已加密，请先填写导出时设置的密码".into());
    }
    let salt = B64.decode(&env.salt).map_err(|_| "文件损坏：salt 不是合法的 base64".to_string())?;
    let iv = B64.decode(&env.iv).map_err(|_| "文件损坏：iv 不是合法的 base64".to_string())?;
    let tag = B64.decode(&env.tag).map_err(|_| "文件损坏：tag 不是合法的 base64".to_string())?;
    let data = B64.decode(&env.data).map_err(|_| "文件损坏：data 不是合法的 base64".to_string())?;

    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("初始化解密失败：{e}"))?;
    let mut sealed = data;
    sealed.extend_from_slice(&tag);
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), Payload { msg: &sealed, aad: b"" })
        // GCM 的认证失败和「密码错了」在密码学上分不开，但对用户来说只有一种可能
        .map_err(|_| "密码不对，或者文件已经损坏".to_string())?;
    serde_json::from_slice(&plain).map_err(|e| format!("解密后的内容不是登录信息文件：{e}"))
}

/// 把导入文件里的服务条目和本机服务对应起来。
///
/// 匹配顺序很关键：同一个站点可能被加成两个标签（同域名不同路径），
/// 只按域名匹配会把数据写进另一个服务的分区。所以先看 id、再看完整网址，
/// 最后才退回同源。一个服务只接受一条条目，防止同一份数据被写两次。
pub fn match_services<'a>(
    entries: &'a [ServiceEntry],
    services: &'a [Service],
) -> (Vec<(&'a Service, &'a ServiceEntry)>, Vec<&'a ServiceEntry>) {
    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    let mut used: Vec<&str> = Vec::new();

    for entry in entries {
        if entry.id.is_empty() {
            continue;
        }
        let pick = |pred: &dyn Fn(&Service) -> bool, used: &[&str]| -> Option<&'a Service> {
            services
                .iter()
                .find(|s| !used.contains(&s.id.as_str()) && pred(s))
        };
        let found = pick(&|s| s.id == entry.id, &used)
            .or_else(|| pick(&|s| s.url == entry.url, &used))
            .or_else(|| {
                let want = origin_of(&entry.url);
                if want.is_empty() {
                    None
                } else {
                    pick(&|s| origin_of(&s.url) == want, &used)
                }
            });
        match found {
            Some(svc) => {
                used.push(&svc.id);
                matched.push((svc, entry));
            }
            None => unmatched.push(entry),
        }
    }
    (matched, unmatched)
}

pub fn origin_of(url: &str) -> String {
    match tauri::Url::parse(url) {
        Ok(u) => match (u.scheme(), u.host_str()) {
            (scheme, Some(host)) if scheme == "http" || scheme == "https" => match u.port() {
                Some(port) => format!("{scheme}://{host}:{port}"),
                None => format!("{scheme}://{host}"),
            },
            _ => String::new(),
        },
        Err(_) => String::new(),
    }
}

pub fn count_storages(o: &OriginEntry) -> usize {
    o.local_storage.len() + o.session_storage.len()
}

// ---------------------------------------------------------------------------
// Cookie 与 tauri 类型之间的转换
// ---------------------------------------------------------------------------

/// 精简一条 Cookie；返回 None 表示这条不用导（已过期 / 埋点）。
pub fn clean_cookie(c: &cookie::Cookie<'_>, now_secs: f64) -> Option<CookieRec> {
    let name = c.name();
    if name.is_empty() || is_junk_cookie(name) {
        return None;
    }
    let expiration_date = c.expires().and_then(|e| e.datetime()).map(|d| d.unix_timestamp() as f64);
    // 已经过期的导过去也会被丢掉，不如现在就不写
    if let Some(exp) = expiration_date {
        if exp < now_secs {
            return None;
        }
    }
    let domain = c.domain().map(|d| d.to_string());
    let path = c.path().map(|p| p.to_string()).filter(|p| p != "/");
    let same_site = c.same_site().map(|s| match s {
        cookie::SameSite::Strict => "strict".to_string(),
        cookie::SameSite::Lax => "lax".to_string(),
        cookie::SameSite::None => "no_restriction".to_string(),
    });

    Some(CookieRec {
        name: name.to_string(),
        value: c.value().to_string(),
        domain,
        path,
        secure: c.secure().unwrap_or(false),
        http_only: c.http_only().unwrap_or(false),
        same_site,
        // 刻意恒为 false —— 也就是这个字段**永远不写进我们导出的文件**。
        //
        // host-only 的唯一判据是 Domain 属性有没有前导点，而 cookie crate 的
        // `domain()` 和 `domain_raw()` **都**会把点剥掉（0.18.2 的 domain_raw
        // 文档示例白纸黑字：`Domain=.crates.io` → `Some("crates.io")`）。
        // 也就是说这个信息在 wry 这一层根本拿不到。
        //
        // 那就宁可不写，也不能瞎填 true：Electron 版的 restoreCookie 看到
        // hostOnly 就**不设 domain**，域 cookie 会被钉死在单个主机上，
        // 子域名的登录态当场作废。字段保留是为了**读**老文件，不是为了写。
        host_only: false,
        expiration_date,
    })
}

/// 还原成能交给 `set_cookie` 的形状。`fallback_host` 是服务网址的主机名：
/// 文件里没写 domain 时拿它兜底 —— WebView2 的 AddOrUpdateCookie 没有 domain 会拒。
pub fn to_cookie(rec: &CookieRec, fallback_host: &str) -> Result<cookie::Cookie<'static>, String> {
    let mut c = cookie::Cookie::new(rec.name.clone(), rec.value.clone());
    let domain = rec
        .domain
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| fallback_host.to_string());
    if domain.is_empty() {
        return Err("这条 Cookie 既没有 domain，服务网址里也取不到主机名".into());
    }
    c.set_domain(domain);
    c.set_path(rec.path.clone().unwrap_or_else(|| "/".into()));
    c.set_secure(rec.secure);
    c.set_http_only(rec.http_only);
    if let Some(s) = rec.same_site.as_deref() {
        match s {
            "strict" => c.set_same_site(cookie::SameSite::Strict),
            "lax" => c.set_same_site(cookie::SameSite::Lax),
            "no_restriction" | "none" => c.set_same_site(cookie::SameSite::None),
            _ => {} // 'unspecified' 就是不设
        }
    }
    if let Some(exp) = rec.expiration_date {
        let secs = exp as i64;
        match cookie::time::OffsetDateTime::from_unix_timestamp(secs) {
            Ok(t) => c.set_expires(t),
            Err(_) => return Err(format!("过期时间不合法：{exp}")),
        }
    }
    Ok(c.into_owned())
}

// ---------------------------------------------------------------------------
// 页面侧脚本
// ---------------------------------------------------------------------------

fn storage_dump_js() -> String {
    format!(
        r#"(() => {{
  const MAX = {STORAGE_VALUE_MAX};
  // 埋点 SDK 在 localStorage 里也有一份（和 Cookie 那份同名前缀），一起跳过
  const JUNK = /^(_ga|_gid|_gcl_|_fbp|_hj|ajs_|amplitude_|mp_|mixpanel|sensorsdata|sajssdk|Hm_l|_uet)/;
  const dump = (store) => {{
    const out = {{ entries: {{}}, skipped: 0 }};
    try {{
      for (let i = 0; i < store.length; i += 1) {{
        const key = store.key(i);
        const value = store.getItem(key);
        if (JUNK.test(key) || (value != null && value.length > MAX)) {{ out.skipped += 1; continue; }}
        out.entries[key] = value;
      }}
    }} catch (err) {{ /* 某些页面禁止访问，忽略 */ }}
    return out;
  }};
  try {{
    const ls = dump(localStorage);
    const ss = dump(sessionStorage);
    return {{ ok: true, origin: location.origin, localStorage: ls.entries,
             sessionStorage: ss.entries, skipped: ls.skipped + ss.skipped }};
  }} catch (err) {{
    return {{ ok: false, error: String(err) }};
  }}
}})()"#
    )
}

fn storage_restore_js(origin: &OriginEntry) -> String {
    let ls = serde_json::to_string(&origin.local_storage).unwrap_or_else(|_| "{}".into());
    let ss = serde_json::to_string(&origin.session_storage).unwrap_or_else(|_| "{}".into());
    format!(
        r#"(() => {{
  const write = (store, data) => {{
    let n = 0;
    try {{
      for (const [k, v] of Object.entries(data)) {{ store.setItem(k, v); n += 1; }}
    }} catch (err) {{ /* 配额满或被禁用，已写进去的算数 */ }}
    return n;
  }};
  try {{
    return {{ ok: true, localStorage: write(localStorage, {ls}), sessionStorage: write(sessionStorage, {ss}) }};
  }} catch (err) {{
    return {{ ok: false, error: String(err) }};
  }}
}})()"#
    )
}

const PAGE_PROBE_JS: &str = r#"(() => {
  try {
    return { ready: document.readyState !== 'loading', origin: location.origin, href: location.href };
  } catch (err) {
    return { ready: false, error: String(err) };
  }
})()"#;

// ---------------------------------------------------------------------------
// 视图借用层（唯一会碰窗口的地方）
// ---------------------------------------------------------------------------

/// 在 webview 里跑一段 JS 并把结果拿回来。
///
/// ⚠️ 阻塞等回调 —— 只能在非主线程调用，否则回调没人派发，必然超时。
fn eval_json(view: &Webview<Wry>, js: &str) -> Result<Value, String> {
    eval_json_within(view, js, EVAL_TIMEOUT)
}

fn eval_json_within(view: &Webview<Wry>, js: &str, timeout: Duration) -> Result<Value, String> {
    let (tx, rx) = channel();
    view.eval_with_callback(js.to_string(), move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| format!("执行脚本失败：{e}"))?;
    let raw = rx
        .recv_timeout(timeout)
        .map_err(|_| format!("页面脚本没有在 {} 秒内回传结果", timeout.as_secs()))?;
    serde_json::from_str(&raw).map_err(|e| format!("页面返回的不是 JSON（{e}）：{raw}"))
}

/// 等页面真正可用，返回它当前的 origin。
fn wait_for_page(view: &Webview<Wry>) -> Result<String, String> {
    let deadline = Instant::now() + PAGE_TIMEOUT;
    let mut last = String::from("页面一直没有就绪");
    while Instant::now() < deadline {
        match eval_json_within(view, PAGE_PROBE_JS, PROBE_TIMEOUT) {
            Ok(v) => {
                let origin = v.get("origin").and_then(Value::as_str).unwrap_or("");
                if v.get("ready").and_then(Value::as_bool).unwrap_or(false)
                    && (origin.starts_with("http://") || origin.starts_with("https://"))
                {
                    return Ok(origin.to_string());
                }
                last = format!("页面还没就绪（origin={origin}）");
            }
            Err(err) => last = err,
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Err(last)
}

/// 借一个能代表该服务的 webview：已经开着就直接用，没开就建一个屏幕外的临时视图。
///
/// 返回的 bool 表示「这是临时视图，用完要销毁」。已经开着的标签**绝不能**销毁 ——
/// 那是用户正在看的页面。
fn borrow_view(window: &Window, svc: &Service) -> Result<(Webview<Wry>, bool), String> {
    if let Some(v) = window.get_webview(&views::view_label(&svc.id)) {
        trace!("[mig] {} 复用已有视图", svc.id);
        return Ok((v, false));
    }
    let t = Instant::now();
    let v = views::create_migration_view(window, &svc.id, &svc.url)
        .map_err(|e| format!("建临时视图失败：{e}"))?;
    trace!("[mig] {} 建临时视图 耗时 {}ms", svc.id, t.elapsed().as_millis());
    Ok((v, true))
}

fn release_view(window: &Window, svc: &Service, temp: bool) {
    if !temp {
        return;
    }
    let t = Instant::now();
    match window.get_webview(&views::migration_label(&svc.id)) {
        Some(v) => {
            let r = v.close();
            trace!("[mig] {} 关临时视图 {:?} 耗时 {}ms", svc.id, r.is_ok(), t.elapsed().as_millis());
        }
        None => trace!("[mig] {} 关临时视图时已经找不到它了", svc.id),
    }
}

/// 采集一个服务的登录信息。任何一步失败都只影响这个服务，不中断整场导出 ——
/// 导出七个站点时因为一个站点没登录就全盘失败，是最气人的失败方式。
fn collect_service(window: &Window, svc: &Service) -> (ServiceEntry, usize) {
    let mut entry = ServiceEntry {
        id: svc.id.clone(),
        name: svc.name.clone(),
        url: svc.url.clone(),
        ..Default::default()
    };
    let mut skipped = 0usize;

    let (view, temp) = match borrow_view(window, svc) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("[aihub] 导出 {} 拿不到视图：{err}", svc.id);
            return (entry, skipped);
        }
    };

    // 顺序很重要：**先等页面就绪，再读 cookie**。
    //
    // 反过来写会假绿：临时视图刚 add_child 出来时 WebView2 的 controller 还在
    // 初始化，cookie 存储要等页面真正跑起来才可用。热 profile 上碰巧能读到
    // （磁盘上本来就有），冷 profile 上就是 0 条 —— 而「导出了 0 条 cookie」
    // 和「这个站点没登录」在返回值上长得一模一样，最难发现的那种坏。
    let t = Instant::now();
    let ready = wait_for_page(&view);
    trace!("[mig] {} 等页面就绪 耗时 {}ms 结果 {:?}", svc.id, t.elapsed().as_millis(), ready);
    if let Err(err) = &ready {
        eprintln!("[aihub] 页面没能就绪 {}: {err}", svc.id);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let t = Instant::now();
    let got = view.cookies();
    trace!("[mig] {} 读 cookie 耗时 {}ms 结果 {}", svc.id, t.elapsed().as_millis(),
             match &got { Ok(v) => format!("{} 条", v.len()), Err(e) => format!("错误 {e}") });
    match got {
        Ok(raw) => {
            for c in &raw {
                match clean_cookie(c, now) {
                    Some(rec) => entry.cookies.push(rec),
                    None => skipped += 1,
                }
            }
        }
        Err(err) => eprintln!("[aihub] 读 Cookie 失败 {}: {err}", svc.id),
    }

    match ready {
        Ok(_) => match eval_json(&view, &storage_dump_js()) {
            Ok(v) if v.get("ok").and_then(Value::as_bool).unwrap_or(false) => {
                let origin = v.get("origin").and_then(Value::as_str).unwrap_or("").to_string();
                if !origin.is_empty() {
                    entry.origins.push(OriginEntry {
                        origin,
                        local_storage: from_str_map(v.get("localStorage")),
                        session_storage: from_str_map(v.get("sessionStorage")),
                    });
                }
                skipped += v.get("skipped").and_then(Value::as_u64).unwrap_or(0) as usize;
            }
            Ok(v) => eprintln!("[aihub] 读本地存储失败 {}: {v}", svc.id),
            Err(err) => eprintln!("[aihub] 读本地存储失败 {}: {err}", svc.id),
        },
        Err(_) => { /* 上面已经报过了 */ }
    }

    release_view(window, svc, temp);
    (entry, skipped)
}

fn from_str_map(v: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(map)) = v {
        for (k, val) in map {
            if let Some(s) = val.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

struct ApplyStat {
    cookies: usize,
    failed: usize,
    storages: usize,
}

/// 写回一个服务的登录态：先 Cookie 后本地存储，最后刷新页面让它生效。
fn apply_service(window: &Window, svc: &Service, entry: &ServiceEntry) -> ApplyStat {
    let mut stat = ApplyStat { cookies: 0, failed: 0, storages: 0 };

    let (view, temp) = match borrow_view(window, svc) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("[aihub] 导入 {} 拿不到视图：{err}", svc.id);
            stat.failed = entry.cookies.len();
            return stat;
        }
    };

    let host = tauri::Url::parse(&svc.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    // 顺序写入：并发写同一个 Cookie 存储容易互相覆盖
    for rec in &entry.cookies {
        match to_cookie(rec, &host) {
            Ok(c) => match view.set_cookie(c) {
                Ok(()) => stat.cookies += 1,
                Err(err) => {
                    eprintln!("[aihub] 写 Cookie 被拒 {} {}: {err}", svc.id, rec.name);
                    stat.failed += 1;
                }
            },
            Err(err) => {
                eprintln!("[aihub] Cookie 还原失败 {} {}: {err}", svc.id, rec.name);
                stat.failed += 1;
            }
        }
    }

    // 本地存储只能写进**同源**的页面里
    for origin in &entry.origins {
        if origin.origin.is_empty() {
            continue;
        }
        let current = match wait_for_page(&view) {
            Ok(o) => o,
            Err(err) => {
                eprintln!("[aihub] 页面没能就绪 {}: {err}", svc.id);
                break;
            }
        };
        if current != origin.origin {
            // 视图停在别的源上（例如第三方登录页）：本地存储写过去就串了，宁可不写
            eprintln!(
                "[aihub] 跳过本地存储 {}：页面在 {current}，数据属于 {}",
                svc.id, origin.origin
            );
            continue;
        }
        match eval_json(&view, &storage_restore_js(origin)) {
            Ok(v) => {
                stat.storages += v.get("localStorage").and_then(Value::as_u64).unwrap_or(0) as usize;
                stat.storages += v.get("sessionStorage").and_then(Value::as_u64).unwrap_or(0) as usize;
            }
            Err(err) => eprintln!("[aihub] 写本地存储失败 {}: {err}", svc.id),
        }
    }

    if temp {
        release_view(window, svc, temp);
    } else {
        // 用户正开着这个标签：刷新一次，让页面用新登录态重新加载
        let _ = view.eval("location.reload()");
    }
    stat
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

fn snapshot(app: &AppHandle) -> Config {
    app.state::<AppState>().snapshot()
}

fn main_window(app: &AppHandle) -> Result<Window, String> {
    app.get_window(MAIN_WINDOW).ok_or_else(|| "没有主窗口".to_string())
}

pub fn export_blocking(app: AppHandle, password: String) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;

    let stamp = now_stamp();

    // 调试期的测试接缝：给了路径就不弹对话框，自检脚本才跑得动。
    // 和 AIHUB_SELFTEST / AIHUB_LAYOUT_DUMP 一个路子，并且**只在 debug 构建里存在**——
    // 发布版里绝不能有「不经用户选择就把登录态写上磁盘」的口子。
    #[cfg(debug_assertions)]
    let preset = std::env::var("AIHUB_LOGIN_EXPORT_TO").ok().map(std::path::PathBuf::from);
    #[cfg(not(debug_assertions))]
    let preset: Option<std::path::PathBuf> = None;

    let path = match preset {
        Some(p) => p,
        None => {
            let picked = app
                .dialog()
                .file()
                .set_file_name(format!("aihub-login-{stamp}.json"))
                .add_filter("登录信息", &["json"])
                .blocking_save_file();
            let Some(picked) = picked else {
                return Ok(json!({ "ok": false, "canceled": true }));
            };
            picked.into_path().map_err(|e| format!("保存位置不可用：{e}"))?
        }
    };

    let window = main_window(&app)?;
    let cfg = snapshot(&app);

    let mut services = Vec::new();
    let mut skipped = 0usize;
    for svc in &cfg.services {
        // 逐个服务顺序采集，避免同时加载多个站点把内存和网络打满
        let (entry, n) = collect_service(&window, svc);
        skipped += n;
        services.push(entry);
    }

    let cookies: usize = services.iter().map(|s| s.cookies.len()).sum();
    let storages: usize = services
        .iter()
        .map(|s| s.origins.iter().map(count_storages).sum::<usize>())
        .sum();

    let payload = LoginFile {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: stamp_iso(),
        app: json!({ "name": "Aihub", "version": app.package_info().version.to_string() }),
        services,
    };

    let text = if password.is_empty() {
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?
    } else {
        serde_json::to_string_pretty(&encrypt(&payload, &password)?).map_err(|e| e.to_string())?
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("写入文件失败：{e}"))?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    println!(
        "[aihub] 导出登录信息: {} / {} 个服务 / {cookies} 条 Cookie / {storages} 项本地存储 / 跳过 {skipped} 项",
        path.display(),
        payload.services.len()
    );
    Ok(json!({
        "ok": true,
        "file": path.to_string_lossy(),
        "encrypted": !password.is_empty(),
        "services": payload.services.len(),
        "cookies": cookies,
        "storages": storages,
        "skipped": skipped,
        "bytes": bytes,
    }))
}

pub fn import_blocking(app: AppHandle, options: Value) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;

    let dry_run = options.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    let password = options.get("password").and_then(Value::as_str).unwrap_or("").to_string();

    // 第一次点「导入」时还没有文件，弹选择框；确认那一步会把路径原样带回来
    let given = options.get("file").and_then(Value::as_str).unwrap_or("");
    let path = if given.is_empty() {
        let Some(p) = app.dialog().file().add_filter("登录信息", &["json"]).blocking_pick_file()
        else {
            return Ok(json!({ "ok": false, "canceled": true }));
        };
        p.into_path().map_err(|e| format!("文件不可用：{e}"))?
    } else {
        std::path::PathBuf::from(given)
    };
    let file = path.to_string_lossy().to_string();

    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    let parsed = parse_login_file(&text)?;
    let encrypted = matches!(parsed, Parsed::Encrypted(_));
    let payload = match parsed {
        Parsed::Plain(p) => *p,
        Parsed::Encrypted(env) => {
            if password.is_empty() {
                // 前端靠 needsPassword 把文件路径记住，补上密码再点一次即可
                return Ok(json!({
                    "ok": false, "file": file, "needsPassword": true,
                    "error": "这个文件已加密，请先填写导出时设置的密码",
                }));
            }
            match decrypt(&env, &password) {
                Ok(p) => p,
                Err(err) => {
                    return Ok(json!({
                        "ok": false, "file": file, "needsPassword": true, "error": err,
                    }))
                }
            }
        }
    };

    let cfg = snapshot(&app);
    let (matched, unmatched) = match_services(&payload.services, &cfg.services);

    let mut summary: Vec<Value> = matched
        .iter()
        .map(|(svc, entry)| {
            json!({
                "id": svc.id,
                "name": svc.name,
                "cookies": entry.cookies.len(),
                "storages": entry.origins.iter().map(count_storages).sum::<usize>(),
            })
        })
        .collect();

    if dry_run {
        return Ok(json!({
            "ok": true, "file": file, "encrypted": encrypted,
            "exportedAt": payload.exported_at,
            "services": summary,
            "unmatched": unmatched.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
        }));
    }

    let window = main_window(&app)?;
    for (i, (svc, entry)) in matched.iter().enumerate() {
        let stat = apply_service(&window, svc, entry);
        summary[i] = json!({
            "id": svc.id,
            "name": svc.name,
            "cookies": stat.cookies,
            "storages": stat.storages,
            "failed": stat.failed,
        });
    }

    crate::request_layout(&app);
    crate::broadcast(&app);
    Ok(json!({
        "ok": true, "file": file, "encrypted": encrypted,
        "exportedAt": payload.exported_at,
        "services": summary,
        "unmatched": unmatched.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
    }))
}

fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = cookie::time::OffsetDateTime::from_unix_timestamp(secs as i64)
        .unwrap_or(cookie::time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year(), u8::from(t.month()), t.day(), t.hour(), t.minute(), t.second()
    )
}

fn stamp_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = cookie::time::OffsetDateTime::from_unix_timestamp(secs as i64)
        .unwrap_or(cookie::time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        t.year(), u8::from(t.month()), t.day(), t.hour(), t.minute(), t.second()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> LoginFile {
        LoginFile {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: "2026-09-20T00:00:00.000Z".into(),
            app: json!({ "name": "Aihub", "version": "0.4.0" }),
            services: vec![ServiceEntry {
                id: "chatgpt".into(),
                name: "ChatGPT".into(),
                url: "https://chatgpt.com/".into(),
                cookies: vec![CookieRec {
                    name: "__Secure-next-auth.session-token".into(),
                    value: "abc".into(),
                    domain: Some(".chatgpt.com".into()),
                    secure: true,
                    http_only: true,
                    ..Default::default()
                }],
                origins: vec![OriginEntry {
                    origin: "https://chatgpt.com".into(),
                    local_storage: [("token".to_string(), "t".to_string())].into_iter().collect(),
                    ..Default::default()
                }],
            }],
        }
    }

    #[test]
    fn encrypt_then_decrypt_round_trips() {
        let file = sample();
        let env = encrypt(&file, "hunter2").unwrap();
        assert_eq!(env.cipher, "aes-256-gcm");
        assert_eq!(env.kdf, "scrypt");
        assert_eq!(decrypt(&env, "hunter2").unwrap(), file);
    }

    #[test]
    fn wrong_password_says_so_in_chinese() {
        let env = encrypt(&sample(), "right").unwrap();
        let err = decrypt(&env, "wrong").unwrap_err();
        assert!(err.contains("密码不对"), "报错要说人话，实际是：{err}");
    }

    #[test]
    fn empty_password_is_rejected_before_deriving_a_key() {
        let env = encrypt(&sample(), "right").unwrap();
        assert!(decrypt(&env, "").unwrap_err().contains("已加密"));
    }

    #[test]
    fn legacy_format_name_is_still_accepted() {
        // 改名成 Aihub 之前导出的文件必须还能导入，否则老用户要重新登录一遍
        let text = r#"{"format":"ai-multi-hub-login","version":1,"exportedAt":"x","services":[]}"#;
        assert!(matches!(parse_login_file(text).unwrap(), Parsed::Plain(_)));
    }

    #[test]
    fn foreign_json_is_rejected_with_a_useful_message() {
        let err = parse_login_file(r#"{"hello":"world"}"#).unwrap_err();
        assert!(err.contains("文件格式不匹配"), "实际是：{err}");
        assert!(parse_login_file("not json").unwrap_err().contains("JSON 解析失败"));
    }

    #[test]
    fn encrypted_files_are_detected_before_any_decryption() {
        let env = encrypt(&sample(), "pw").unwrap();
        let text = serde_json::to_string(&env).unwrap();
        assert!(matches!(parse_login_file(&text).unwrap(), Parsed::Encrypted(_)));
    }

    #[test]
    fn default_fields_are_left_out_of_the_file() {
        let rec = CookieRec { name: "a".into(), value: "b".into(), host_only: true, ..Default::default() };
        let text = serde_json::to_string(&rec).unwrap();
        assert!(!text.contains("secure"), "默认值不该写进文件：{text}");
        assert!(!text.contains("path"), "默认 path 不该写进文件：{text}");
        assert!(text.contains("hostOnly"), "hostOnly 必须显式写：{text}");
    }

    /// 跨版本兼容的硬证据：fixture 是 **Node 的 crypto** 按 Electron 版
    /// `encryptLogin` 原样生成的（tools/fixtures/login-legacy-encrypted.json，
    /// 密码 legacy-password，format 还是改名前的 ai-multi-hub-login）。
    ///
    /// 这条测试挂了，就意味着老用户导出的文件在新版里打不开 —— README 第 2 节
    /// 承诺过它能打开。scrypt 参数、GCM 的 tag 拆分、base64、字段名，
    /// 任何一处漂移都会在这里炸出来。
    #[test]
    fn files_exported_by_the_electron_version_still_open() {
        let text = include_str!("../../tools/fixtures/login-legacy-encrypted.json");
        let Parsed::Encrypted(env) = parse_login_file(text).unwrap() else {
            panic!("应该被认成加密文件");
        };
        let file = decrypt(&env, "legacy-password").unwrap();

        assert_eq!(file.format, "ai-multi-hub-login");
        let svc = &file.services[0];
        assert_eq!(svc.id, "chatgpt");
        let cookie = &svc.cookies[0];
        assert_eq!(cookie.name, "__Secure-next-auth.session-token");
        assert_eq!(cookie.value, "legacy-token-value");
        assert_eq!(cookie.domain.as_deref(), Some(".chatgpt.com"));
        assert!(cookie.secure && cookie.http_only, "布尔字段不能在往返里丢掉");
        assert_eq!(cookie.same_site.as_deref(), Some("lax"));
        assert_eq!(cookie.expiration_date, Some(4102444800.0));
        assert_eq!(
            svc.origins[0].local_storage.get("oai/apps/hasSeenOnboarding").map(String::as_str),
            Some("\"2026-01-01\""),
            "本地存储的值要一字不差地带过来",
        );
    }

    /// 未加密的老文件走的是另一条分支，也得认。
    #[test]
    fn unencrypted_legacy_files_still_open() {
        let text = include_str!("../../tools/fixtures/login-legacy-plain.json");
        let Parsed::Plain(file) = parse_login_file(text).unwrap() else {
            panic!("应该被认成未加密文件");
        };
        assert_eq!(file.services[0].cookies[0].value, "legacy-token-value");
    }

    /// 反方向的 fixture 生成器：把 Rust 加的密打出来，交给
    /// `tools/login-crypto-crosscheck.js` 用 Node 的 crypto 解一遍。
    /// 平时不跑（会往 stdout 喷一大坨），要重新生成 fixture 时：
    ///   cargo test emit_envelope_for_node -- --ignored --nocapture
    #[test]
    #[ignore]
    fn emit_envelope_for_node() {
        let env = encrypt(&sample(), "crosscheck-password").unwrap();
        println!("---FIXTURE---");
        println!("{}", serde_json::to_string_pretty(&env).unwrap());
    }

    /// 我们自己导出的文件里**绝不能**出现 hostOnly。
    /// 拿不到的信息就别写 —— 写错了会让 Electron 版把域 cookie 钉死在单主机上。
    #[test]
    fn host_only_is_never_fabricated_on_export() {
        let mut c = cookie::Cookie::new("sid", "v");
        c.set_domain(".chatgpt.com");
        let rec = clean_cookie(&c, 0.0).unwrap();
        assert!(!rec.host_only, "拿不到就别写");
        assert!(
            !serde_json::to_string(&rec).unwrap().contains("hostOnly"),
            "既然恒为 false，就不该出现在文件里",
        );
    }

    #[test]
    fn junk_cookies_are_recognised() {
        assert!(is_junk_cookie("_ga_ABC123"));
        assert!(is_junk_cookie("Hm_lvt_9f8"));
        assert!(!is_junk_cookie("session-token"));
        assert!(!is_junk_cookie("__Secure-next-auth.session-token"));
    }

    fn svc(id: &str, url: &str) -> Service {
        Service {
            id: id.into(),
            name: id.into(),
            url: url.into(),
            color: String::new(),
            icon: String::new(),
            custom: false,
            hidden: false,
        }
    }
    fn entry(id: &str, url: &str) -> ServiceEntry {
        ServiceEntry { id: id.into(), name: id.into(), url: url.into(), ..Default::default() }
    }

    #[test]
    fn matching_prefers_id_then_url_then_origin() {
        let services = vec![svc("a", "https://x.com/one"), svc("b", "https://x.com/two")];
        // id 命中
        let by_id = [entry("b", "https://zzz.com/")];
        assert_eq!(match_services(&by_id, &services).0[0].0.id, "b", "id 应该优先于网址");
        // id 不在，完整网址命中
        let by_url = [entry("zzz", "https://x.com/two")];
        assert_eq!(match_services(&by_url, &services).0[0].0.id, "b", "完整网址应该优先于同源");
        // 都不在，退回同源
        let by_origin = [entry("zzz", "https://x.com/three")];
        assert_eq!(match_services(&by_origin, &services).0[0].0.id, "a", "同源时取第一个没被占用的");
    }

    #[test]
    fn one_service_accepts_only_one_entry() {
        // 同源的两条不能都写进同一个服务，否则后一条会把前一条覆盖掉
        let services = vec![svc("a", "https://x.com/one")];
        let entries = vec![entry("p", "https://x.com/a"), entry("q", "https://x.com/b")];
        let (m, un) = match_services(&entries, &services);
        assert_eq!(m.len(), 1);
        assert_eq!(un.len(), 1, "多出来的那条应该报成未匹配，而不是静默丢弃");
    }

    #[test]
    fn origin_ignores_path_and_keeps_port() {
        assert_eq!(origin_of("https://x.com/a/b?c=1"), "https://x.com");
        assert_eq!(origin_of("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080");
        assert_eq!(origin_of("file:///tmp/x"), "");
        assert_eq!(origin_of("鬼画符"), "");
    }

    #[test]
    fn cookie_round_trips_through_the_file_shape() {
        let rec = CookieRec {
            name: "sid".into(),
            value: "v".into(),
            domain: Some(".x.com".into()),
            path: Some("/app".into()),
            secure: true,
            http_only: true,
            same_site: Some("lax".into()),
            host_only: false,
            expiration_date: Some(4102444800.0),
        };
        let c = to_cookie(&rec, "x.com").unwrap();
        assert_eq!(c.name(), "sid");
        assert_eq!(c.domain(), Some("x.com"), "cookie crate 会把前导点吃掉，这是正常的");
        assert_eq!(c.path(), Some("/app"));
        assert_eq!(c.same_site(), Some(cookie::SameSite::Lax));
        assert!(c.secure().unwrap_or(false) && c.http_only().unwrap_or(false));
    }

    #[test]
    fn cookie_without_domain_falls_back_to_the_service_host() {
        let rec = CookieRec { name: "a".into(), value: "b".into(), ..Default::default() };
        assert_eq!(to_cookie(&rec, "x.com").unwrap().domain(), Some("x.com"));
        assert!(to_cookie(&rec, "").is_err(), "两边都没有主机名时要明确报错");
    }

    #[test]
    fn expired_and_junk_cookies_are_dropped() {
        let mut expired = cookie::Cookie::new("sid", "v");
        expired.set_expires(cookie::time::OffsetDateTime::from_unix_timestamp(1000).unwrap());
        assert!(clean_cookie(&expired, 2000.0).is_none(), "过期的不该导出");
        assert!(clean_cookie(&cookie::Cookie::new("_ga_X", "v"), 0.0).is_none());
        assert!(clean_cookie(&cookie::Cookie::new("sid", "v"), 0.0).is_some());
    }
}
