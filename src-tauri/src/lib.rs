//! Aihub —— 把常用 AI 聊天站点聚合到一个窗口里。
//!
//! 从 Electron 迁过来的 Tauri 版。架构与 Electron 版同构：
//!   - 一个 Window，里面挂 N+1 个 webview
//!   - "shell"（index.html）铺满整窗，负责标签栏和设置面板
//!   - 每个站点一个 webview，叠在 shell 上面，从 content_top 往下摆
//!   - 每个站点一个独立的 WebView2 用户数据目录 => 登录态互不干扰
//!
//! 前端完全不知道自己换了运行时：src-ui/api-shim.js 用同一套 `window.api`
//! 方法名把调用转成 Tauri 的 invoke，所以 index.html 几乎没改。

pub mod commands;
pub mod config;
pub mod layout;
pub mod login;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod services;
pub mod topmost;
pub mod views;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, WindowEvent};

use crate::config::Config;
use crate::views::{ViewManager, MAIN_WINDOW};

pub struct AppState {
    pub config: Mutex<Config>,
    pub views: Mutex<ViewManager>,
    /// 「唤出时强制置顶」现在是不是真的加在窗口上。
    ///
    /// 只有它为 true 才需要去摘。没有这一位的时候每次失焦都无条件调一次摘置顶，
    /// 而那个调用本身会碰窗口的 z-order（见 topmost.rs 的长注释），
    /// 正好撞在用户点别的应用的那一刻。
    pub pinned: AtomicBool,
    /// 每次「唤出置顶 / 安排摘置顶」都 +1。
    /// 延时摘置顶的线程拿它判断自己是不是已经过期（期间又唤出、又失焦了）。
    pub pin_epoch: AtomicU64,
    /// 上一次把唤出置顶摘掉的时间（毫秒，0 = 没摘过）。
    /// 用来判断「刚让出前台又马上回来」要不要把置顶补回去。
    pub pin_released_at: AtomicU64,
}

impl AppState {
    /// 读一份配置快照。
    ///
    /// 刻意返回克隆而不是 guard：调用方拿到它之后往往要去碰窗口
    /// （add_child 会阻塞等主线程），握着锁过去就是死锁。
    pub fn snapshot(&self) -> Config {
        self.config.lock().expect("config 锁中毒").clone()
    }
}

/// Capture only normal window dimensions; OS minimized/zoomed sizes are temporary.
fn remember_window_size(app: &tauri::AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else { return };
    if window.is_minimized().unwrap_or(true)
        || window.is_maximized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true) { return; }
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
    let size = size.to_logical::<f64>(scale);
    app.state::<AppState>().config.lock().expect("config 锁中毒")
        .remember_window_size(size.width, size.height);
}

fn save_window_preferences(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let config = state.config.lock().expect("config 锁中毒");
    if let Err(err) = config::save(&config) {
        eprintln!("[aihub] 窗口设置保存失败: {err}");
    }
}

/// 把当前状态广播给外壳（对齐 Electron 版的 broadcast()）。
pub fn broadcast(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let config = state.snapshot();
    let payload = commands::state_payload(app, &config);
    let _ = app.emit("state:changed", payload);
}

/// 重新布局 + 把几何广播给外壳（外壳靠它画分隔条）。
///
/// 严格分三段，中间不跨锁：
///   1. 拿窗口尺寸（不需要锁）
///   2. 持锁算出一份 LayoutPlan（纯计算，不碰窗口）
///   3. 放锁后执行 plan（add_child 会阻塞等主线程，握着锁过去必死锁）
pub fn relayout(app: &tauri::AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else {
        return;
    };
    let Ok(size) = window.inner_size() else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = (size.width as f64 / scale).round() as i32;
    let height = (size.height as f64 / scale).round() as i32;

    let config = app.state::<AppState>().snapshot();

    // --- 第 2 段：持锁只做计算 ---
    let plan = {
        let state = app.state::<AppState>();
        let mut mgr = state.views.lock().expect("views 锁中毒");
        views::plan_layout(width, height, &config, &mut mgr)
    }; // <- 锁在这里放掉

    let Some(plan) = plan else {
        // 最小化时 Windows 会给出退化尺寸，跳过是正常行为，不用喊
        return;
    };

    // --- 第 3 段：无锁执行 ---
    let created = views::execute_plan(&window, &plan);
    if !created.is_empty() {
        eprintln!("[aihub] 新建站点视图: {created:?}");
    }

    if !created.is_empty() {
        let state = app.state::<AppState>();
        let mut mgr = state.views.lock().expect("views 锁中毒");
        for id in created {
            mgr.register(&id);
        }
    }

    let _ = app.emit(
        "layout:changed",
        serde_json::json!({
            "panes": plan.geometry.panes,
            "dividers": plan.geometry.dividers,
            "usable": plan.geometry.usable,
            "tabBarHeight": plan.top,
            "tabBarVisible": config.tab_bar_visible,
            "activeId": config.active_id,
            "weights": config.weights,
        }),
    );
}

/// 布局请求的发送端。
///
/// 所有布局都必须从后台线程驱动（add_child 会阻塞等主线程，见 relayout 的注释），
/// 而 resize 事件又很密集——每次开一个线程会瞬间炸出几百个。
/// 所以起**一条**长期存活的布局线程，所有请求排到它身上串行执行。
pub struct LayoutQueue(pub std::sync::mpsc::Sender<()>);

