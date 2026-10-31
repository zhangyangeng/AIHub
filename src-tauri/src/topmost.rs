//! 置顶 / 让出前台：唯一入口。
//!
//! ## 为什么不能直接用 `window.set_always_on_top()`
//!
//! tao 的 `set_always_on_top` 走的是一条**通用**的标志更新路径：
//! `window.rs::set_always_on_top` -> `window_state.rs::set_window_flags`
//! -> `apply_diff`。而 `apply_diff` 只要发现窗口标志有差异、新标志里又带着
//! VISIBLE，就会先 `ShowWindow(hwnd, SW_SHOW)`，然后才去处理置顶那一项
//! （tao `src/platform_impl/windows/window_state.rs:325-356`）。
//!
//! `SW_SHOW` 的语义是「**激活**窗口并显示到当前位置」，不是「显示但不抢焦点」。
//! 于是「摘掉唤出置顶」这个动作本身会把窗口重新激活、重新抬到最前。
//!
//! 这件事在 Electron 版里不存在：`setAlwaysOnTop` 在 Windows 上只是
//! `SetWindowPos(HWND_NOTOPMOST, SWP_NOACTIVATE)`，没有 ShowWindow 这一层。
//! 迁到 Tauri 之后才冒出来，症状也很有辨识度——
//!
//! > 快捷键唤出窗口（这一下加了「唤出置顶」）-> 点别的应用的窗口
//! > -> 窗口收到失焦 -> 摘置顶 -> 顺手把自己抢回前台
//! > -> 那个应用上不了前台，必须再点一次（这次标志已经清了，diff 为空，不再抢）。
//!
//! 能不能抢到看竞态：目标程序自己激活、抬升得慢（Chrome 这种大进程），它的激活
//! 会压在这一枪**之后**完成，最后反而在前面，看起来就是正常的；轻量的小程序激活
//! 完成得快，正好被这一枪盖回去。所以现象是「有时行有时不行」，根子是同一个。
//!
//! ## 为什么摘置顶还要管 z-order 的位置
//!
//! 光摘掉 WS_EX_TOPMOST 也不够：`SetWindowPos(HWND_NOTOPMOST)` 的语义包含
//! 「放到所有非置顶窗口**上面**」，也就是说窗口会从「置顶层底部」直接跳到
//! 「普通层顶部」，照样盖住用户刚点的那个应用。所以让出前台时要把窗口插到
//! **当前前台窗口的下面**——既摘了置顶，又保证前台真的让出去了。
//!
//! ## 和 tao 内部状态的关系
//!
//! Windows 上这个文件是唯一入口：窗口在创建时就刻意不置顶（见 lib.rs 的
//! `tao_always_on_top`），所有置顶都由 Win32 直接改，tao 内部的 ALWAYS_ON_TOP
//! 标记永远保持 false。这样它既不会和真实状态错位，也不会在后续任何一次窗口
//! 标志变化里把置顶「恢复」回来。
//!
//! macOS / Linux 没有这个问题，仍走 tao 的接口。

/// 把窗口抬到最高层（压过别的置顶窗口和全屏程序）。
///
/// `SWP_NOACTIVATE`：只改 z-order，不抢焦点——唤出时的焦点由 `set_focus` 负责，
/// 两件事分开做，才不会被系统的前台锁规则合并成一堆不可预期的结果。
#[cfg(windows)]
pub fn pin(window: &tauri::Window) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    let Some(hwnd) = hwnd_of(window) else { return false };

    unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        )
        .is_ok()
    }
}

/// 摘掉置顶，并且**不抢前台**地把窗口让到当前前台窗口下面。
///
/// 返回值：`true` 表示这一单已经处理完（放开了，或者本来就没置顶）；
/// `false` 表示**还轮不到放**——`wait_for_foreground` 为 true 且当前前台窗口
/// 仍然是自己。这种情况下不能硬放：`SetWindowPos(HWND_NOTOPMOST)` 会把窗口
/// 插到普通层顶部，正好盖住用户刚点的那个应用，等于把老毛病换个形式犯一遍。
/// 调用方拿 `false` 就该过十几毫秒再来问一次，而不是拿一个瞎猜的位置硬塞。
///
/// 之所以要这个「问一次」的机会，是因为用户点别的应用之后，前台窗口的切换和
/// 我们收到失焦之间先后并不固定：前台先落地的，这一枪 0 延迟就能放干净；
/// 慢半拍的，就得等前台真的变成别人再动手。
#[cfg(windows)]
pub fn release(window: &tauri::Window, wait_for_foreground: bool) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, SetWindowPos, HWND_NOTOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE,
    };

    let Some(hwnd) = hwnd_of(window) else { return false };

    unsafe {
        // 本来就没置顶：什么都别做。多碰一次 SetWindowPos 就多一次改 z-order 的机会。
        if !is_topmost(hwnd) {
            return true;
        }

        // 插到当前前台窗口下面。前台窗口自己也是置顶的话（极少见）没法这么插，
        // 退回最朴素的做法：摘掉置顶，位置交给系统。
        let foreground = GetForegroundWindow();
        let after = if !foreground.is_invalid() && foreground != hwnd {
            if is_topmost(foreground) {
                HWND_NOTOPMOST
            } else {
                foreground
            }
        } else if wait_for_foreground {
            // 前台还是自己（或没人占）：用户那一击还没落地，等它落地再说
            return false;
        } else {
            HWND_NOTOPMOST
        };

        SetWindowPos(
            hwnd,
            after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        )
        .is_ok()
    }
}

/// 窗口现在是不是置顶的（诊断用，也是 `release` 的短路条件）。
#[cfg(windows)]
pub fn is_topmost_window(window: &tauri::Window) -> bool {
    hwnd_of(window).map(is_topmost).unwrap_or(false)
}

#[cfg(windows)]
fn hwnd_of(window: &tauri::Window) -> Option<windows::Win32::Foundation::HWND> {
    // tauri 用的是它自己那份 windows crate（0.61），这里是 Cargo.toml 里声明的 0.58。
    // 两边的 HWND 都是同一个裸指针，转一下就行，不需要把版本对齐。
    let raw = window.hwnd().ok()?;
    Some(windows::Win32::Foundation::HWND(raw.0 as _))
}

#[cfg(windows)]
fn is_topmost(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GWL_EXSTYLE, WS_EX_TOPMOST};

    unsafe { (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0) != 0 }
}

// ---------------------------------------------------------------------------
// 非 Windows：没有那层 ShowWindow 副作用，直接用 tao 的接口。
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
pub fn pin(window: &tauri::Window) -> bool {
    window.set_always_on_top(true).is_ok()
}

#[cfg(not(windows))]
pub fn release(window: &tauri::Window, _wait_for_foreground: bool) -> bool {
    window.set_always_on_top(false).is_ok()
}

#[cfg(not(windows))]
pub fn is_topmost_window(window: &tauri::Window) -> bool {
    window.is_always_on_top().unwrap_or(false)
}
