#!/usr/bin/env bash
#
# Cloudflare 挑战回路的「一行命令」。
#
#   bash tools/cloudflare-guard-loop.sh                     # 修复前：期望红，退出码 1
#   CF_EXPECT=green bash tools/cloudflare-guard-loop.sh     # 修复后：期望绿，退出码 0
#
# 它做三件事：起 fixture 服务器 → 用真 app（debug 构建）把 fixture 站点挂上 →
# 从 fixture 的轨迹判红绿并打印证据。
#
# 为什么判据在 fixture 那边：站点页面会把自己**渲染出来的文字**回传给服务器，
# 所以轨迹里同时有「协议走到哪一步」和「用户看到了什么」。红绿按这两条判：
#
#   红 = 轨迹里有 `Route Error (403)`，且没有 clearance 后的成功请求
#   绿 = 轨迹里有 clearance 后的 200，且页面渲染成「验证码已发送」
#
# 退出码：0 = 绿（CF_EXPECT=green 时）/ 1 = 红（CF_EXPECT=red 时）/
#         2 = 不符合期望或自检没跑起来。红是修复前的**预期**结果，所以退出码
#         按「这本该是什么颜色」定，而不是按「脚本有没有崩」。
#
# 前置：先 cargo build（debug）；不能有另一个 aihub 在跑（lib.rs:373 的单实例
# 插件会让新实例直接退出，表现为「什么都没发生」）。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/src-tauri/target/debug/aihub}"
EXPECT="${CF_EXPECT:-red}"
WAIT_SECONDS="${CF_WAIT_SECONDS:-45}"

# fixture 端口默认随机：守卫的「重试过没有」闸门写在 cookie/sessionStorage 里，而
# macOS 上各站点 webview 的 cookie jar 看起来是共享的（见本文件末尾的「已知坑」），
# 固定端口 + 固定 origin 会让上一轮的戳漏到这一轮，把新的一轮直接判成「守卫停手」。
# 换个 origin 就干净了 —— 回路必须跟上一轮无关，否则它是假的。
PORT="${CF_FIXTURE_PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}"

if [ "${CF_SKIP_SINGLE_INSTANCE_CHECK:-0}" != "1" ] && [ "$(uname -s)" = "Darwin" ] \
   && pgrep -f "Aihub.app/Contents/MacOS/aihub" >/dev/null; then
  echo "失败：已经有一个 Aihub 在跑，单实例插件会让这次的 app 直接退出。" >&2
  echo "     要么先退出它（登录态存在各站点的 WebViews 目录里，不会丢）；" >&2
  echo "     要么编一份**另一个 identifier** 的测试二进制，跟它井水不犯河水：" >&2
  echo "       TAURI_CONFIG='{\"identifier\":\"io.github.openx123.aihub.cftest\"}' \\" >&2
  echo "         cargo build --manifest-path src-tauri/Cargo.toml" >&2
  echo "       CF_SKIP_SINGLE_INSTANCE_CHECK=1 CF_EXPECT=green bash tools/cloudflare-guard-loop.sh" >&2
  exit 2
fi
if [ ! -x "$BIN" ]; then
  echo "失败：找不到可执行文件 $BIN（先 cargo build）" >&2
  exit 2
fi

APP_LOG="$(mktemp -t aihub-cf-app)"
SRV_LOG="$(mktemp -t aihub-cf-srv)"
SRV_PID=""; APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

CF_FIXTURE_PORT="$PORT" node "$ROOT/tools/cloudflare-fixture-server.js" >"$SRV_LOG" 2>&1 &
SRV_PID=$!
sleep 0.6   # 等它 listen

# 自检脚本跑在 webview 里，读不到环境变量 —— 端口靠替换生成一份临时副本
SELFTEST="$(mktemp -t aihub-cf-selftest).js"
sed "s|http://127.0.0.1:8791/|http://127.0.0.1:$PORT/|" \
  "$ROOT/tools/cloudflare-guard-selftest.js" >"$SELFTEST"

AIHUB_SELFTEST="$SELFTEST" "$BIN" >"$APP_LOG" 2>&1 &
APP_PID=$!

# 等自检把外壳还原完（它自己会等页面把流程走完），再留一点时间收尾上报
RESTORED=0
for _ in $(seq 1 $((WAIT_SECONDS * 2))); do
  if grep -q '已还原外壳状态' "$APP_LOG"; then RESTORED=1; break; fi
  sleep 0.5
done
sleep 1
if ! grep -q '^\[selftest\]' "$APP_LOG"; then
  echo "警告：app 一行自检输出都没有 —— 十有八九是单实例冲突（另有 aihub 在跑，而这次的" >&2
  echo "      二进制和它同一个 identifier，新实例把那个窗口唤到前面就自己退了）。" >&2
  echo "      先退出它，或者编一份另一个 identifier 的测试二进制再配 CF_SKIP_SINGLE_INSTANCE_CHECK=1：" >&2
  echo "      TAURI_CONFIG='{\"identifier\":\"io.github.openx123.aihub.cftest\"}' cargo build --manifest-path src-tauri/Cargo.toml" >&2
elif [ "$RESTORED" != "1" ]; then
  echo "警告：自检没走到「已还原」就被打断了。如果它中途挂掉，服务列表里可能留下一个" >&2
  echo "      CF Fixture 服务（指向 127.0.0.1 的假站点），手动删掉即可。" >&2
fi

echo "=== 自检 ==="
grep -E '^\[selftest\] .' "$APP_LOG" | sed 's/^/  /' || echo "  （没有输出 —— app 没起来？单实例冲突？）"
echo "=== fixture 轨迹（证据） ==="
sed 's/^/  /' "$SRV_LOG"

# 判定顺序有讲究：绿轨迹里**也会**出现 `Route Error (403)`（那是恢复前的瞬时状态，
# 页面确实先渲染了它）。所以红必须额外要求「没有恢复成功」，否则顺序一变就误判。
# 这个坑第一次就踩了：判据 grep 的串和 fixture 实际打的串对不上，绿的被判成红。
OK_MARK='clearance 的请求 → 200'
if grep -q '已停止自动重试' "$SRV_LOG"; then GOT=stuck
elif grep -q "$OK_MARK" "$SRV_LOG" && grep -q '验证码已发送' "$SRV_LOG"; then GOT=green
elif grep -q 'Route Error (403)' "$SRV_LOG" && ! grep -q "$OK_MARK" "$SRV_LOG"; then GOT=red
else GOT=unknown; fi
NAVS=$(grep -c '文档导航 → 挑战页' "$SRV_LOG" || true)

echo "=== 期望 / 实际 ==="
echo "  mode=${CF_FIXTURE_MODE:-normal}  CF_EXPECT=$EXPECT  实际=$GOT"
echo "  顶层导航次数=$NAVS（stuck 必须正好是 1 —— 多了就是防死循环闸门没生效）"
if [ "$GOT" = "$EXPECT" ]; then
  if [ "$GOT" = stuck ] && [ "$NAVS" != "1" ]; then
    echo "  不通过：stuck 模式下导航了 $NAVS 次，守卫没有收手。app 日志在 $APP_LOG" >&2
    exit 2
  fi
  echo "  通过：回路给出了预期的颜色。"
  [ "$GOT" = red ] && exit 1 || exit 0
fi
echo "  不通过：预期 $EXPECT，实际 $GOT。app 日志在 $APP_LOG" >&2
exit 2