/// 启动布局线程，返回它的发送端。
fn spawn_layout_thread(app: tauri::AppHandle) -> std::sync::mpsc::Sender<()> {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // 把积压的请求一次性吃掉：连续拖动时只按最后一次状态排一遍就够了
            while rx.try_recv().is_ok() {}
            relayout(&app);
        }
    });
    tx
}

/// 请求一次重排（非阻塞，可以安全地从主线程调用）。
pub fn request_layout(app: &tauri::AppHandle) {
    if let Some(queue) = app.try_state::<LayoutQueue>() {
        let _ = queue.0.send(());
    }
}

/// 注册全局快捷键（老板键）。
///
/// Electron 用 `globalShortcut.register`，Tauri 走 global-shortcut 插件。
/// 加速键字符串两边语法基本一致（`Alt+Space`、`Ctrl+Shift+A`），所以配置能直接继承。
///
/// 返回注册失败的原因，供设置面板显示——**注册失败必须让用户看见**：
/// 快捷键被别的程序占了是很常见的事，静默失败会让人以为是应用坏了。
pub fn register_hotkey(app: &tauri::AppHandle, accelerator: &str, enabled: bool) -> Option<String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // 注册表的增删只能在主线程上做。插件里的 `unregister_all()` 是**先拿锁、
    // 再等主线程执行**（`run_main_thread!`），在别的线程上调就等于「握着锁等主线程」，
    // 一旦主线程这时正在热键回调里（它自己也持着那把锁）就是死锁。
    // 所以从别的线程过来的一律转投主线程，等它的结果。
    if !is_main_thread() {
        let handle = app.clone();
        let acc = accelerator.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        if app
            .run_on_main_thread(move || {
                let _ = tx.send(register_hotkey(&handle, &acc, enabled));
            })
            .is_err()
        {
            return None;
        }
        return rx.recv().unwrap_or(None);
    }

    let shortcut = app.global_shortcut();
    let _ = shortcut.unregister_all();
    // unregister_all 把「设置面板」那个也一起清掉了。
    // 不用自己记账：下面 `apply_settings_shortcut` 直接问插件注册表，
    // 补登记这件事交给工作线程。
    request_shortcut_sync(app);
    if !enabled || accelerator.trim().is_empty() {
        return None;
    }

    let handle = app.clone();
    let acc = accelerator.to_string();
    match shortcut.on_shortcut(accelerator, move |_app, _sc, event| {
        // 只认按下，不然按一次会触发两回（按下 + 抬起）
        if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
            return;
        }
        toggle_window(&handle);
    }) {
        Ok(()) => None,
        Err(err) => {
            let msg = format!("快捷键 {acc} 注册失败（多半是被别的程序占用了）：{err}");
            eprintln!("[aihub] {msg}");
            Some(msg)
        }
    }
}

/// 设置面板的快捷键：`Ctrl+,`（macOS 上是 `⌘,`）。
///
/// 为什么要在 Rust 里再注册一次：站点视图是叠在外壳之上的独立 webview，
/// 键盘焦点在站点那边时，外壳一个 keydown 都收不到——前端 `document` 上那个
/// 监听只有「刚点过标签栏 / 工具栏」时才有效，正常用着站点按下去毫无反应。
/// 所以在**窗口有焦点期间**把它临时挂成系统级快捷键，失焦立刻撤掉，
/// 不会在别的应用里抢这个组合键。
#[cfg(target_os = "macos")]
const SETTINGS_ACCELERATOR: &str = "Command+Comma";
#[cfg(not(target_os = "macos"))]
const SETTINGS_ACCELERATOR: &str = "Ctrl+Comma";

/// 加速键归一化，只用来判断「用户是不是把唤出键设成了同一个组合」。
fn same_accelerator(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        s.chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(|c| c.to_lowercase())
            .collect::<String>()
            .replace(',', "comma")
    }
    norm(a) == norm(b)
}

/// 本应用现在是不是用户正在用的那个程序。
///
/// 这里不能用 `window.is_focused()`：一个窗口里叠着 N+1 个 webview（外壳 + 每个站点），
/// 键盘焦点落在哪个子窗口上由 WebView2 自己管，winit 的窗口级焦点会跟着抖——
/// 面板开合、站点视图显隐、切到另一个标签，都会让它变成 false。
/// 用它来决定要不要注册，就会出现「明明正用着应用，Ctrl+, 忽然没反应」。
///
/// 真正需要的条件只有一个：前台窗口属于本进程。站点 webview 拿到焦点时，
/// 前台窗口是它的子窗口，进程号仍然是我们的，判得对。
#[cfg(windows)]
fn app_is_foreground(_app: &tauri::AppHandle) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    // SAFETY: 两个调用都只读系统状态，不碰调用方管理的内存。
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid == std::process::id()
    }
}

