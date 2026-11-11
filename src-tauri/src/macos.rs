//! macOS 专用的窗口修正：把内容区拉回系统标题栏下方。
//!
//! ## 为什么要这么干
//!
//! Tauri 在 macOS 上建窗口走 `TitleBarStyle::Visible`，而 tauri-runtime-wry
//! 在这一支里顺手打开了 `NSWindowStyleMaskFullSizeContentView`
//! （为了绕开 tauri#3914：开着 devtools 缩放窗口会渲染错位）。
//!
//! 打开之后，窗口的**内容视图是铺满整个窗口框的**，可系统标题栏还是那条
//! 不透明的：它直接压在窗口内容顶上。本应用因此有两个症状（Windows 上
//! 内容区本来就在标题栏下方，所以只有 mac 会这样）：
//!
//! - 外壳那条 44px 的标签栏从窗口顶边开始画，顶上约 28px 被标题栏盖住，
//!   整条只露出最下面十几 px；
//! - 收起标签栏之后站点页面从 y=0 开始，页面自己的顶栏同样被盖掉 28px，
//!   而且那 28px 的点击全被标题栏吃掉。
//!
//! ## 修法
//!
//! 窗口建好、webview 还没建之前，把这一位从 styleMask 里摘掉。AppKit 随即
//! 把内容视图缩到标题栏下方，窗口在屏幕上占的框大小不变——那 28px 本来也
//! 不属于内容区（被标题栏盖着），现在只是账对上了：标签栏完整露出来，
//! 页面顶部 44px 里也不再有「看着在、点不到」的死区。
//!
//! 代价：tauri#3914 那个「开着 devtools 缩放错位」的老问题会回来。
//! 只在开着 devtools 时才有，日常使用无感；要调页面时把下面这个调用
//! 临时注掉即可。

use objc2::AnyThread;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSImage, NSWindow, NSWindowStyleMask};
use objc2_foundation::NSData;

/// 摘掉窗口的 FullSizeContentView 位。
///
/// 返回 `true` 表示确实摘了（原来带着这一位）。没带就是无事发生。
pub fn pin_content_below_titlebar(window: &tauri::Window) -> tauri::Result<bool> {
    // ns_window() 给的是窗口存活期间有效的 NSWindow 指针。AppKit 的对象只能
    // 在主线程碰，而这个函数是在 setup 里调的——Tauri 保证 setup 跑在主线程上。
    let ns_window = window.ns_window()? as *mut NSWindow;
    // SAFETY: 主线程 + 窗口此刻一定还活着（刚 build 出来）。
    let ns_window = unsafe { &*ns_window };

    let mask = ns_window.styleMask();
    if !mask.contains(NSWindowStyleMask::FullSizeContentView) {
        return Ok(false);
    }
    ns_window.setStyleMask(mask & !NSWindowStyleMask::FullSizeContentView);
    Ok(true)
}

/// 收放 Dock 图标。
///
/// 收掉之后应用变成 `Accessory`（等价于 Info.plist 里的 `LSUIElement`）：不在 Dock 里、
/// 不进 ⌘Tab，只剩菜单栏图标。窗口藏起来的时候这正是想要的——后台常驻的应用不该
/// 既占 Dock 又占菜单栏。
///
/// **放回来必须赶在 `window.show()` 之前。** `Accessory` 状态下应用不是「前台应用」，
/// 窗口 show 出来也抢不到键盘焦点，而且应用菜单栏不会跟着回来——⌘C / ⌘V / ⌘W 这些
/// 走菜单 key equivalent 的快捷键会时灵时不灵。顺序错一次，这种 bug 只在慢机器上偶发。
///
/// 图标只在**放回来时**挂：切回 `Regular` 后 Dock 重建 tile，dev 下取不到 bundle 图标，
/// 会退化成 `exec`。收起路径不能碰图标——`TransformProcessType` 正在把进程类型改掉，
/// 这时候设图标会把 Dock 的 tile 状态搞坏，收起后的图标反而变成黑的。
pub fn set_dock_icon(app: &tauri::AppHandle, visible: bool) {
    if let Err(err) = app.set_dock_visibility(visible) {
        eprintln!("[aihub] 切换 Dock 图标失败（visible={visible}）: {err}");
        return;
    }
    if visible {
        install_app_icon(app);
    }
}

/// 把内嵌图标挂到 `NSApp` 上。
///
/// 切回 `Regular` 之后，Dock 会重新建一个 tile，图标去 bundle 里取。
/// `tauri dev` 跑的是裸二进制、没有 `.app` bundle，取不到就退化成可执行文件的
/// 通用图标（黑底 `exec`）——这是 tauri#13519，上游标记为 wontfix。
///
/// 所以启动时先挂一次（`applicationIconImage` 有值，tile 重建就不会回落），
/// 每次切回前台再挂一次兜底，dev 和打包后的表现才一致。
pub fn install_app_icon(app: &tauri::AppHandle) {
    // AppKit 只能在主线程碰。切换 Dock 的调用点（托盘、老板键、单实例）都在主线程上，
    // 走到这里就是同步执行；万一将来有人从工作线程调，派发回主线程，别直接开干。
    if let Some(mtm) = MainThreadMarker::new() {
        // SAFETY: mtm 证明当前就在主线程。
        unsafe { apply_application_icon(mtm) };
        return;
    }
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            unsafe { apply_application_icon(mtm) };
        }
    });
}

/// 真正的设置动作。数据是构建期内嵌的 PNG，不依赖运行时的 bundle 路径。
unsafe fn apply_application_icon(mtm: MainThreadMarker) {
    let data = NSData::with_bytes(APP_ICON);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        eprintln!("[aihub] 内嵌图标解不出 NSImage，Dock 图标可能退化成通用图标");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: 传的是有效 NSImage，不是 None。
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

/// Dock 图标源数据。256px（128pt @2x）正好覆盖 Dock 的最大显示尺寸，
/// 内嵌进二进制，dev 下没有 bundle 也能拿到。
const APP_ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

#[cfg(test)]
mod tests {
    use super::*;

    /// 这张 PNG 解不出来时，`apply_application_icon` 只会打一行日志，
    /// Dock 依然是黑图标——靠肉眼很难判断是「没设」还是「设了但没解出来」。
    /// 所以在这里把解码这一步钉住。
    #[test]
    fn embedded_icon_decodes() {
        let data = NSData::with_bytes(APP_ICON);
        let image = NSImage::initWithData(NSImage::alloc(), &data)
            .expect("内嵌的 Dock 图标 PNG 必须能被 NSImage 解析");
        let size = image.size();
        assert!(
            size.width >= 128.0 && size.height >= 128.0,
            "图标尺寸过小，Dock 上会糊：{}x{}",
            size.width,
            size.height
        );
    }
}