/// macOS 上多个 webview 是同一个 NSWindow 里的 NSView，窗口焦点状态是可靠的。
#[cfg(not(windows))]
fn app_is_foreground(app: &tauri::AppHandle) -> bool {
    app.get_window(MAIN_WINDOW)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

/// 主线程 id（`run()` 就是在主线程上跑的）。
///
/// 只用来判断「我现在是不是在主线程」。Tauri 没有公开这个接口，而它在这里
/// 是安全性的前提：见 `spawn_shortcut_sync_worker` 的长注释。
static MAIN_THREAD_ID: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

fn is_main_thread() -> bool {
    MAIN_THREAD_ID
        .get()
        .map(|id| *id == std::thread::current().id())
        .unwrap_or(false)
}

/// 注册失败的报错只报一次，别在每次焦点变化时刷屏。
static SETTINGS_SHORTCUT_ERR: AtomicBool = AtomicBool::new(false);

/// 请求重新摆一次「设置面板」快捷键的队列。
pub struct ShortcutSync(pub std::sync::mpsc::Sender<()>);

/// 改快捷键注册表这件事，为什么必须挪出主线程。
///
/// global-shortcut 在 Windows 上是「在主线程建一个隐藏窗口，WM_HOTKEY 直接
/// 派发到这个窗口的 wndproc」——也就是**回调本身就在主线程上跑**，而且插件
/// 派发时是持着自己的注册表锁进来调我们的闭包的：
///
/// ```text
/// GlobalHotKeyEvent::set_event_handler(|e| {
///     shortcuts_.lock().unwrap().get(&e.id)      // <- 锁一直握到闭包返回
///         .map(|s| s.handler(...))
/// })
/// ```
///
/// 而 `unregister` / `on_shortcut` 要拿**同一把**锁。std 的 Mutex 不可重入，
/// 同一线程重入就是永久卡死。于是下面这条路径会在按老板键隐藏窗口时必崩：
///
/// ```text
/// 主线程：WM_HOTKEY -> 插件回调（持锁）-> toggle_window -> hide()
///         -> 失焦事件 -> sync -> unregister -> 同一把锁 -> 死锁
/// ```
///
/// 死锁点在 `hide()` 之后、消息泵还没跑起来的时候，所以窗口会留在屏幕上变成
/// 「未响应」——正是用户看到的那张截图。
///
/// 还有个更隐蔽的坑：`app.run_on_main_thread()` 在**主线程上调用时不排队，
/// 当场内联执行**（tauri-runtime-wry 的 `send_user_message` 对主线程走快路径）。
/// 所以「投到主线程去同步」根本绕不开这个死锁，反而看起来像已经处理过了。
///
/// 结论：所有 `unregister` / `on_shortcut` 只在**这条独立工作线程**上做。
/// 主线程只往队列里丢一张单子（不阻塞、不持锁），丢完立刻返回，插件回调
/// 安然结束、放锁，之后工作线程再怎么拆装都不会和回调撞上。
fn spawn_shortcut_sync_worker(app: tauri::AppHandle) -> std::sync::mpsc::Sender<()> {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // 焦点切换会连发好几次请求；等一小会儿把攒下的单子合成一次，
            // 免得系统级快捷键被反复拆装。
            std::thread::sleep(SHORTCUT_SYNC_DEBOUNCE);
            while rx.try_recv().is_ok() {}
            apply_settings_shortcut(&app);
        }
    });
    tx
}

/// 焦点事件密集时用来合并请求的等待时间。
const SHORTCUT_SYNC_DEBOUNCE: Duration = Duration::from_millis(40);

/// 请求一次「设置面板」快捷键的对齐。
///
/// **只入队，不阻塞、不碰快捷键注册表**——这是它可以被主线程、被插件回调、
/// 被 IPC 命令随便调的原因。真正的拆装见 `apply_settings_shortcut`。
pub fn request_shortcut_sync(app: &tauri::AppHandle) {
    if let Some(queue) = app.try_state::<ShortcutSync>() {
        let _ = queue.0.send(());
    }
    // 队列还没装上（只可能发生在 setup 极早期）：什么都不做。
    // 窗口拿到焦点后一定会再请求一次，没必要在这里抢着同步。
}

/// 真正动手拆装「设置面板」快捷键（**只允许在工作线程上调用**）。
///
/// `register_hotkey` 里那句 `unregister_all()` 会把这张注册表清空，
/// 所以那边改完也要请求一次这个，谁也别把谁登记的东西弄丢。
fn apply_settings_shortcut(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    debug_assert!(
        !is_main_thread(),
        "改快捷键注册表必须在工作线程上做，主线程上会撞上插件回调持有的锁"
    );

    // 用户把唤出键也设成了同一个组合时让唤出优先，别互相覆盖
    let cfg = app.state::<AppState>().snapshot();
    let conflict = cfg.hotkey.enabled && same_accelerator(&cfg.hotkey.accelerator, SETTINGS_ACCELERATOR);

    let want = app_is_foreground(app) && !conflict;
    // 闸门状态直接问插件：「这个组合现在挂在我们的注册表里吗」。
    // 比自己在旁边记一个 bool 可靠——那边被 unregister_all() 清空时它自己是知道的，
    // 我们记的那位却会停在 true 上，于是永远不再补登记。
    let shortcut = app.global_shortcut();
    let on = shortcut.is_registered(SETTINGS_ACCELERATOR);
    if want == on {
        return;
    }

    if !want {
        let _ = shortcut.unregister(SETTINGS_ACCELERATOR);
        return;
    }

    let handle = app.clone();
    match shortcut.on_shortcut(SETTINGS_ACCELERATOR, move |_app, _sc, event| {
        if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
            return;
        }
        // 面板开合由外壳自己处理（它同时负责让站点视图让位）
        let _ = handle.emit("ui:open-settings", ());
        // 焦点原来在站点视图上，面板一开站点就被藏起来了。
        // 把键盘焦点交给外壳，否则 Esc 和 Tab 会落在一个看不见的窗口上。
        if let Some(window) = handle.get_window(MAIN_WINDOW) {
            if let Some(shell) = window.get_webview(views::SHELL_LABEL) {
                let _ = shell.set_focus();
            }
        }
    }) {
        Ok(()) => {
            SETTINGS_SHORTCUT_ERR.store(false, Ordering::Relaxed);
            // 只在开发构建里说一声：切出切回都会走一次，release 版没必要刷屏
            #[cfg(debug_assertions)]
            eprintln!("[aihub] 设置快捷键 {SETTINGS_ACCELERATOR} 已就绪");
        }
        Err(err) => {
            if !SETTINGS_SHORTCUT_ERR.swap(true, Ordering::Relaxed) {
                eprintln!("[aihub] 设置快捷键 {SETTINGS_ACCELERATOR} 注册失败: {err}");
            }
        }
    }
}

/// 「唤出置顶」这一刻该不该管：用户的「唤出时强制置顶」和「常驻置顶」是两件事，
/// 常驻开着的时候整层置顶归常驻管，唤出那套不许插手。
fn should_manage_summon_pin(config: &Config) -> bool {
    config.hotkey.pin_top && !config.always_on_top
}

/// 唤出：抬到最高层，并记住「这一层是我们加的」。
fn pin_on_summon(app: &tauri::AppHandle, window: &tauri::Window) {
    let state = app.state::<AppState>();
    // 先抬 epoch：上一轮排着的「摘置顶」立刻作废
    state.pin_epoch.fetch_add(1, Ordering::SeqCst);
    if !topmost::pin(window) {
        eprintln!("[aihub] 唤出置顶没生效（系统拒绝了 SetWindowPos）");
        return;
    }
    state.pinned.store(true, Ordering::SeqCst);
    // 已经重新抬起来了，作废任何「补置顶」的凭据
    state.pin_released_at.store(0, Ordering::SeqCst);
}

/// 让出前台 / 收起窗口：把这一层置顶摘掉。
///
/// `force` 为 false 时，本来就没加过就什么都不做——每一次空转的调用都是在改
/// z-order，都可能把用户刚点开的窗口搅黄。
pub(crate) fn release_summon_pin(app: &tauri::AppHandle, force: bool) {
    let state = app.state::<AppState>();
    state.pin_epoch.fetch_add(1, Ordering::SeqCst);
    // 主动收起 / 主动让位是我们自己的决定，不参与「刚放掉又回来」的补置顶
    state.pin_released_at.store(0, Ordering::SeqCst);
    if !state.pinned.swap(false, Ordering::SeqCst) && !force {
        return;
    }
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        // 收起 / 主动让位：前台是谁都不重要，立刻办，不等
        if !topmost::release(&window, false) {
            eprintln!("[aihub] 取消唤出置顶失败（可忽略）");
        }
    }
}

/// 失焦后摘置顶的节奏。
///
/// 分两条路，绝大多数情况走第一条：
///   - **快路径**：当场就放。实测失焦消息到达时，系统报告的当前前台窗口**已经**
///     是用户点的那个了（探针：`WM_ACTIVATE(WA_INACTIVE)` 触发瞬间
///     `GetForegroundWindow()` 就是目标窗口），所以一次 `SetWindowPos` 就能
///     把它插到目标窗口下面，不需要任何等待。
///   - **慢路径**：万一前台还没落地（`release` 返回 false），隔十几毫秒再问，
///     最多追到 `CAP`。硬放的话窗口会插到普通层顶部，正好盖住用户刚点的应用。
///
/// `CAP` 只是兜底，宁可位置不完美也不能让置顶一直压着别人。
const PIN_RELEASE_RETRY: Duration = Duration::from_millis(16);
const PIN_RELEASE_CAP: Duration = Duration::from_millis(120);

/// 窗口刚失焦：摘置顶。抢回来的动画帧都还没过就办完了，用户感觉不到延迟。
fn schedule_pin_release(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if !should_manage_summon_pin(&state.snapshot()) {
        return; // 常驻置顶自己会管，别动
    }
    if !state.pinned.load(Ordering::SeqCst) {
        return; // 没加过，不用摘
    }

    // 认领这一轮：后面任何一次唤出 / 失焦都会让这个号作废
    let epoch = state.pin_epoch.fetch_add(1, Ordering::SeqCst) + 1;

    // 快路径：当场放，连线程都不用开
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        if topmost::release(&window, true) {
            state.pinned.store(false, Ordering::SeqCst);
            state.pin_released_at.store(now_ms(), Ordering::SeqCst);
            return;
        }
    }

    // 慢路径：前台还没落地，追几拍
    let handle = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + PIN_RELEASE_CAP;
        loop {
            let state = handle.state::<AppState>();
            if state.pin_epoch.load(Ordering::SeqCst) != epoch {
                return; // 期间又唤出/又失焦了，这一单作废
            }
            let Some(window) = handle.get_window(MAIN_WINDOW) else { return };
            if window.is_focused().unwrap_or(false) {
                return; // 又回来了，保持置顶
            }

            // 追到上限就别等了：宁可位置不完美，也不能让置顶一直压着别人
            let last_chance = Instant::now() >= deadline;
            if topmost::release(&window, !last_chance) || last_chance {
                state.pinned.store(false, Ordering::SeqCst);
                state.pin_released_at.store(now_ms(), Ordering::SeqCst);
                return;
            }
            std::thread::sleep(PIN_RELEASE_RETRY);
        }
    });
}

/// 刚让出前台又立刻回来了（比如 Alt+Tab 过去瞟一眼就切回、或者被系统通知
/// 闪了一下）：把置顶补回去，别让一次一过性的失焦把置顶弄丢。
///
/// 这个「补回来」的窗口期和 Electron 版 250ms 防抖是同一个意思，区别只是
/// 那版是「先等着不放」，这里是「先放、马上回来就再抬一次」——前者会让人
/// 看着窗口压在新应用上面，后者不会。
const PIN_RESTORE_WINDOW: u64 = 250;

fn restore_pin_if_bounced_back(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if !should_manage_summon_pin(&state.snapshot()) {
        return;
    }
    if state.pinned.load(Ordering::SeqCst) {
        return; // 还在，不用补
    }
    let released_at = state.pin_released_at.load(Ordering::SeqCst);
    if released_at == 0 || now_ms().saturating_sub(released_at) > PIN_RESTORE_WINDOW {
        return; // 不是刚放掉的那一次
    }
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        pin_on_summon(app, &window);
        state.pin_released_at.store(0, Ordering::SeqCst);
    }
}

/// 单调毫秒数，只用来比先后。
fn now_ms() -> u64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// 把窗口唤到最前：老板键、托盘、第二次启动都走这里。
///
/// 「唤出时置顶」只在这一下抬，窗口让出前台后由 `schedule_pin_release` 放下。
pub(crate) fn summon_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else { return };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();

    // 注意这跟常驻置顶（config.always_on_top）是两件事——
    // 常驻置顶已经开着时不用管，没开才需要临时抬一下。
    if should_manage_summon_pin(&app.state::<AppState>().snapshot()) {
        pin_on_summon(app, &window);
    } else {
        // 没开唤出置顶：顺手清掉可能残留的那一层（比如上次没摘干净）
        release_summon_pin(app, false);
    }

    // 窗口重新拿到焦点时会有 Focused(true) 事件，交给那里去补登记。
    // 这里补一次也无害——`request_shortcut_sync` 只是入队，不会在插件回调栈里
    // 碰注册表（见 spawn_shortcut_sync_worker 的注释）。
    request_shortcut_sync(app);
}

/// 老板键的行为：在前台就收起，不在前台就唤到最前。
fn toggle_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else { return };
    let config = app.state::<AppState>().snapshot();

    let visible = window.is_visible().unwrap_or(false);
    // 同理不能用 window.is_focused()：焦点在站点视图上时窗口级焦点可能是 false，
    // 于是「想收起」被当成「不在前台」，又唤出一次，看着像没反应。
    let active = app_is_foreground(app);

    if config.hotkey.action == "toggle" && visible && active {
        // 收起之前先把唤出置顶摘掉：藏起来的窗口还挂着最高层，下次唤出的状态就乱了
        release_summon_pin(app, false);
        let _ = window.hide();
        // 收起来就不该再占着 Ctrl+,。只入队，真正的注销由工作线程去做——
        // 这里还在快捷键插件的回调栈上（Windows 上就是主线程），
        // 当场调 unregister 会撞上插件自己持有的注册表锁（见 spawn_shortcut_sync_worker）。
        request_shortcut_sync(app);
        return;
    }

    summon_window(app);
}

/// 托盘图标：窗口收进后台之后仍然有一个能点回来的入口。
///
/// 左键点图标 = 唤出/收起，右键菜单里有「显示」「显示 / 隐藏标签栏」「退出」。
/// 退出必须在这里给一条明路——`close_to_tray` 开着时点关闭按钮只是隐藏，
/// 没有托盘菜单的话用户就只能去任务管理器杀进程了。
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示 Aihub", true, None::<&str>)?;
    // 标签栏收起来之后，外壳整块被站点页面盖住，设置面板再也点不开——
    // 托盘菜单是唯一还能把标签栏放回来的入口（macOS 上就是菜单栏图标）。
    let toggle_bar = MenuItem::with_id(app, "toggle-bar", "显示 / 隐藏标签栏", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle_bar, &quit])?;

    TrayIconBuilder::with_id("aihub-tray")
        .icon(app.default_window_icon().cloned().ok_or(tauri::Error::WebviewNotFound)?)
        .tooltip("Aihub")
        .menu(&menu)
        // 左键点击不要弹菜单，让它走下面的 on_tray_icon_event 去唤窗口
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => summon_window(app),
            "toggle-bar" => commands::toggle_tab_bar(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 这一刻托盘图标是不是必须存在。
///
/// 单独抽出来是为了能单测：这条不变式一破，用户就会掉进「什么都点不到」的状态。
fn tray_needed(config: &Config) -> bool {
    config.hotkey.tray || config.hotkey.close_to_tray || !config.tab_bar_visible
}

/// 托盘图标的开关要跟着「有没有东西被藏起来」走，而不是只跟着用户那个设置。
///
/// 托盘是唯一一条常驻的回头路：标签栏收起来之后外壳被站点页面整块盖住，
/// 设置面板点不开；`close_to_tray` 开着时点关闭只是把窗口藏了。
/// 这两件事只要有一件成立就得有托盘图标，否则用户会掉进一个
/// 「什么都点不到、只能去杀进程」的状态——macOS 上收起标签栏回不去就是这一类。
///
/// 用 `hotkey.tray` 这个设置决定「没藏东西时要不要常驻」；藏了东西时即使
/// 用户把那个设置关了也会临时把图标挂出来，东西放回去就还给用户。
pub fn ensure_tray(app: &tauri::AppHandle) {
    let cfg = app.state::<AppState>().snapshot();
    let needed = tray_needed(&cfg);
    let exists = app.tray_by_id("aihub-tray").is_some();

    match (needed, exists) {
        (true, false) => match build_tray(app) {
            // 这条日志是「回头路还在不在」的凭据：收起标签栏时它必须打出来。
            Ok(()) => eprintln!("[aihub] 托盘图标已就绪"),
            Err(err) => eprintln!("[aihub] 托盘图标创建失败: {err}"),
        },
        (false, true) => {
            app.remove_tray_by_id("aihub-tray");
            eprintln!("[aihub] 托盘图标已收起（没有东西藏着，用户也把常驻关了）");
        }
        _ => {}
    }
}

/// 后台标签休眠的扫描线程。
///
/// 闲置久了就把后台标签的 webview 关掉，把渲染进程还给系统；点回去时
/// apply_layout 会按 last_urls 里记的地址重建。对齐 Electron 版的 sweepIdle()。
///
/// 和布局一样跑在后台线程上：关 webview 同样要经过主线程。
fn spawn_hibernate_thread(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));

        let config = app.state::<AppState>().snapshot();
        if !config.hibernate.enabled {
            continue;
        }

        // 屏幕上正显示的那几栏永远不回收——不该在用户眼前把页面弄没
        let visible: Vec<String> = config.panes.clone();
        let idle = {
            let state = app.state::<AppState>();
            let mgr = state.views.lock().expect("views 锁中毒");
            mgr.idle_candidates(&visible, config.hibernate.minutes)
        }; // 放锁再去碰窗口

        if idle.is_empty() {
            continue;
        }
        let Some(window) = app.get_window(MAIN_WINDOW) else { continue };

        for id in idle {
            // 输入框里有没发出去的草稿就别动它——这是 Electron 版就有的保护，
            // 睡掉一个写了一半的提问比省那点内存糟糕得多。
            if has_unsent_draft(&window, &id) {
                continue;
            }
            let hibernated = {
                let state = app.state::<AppState>();
                let mut mgr = state.views.lock().expect("views 锁中毒");
                views::hibernate(&window, &mut mgr, &id)
            };
            if hibernated {
                eprintln!("[aihub] 休眠后台标签: {id}");
                let _ = app.emit("tab:status", serde_json::json!({
                    "id": id, "hibernated": true, "loading": false, "error": null,
                }));
            }
        }
        broadcast(&app);
    });
}

/// 这个标签的输入框里有没有没发出去的内容。
///
/// Tauri 的 `eval()` 是 fire-and-forget 拿不到返回值，要用带 callback 的变体。
/// Windows 上 JS 异常会被吞掉，所以脚本自己包一层 try/catch。
fn has_unsent_draft(window: &tauri::Window, id: &str) -> bool {
    use std::sync::mpsc::channel;

    let Some(view) = window.get_webview(&views::view_label(id)) else {
        return false;
    };
    let (tx, rx) = channel();
    let js = r#"(() => { try {
        const sel = 'textarea, [contenteditable="true"], input[type="text"]';
        for (const el of document.querySelectorAll(sel)) {
            const v = (el.value !== undefined ? el.value : el.innerText) || '';
            if (v.trim().length > 0) return true;
        }
        return false;
    } catch (e) { return false; } })()"#;

    if view.eval_with_callback(js, move |res| { let _ = tx.send(res); }).is_err() {
        return false;
    }
    // 拿不到答复时保守处理：当作有草稿，不回收。
    // 宁可多留一个进程，也不要弄丢用户写了一半的东西。
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(v) => v.trim() == "true",
        Err(_) => true,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 记下主线程：`is_main_thread()` 和快捷键工作线程靠它守边界，越早记越好。
    let _ = MAIN_THREAD_ID.set(std::thread::current().id());

    let mut config = config::load();
    // 上次删服务时勾了「清除登录数据」的，现在目录没被占用，可以真的删了
    if !config.pending_wipe.is_empty() {
        config.pending_wipe = config::wipe_pending(&config.pending_wipe);
    }
    // normalize() 只在内存里补齐字段。启动时立刻回写一次，把升级结果落盘：
    // 否则老用户装上新版却什么都不改，配置文件会一直停在 v3，
    // 每次启动都要重算一遍迁移，而且文件内容和实际生效的状态对不上。
    if let Err(err) = config::save(&config) {
        eprintln!("[aihub] 启动时回写配置失败: {err}");
    }
    let always_on_top = config.always_on_top;
    // Windows 上置顶不由 tao 管（原因见 topmost.rs 的长注释）：
    // 窗口一律建在非置顶状态，建完立刻用 Win32 抬一次。
    // 这样 tao 内部的 ALWAYS_ON_TOP 标记永远保持 false——既不会和真实状态错位，
    // 也不会在后续任何一次窗口标志变化里把置顶「恢复」回来。
    let tao_always_on_top = !cfg!(windows) && always_on_top;
    let window_size = config.window_size.unwrap_or(config::WindowSize { width: 1280.0, height: 820.0 });
    // 窗口一建出来就得带上上次选的主题，否则启动瞬间是「跟随系统」，
    // 要等用户再点一次设置才纠正过来（见 commands::apply_theme 的注释）。
    let start_theme = commands::native_theme(&config.theme);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二次启动就把已经在跑的那个唤到前面来，而不是开第二个窗口
            summon_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            config: Mutex::new(config),
            views: Mutex::new(ViewManager::default()),
            pinned: AtomicBool::new(false),
            pin_epoch: AtomicU64::new(0),
            pin_released_at: AtomicU64::new(0),
        })
        .invoke_handler(commands::handler())
        .setup(move |app| {
            let handle = app.handle().clone();

            // 快捷键注册表的增删全部收口到这条线程（原因见 spawn_shortcut_sync_worker）。
            // 必须赶在下面 register_hotkey 之前装好，否则启动那一次请求会落空。
            app.manage(ShortcutSync(spawn_shortcut_sync_worker(handle.clone())));

            let window = tauri::window::WindowBuilder::new(app, MAIN_WINDOW)
                .title("Aihub")
                .inner_size(window_size.width, window_size.height)
                .min_inner_size(layout::MIN_SANE_WIDTH as f64, layout::MIN_SANE_HEIGHT as f64)
                .center()
                // 主题跟着配置走：None = 跟随系统。
                // 这里给的是「偏好」，外壳 webview 建出来时就会带上它，
                // 所以第一帧的配色和 logo 变体就是对的。
                .theme(start_theme)
                // 功能 1：常驻置顶，默认开启。
                // Windows 上走 topmost::pin（SetWindowPos(HWND_TOPMOST)），
                // 是系统层面的置顶，不是应用内的 z-order；见上面 tao_always_on_top 的注释。
                .always_on_top(tao_always_on_top)
                .build()?;

            #[cfg(windows)]
            if always_on_top && !topmost::pin(&window) {
                eprintln!("[aihub] 常驻置顶没生效（系统拒绝了 SetWindowPos）");
            }

            // macOS 上内容视图默认铺满整个窗口框（系统标题栏压在内容顶上），
            // 44px 的标签栏会被盖掉大半。必须在建 webview 之前摘掉：内容区由此
            // 从标题栏下方开始，下面 create_shell 拿到的尺寸才是对的。
            #[cfg(target_os = "macos")]
            match macos::pin_content_below_titlebar(&window) {
                Ok(true) => eprintln!("[aihub] 已把内容区拉回系统标题栏下方"),
                Ok(false) => {}
                Err(err) => {
                    eprintln!("[aihub] 摘 FullSizeContentView 失败，标签栏会被标题栏压住: {err}")
                }
            }

            let size = window.inner_size()?;
            let scale = window.scale_factor().unwrap_or(1.0);
            let w = size.width as f64 / scale;
            let h = size.height as f64 / scale;
            eprintln!("[aihub] 窗口就绪 {w}x{h} scale={scale}");

            // 内外尺寸差是「内容区有没有被系统标题栏压住」的信号，故意留在日志里：
            // macOS 上两者相等 = 内容视图铺满整个窗口框，系统标题栏压在内容顶上，
            // 顶部 44px 的标签栏会被吃掉一大截（见 macos.rs）。一眼就能看出来。
            if let (Ok(outer), Ok(outer_pos), Ok(inner_pos)) =
                (window.outer_size(), window.outer_position(), window.inner_position())
            {
                eprintln!(
                    "[aihub] 窗口几何 inner={}x{} outer={}x{} outerPos=({},{}) innerPos=({},{})",
                    size.width, size.height, outer.width, outer.height,
                    outer_pos.x, outer_pos.y, inner_pos.x, inner_pos.y
                );
            }
            match views::create_shell(&window, w, h) {
                Ok(_) => eprintln!("[aihub] 外壳 webview 已创建"),
                Err(err) => {
                    eprintln!("[aihub] 外壳创建失败: {err}");
                    return Err(err.into());
                }
            }

            // 窗口尺寸一变就重排所有站点视图。
            // multiwebview 是 unstable 特性，已知在反复 resize / 最大化还原之后
            // 子 webview 位置会飘（tauri#10131 / #11170），所以这里不依赖
            // auto_resize，每次事件都用几何重算一遍绝对坐标压回去。
            //
            // 这个回调跑在主线程上，所以只能往布局线程投一张单子，不能直接排版。
            let resize_handle = handle.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    remember_window_size(&resize_handle);
                    request_layout(&resize_handle);
                }
                WindowEvent::Moved(_) => request_layout(&resize_handle),
                WindowEvent::Focused(false) => {
                    // 窗口让出前台：把快捷键唤出时临时抬起的置顶放下。
                    // 当场放，不等待——见 schedule_pin_release 的注释。
                    schedule_pin_release(&resize_handle);
                    // 失焦就别再占着 Ctrl+, 了，否则会在别的应用里抢这个键
                    request_shortcut_sync(&resize_handle);
                }
                WindowEvent::Focused(true) => {
                    // 刚让出前台又立刻回来了：置顶补回去，别被一次闪烁弄丢
                    restore_pin_if_bounced_back(&resize_handle);
                    // 拿回焦点期间接管 Ctrl+,（站点视图盖着外壳时只有它能收到）
                    request_shortcut_sync(&resize_handle);
                }
                WindowEvent::CloseRequested { api, .. } => {
                    save_window_preferences(&resize_handle);
                    // 「点关闭收进后台」：拦下来只隐藏，留着让快捷键随时唤回。
                    // 真正退出走托盘菜单或设置里的退出。
                    let cfg = resize_handle.state::<AppState>().snapshot();
                    if cfg.hotkey.close_to_tray {
                        api.prevent_close();
                        // 藏起来之前先摘置顶，否则它会以最高层藏在后台，
                        // 下次唤出时「这一层是谁加的」就对不上了。
                        release_summon_pin(&resize_handle, false);
                        if let Some(w) = resize_handle.get_window(MAIN_WINDOW) {
                            let _ = w.hide();
                        }
                        // 收进托盘就不再占着 Ctrl+, 了，免得在别的应用里抢键
                        request_shortcut_sync(&resize_handle);
                    }
                }
                _ => {}
            });

            // 全局快捷键（老板键）。注册失败的原因要能传到设置面板上。
            {
                let cfg = handle.state::<AppState>().snapshot();
                register_hotkey(&handle, &cfg.hotkey.accelerator, cfg.hotkey.enabled);
                ensure_tray(&handle);
            }

            // 窗口刚建出来、还没真正显示时，前台状态是「未激活」，上面那次同步会跳过。
            // 而 Focused 事件有可能早于 on_window_event 注册就已经发生过了，
            // 结果就是应用明明就在眼前，Ctrl+, 却一直没注册上。
            // 等窗口露出来之后再补一次，之后就交给焦点事件维持。
            let boot_shortcut = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(700));
                request_shortcut_sync(&boot_shortcut);
            });

            // 布局必须从后台线程驱动（add_child 会阻塞等主线程），
            // 起一条串行的布局线程收口所有请求。
            app.manage(LayoutQueue(spawn_layout_thread(handle.clone())));

            let boot = handle.clone();
            std::thread::spawn(move || {
                relayout(&boot);
                broadcast(&boot);
            });

            // 后台标签休眠的扫描线程
            spawn_hibernate_thread(handle.clone());

            // 自检：AIHUB_SELFTEST=<脚本路径> 时，等外壳就绪后在里面跑一遍那个脚本。
            // 脚本的返回值回不来（WKWebView 的 evaluateJavaScript 不等 promise），
            // 所以结论由脚本调 debug_note 打到 stderr。
            // 现在拖拽分屏也走这条链路（tools/tauri-drag-selftest.js）。
            #[cfg(debug_assertions)]
            if let Ok(path) = std::env::var("AIHUB_SELFTEST") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    match std::fs::read_to_string(&path) {
                        Ok(js) => match commands::debug_eval(h, js, None) {
                            Ok(out) => println!("[selftest] {out}"),
                            Err(err) => println!("[selftest] 失败: {err}"),
                        },
                        Err(err) => println!("[selftest] 读不到脚本 {path}: {err}"),
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Aihub 启动失败")
        .run(|app, event| {
            // macOS Cmd+Q can emit Exit directly, without ExitRequested.
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                save_window_preferences(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_tab_bar_always_leaves_a_way_back() {
        let mut cfg = Config::default();
        cfg.hotkey.tray = false;
        cfg.hotkey.close_to_tray = false;
        assert!(!tray_needed(&cfg), "什么都没藏起来时，托盘图标该听用户设置");

        // 收起标签栏之后，外壳整块被站点页面盖住，设置面板再也点不开——
        // 这时候没有托盘图标就等于没有回头路（macOS 上真实踩到过）。
        cfg.tab_bar_visible = false;
        assert!(tray_needed(&cfg), "收起标签栏后必须有托盘图标，否则没有入口放回来");
    }

    #[test]
    fn close_to_tray_also_requires_the_tray() {
        let mut cfg = Config::default();
        cfg.hotkey.tray = false;
        cfg.hotkey.close_to_tray = true;
        assert!(tray_needed(&cfg), "点关闭只隐藏时，托盘是唯一能把窗口找回来的入口");
    }

    #[test]
    fn settings_accelerator_parses() {
        // 常量写错了会在运行时静默注册失败，只有用户按下去才发现没反应。
        use std::str::FromStr;
        let parsed = tauri_plugin_global_shortcut::Shortcut::from_str(SETTINGS_ACCELERATOR);
        assert!(parsed.is_ok(), "{SETTINGS_ACCELERATOR} 解析失败: {:?}", parsed.err());
    }

    #[test]
    fn settings_accelerator_matches_hotkey_spellings() {
        // 配置里那个组合键来自用户输入，写法五花八门；
        // 判断「唤出键是不是也被设成了 Ctrl+,」必须认得这些等价写法。
        assert!(same_accelerator("Ctrl+,", "Ctrl+Comma"));
        assert!(same_accelerator("ctrl + ,", "Ctrl+Comma"));
        assert!(same_accelerator("Ctrl+,".trim(), "Ctrl+Comma"));
        // 不是同一个键就不能判等，否则会把用户的唤出键误当成冲突
        assert!(!same_accelerator("Ctrl+.", "Ctrl+Comma"));
        assert!(!same_accelerator("Ctrl+Shift+,", "Ctrl+Comma"));
        assert!(!same_accelerator("Alt+Space", "Ctrl+Comma"));
    }

    #[test]
    fn explicit_tray_setting_is_respected() {
        let cfg = Config::default();
        assert!(cfg.hotkey.tray, "托盘图标默认开着");
        assert!(tray_needed(&cfg));
    }

    #[test]
    fn summon_pin_steps_aside_when_always_on_top_takes_over() {
        // 常驻关着、唤出置顶开着 —— 这一层归唤出管（用户报的那个场景就停在这）
        let mut cfg = Config::default();
        cfg.always_on_top = false;
        assert!(cfg.hotkey.pin_top, "唤出置顶默认开着");
        assert!(should_manage_summon_pin(&cfg));

        // 常驻置顶开着（默认值就是这个）：整层置顶归常驻，唤出不许插手，
        // 否则「让出前台」会把用户要的常驻置顶一起摘掉
        let cfg = Config::default();
        assert!(cfg.always_on_top, "常驻置顶默认开着");
        assert!(!should_manage_summon_pin(&cfg), "常驻置顶开着时不许动置顶");

        // 唤出置顶被用户关掉：什么都不做
        let mut cfg = Config::default();
        cfg.always_on_top = false;
        cfg.hotkey.pin_top = false;
        assert!(!should_manage_summon_pin(&cfg), "用户关了唤出置顶就不该再去抬");
    }
}
