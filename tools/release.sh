#!/usr/bin/env bash
# 发版一条命令：改版本号 → 提交 → 打本地标签（默认不推送）。
#
# 版本号本身由 tools/bump-version.mjs 写（要正确解析 JSON 和 lock 文件，
# 用 sed 改会误伤依赖的版本），这个脚本负责的是流程：算下一个版本、确认、
# 提交、打标签，以及把「别忘了推标签」这句话说清楚。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 版本号散在这些文件里，一个都不能漏（详见 docs/build.md 的表）
FILES=(
  package.json
  package-lock.json
  src-ui/package.json
  src-ui/package-lock.json
  src-tauri/Cargo.toml
  src-tauri/Cargo.lock
  src-tauri/tauri.conf.json
)

YES=0
PUSH=0
KIND=""
MSG_OVERRIDE=""

usage() {
  cat <<'EOF'
发版一条命令：改版本号 → 提交 → 打本地标签（默认不推送）。

用法：
  npm run release                 交互式选择 patch / minor / major
  npm run release -- patch        补丁号 +1（0.5.1 → 0.5.2）
  npm run release -- minor        次版本 +1（0.5.1 → 0.6.0）
  npm run release -- 1.0.0        直接指定版本

可选参数：
  -y, --yes          跳过确认
      --push         提交后推送分支和标签（推标签才会触发 CI 发版）
  -m, --message      自定义提交信息（默认 chore(release): vX.Y.Z）
  -h, --help         显示这段说明

只改文件、先不提交：npm run bump patch
EOF
}

die() {
  printf '\n[release] %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y | --yes) YES=1; shift ;;
    --push) PUSH=1; shift ;;
    -m | --message)
      [ $# -ge 2 ] || die "-m 后面要跟提交信息"
      MSG_OVERRIDE="$2"
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "不认识的参数：$1" ;;
    *) KIND="$1"; shift ;;
  esac
done

# 找 node：npm 跑 script 时会把「它自己正在用的那个 node」放进 npm_node_execpath。
# nvm / volta 这类工具只在交互 shell 里改 PATH，`bash tools/release.sh` 起的新 shell
# 可能压根看不到 node——但 npm 既然是 node 跑起来的，这个变量就一定是对的。
resolve_node() {
  local cand="${npm_node_execpath:-}" conv
  if [ -n "$cand" ]; then
    [ -x "$cand" ] && {
      printf '%s' "$cand"
      return 0
    }
    # Windows 上的 npm 交给 WSL 里的 bash 时，路径还是 C:\ 开头，转一次
    if command -v cygpath >/dev/null 2>&1; then
      conv="$(cygpath -u "$cand" 2>/dev/null || true)"
      [ -n "$conv" ] && [ -x "$conv" ] && {
        printf '%s' "$conv"
        return 0
      }
    fi
    if command -v wslpath >/dev/null 2>&1; then
      conv="$(wslpath -u "$cand" 2>/dev/null || true)"
      [ -n "$conv" ] && [ -x "$conv" ] && {
        printf '%s' "$conv"
        return 0
      }
    fi
    conv="${cand//\\//}"
    [ -x "$conv" ] && {
      printf '%s' "$conv"
      return 0
    }
  fi
  command -v node 2>/dev/null
}

NODE="$(resolve_node || true)"
[ -n "$NODE" ] || die "找不到 node：PATH 里没有，npm 也没给出 npm_node_execpath。用 npm run release 跑，或把 node 加进 PATH"

git rev-parse --git-dir >/dev/null 2>&1 || die "这里不是 git 仓库"
git rev-parse --verify HEAD >/dev/null 2>&1 || die "仓库还没有任何提交"

CURRENT="$("$NODE" --input-type=module -e '
  import fs from "node:fs";
  process.stdout.write(JSON.parse(fs.readFileSync("package.json", "utf8")).version);
')"
CORE="${CURRENT%%-*}" # 预发布后缀（-beta.1）不参与进位
IFS='.' read -r MAJ MIN PAT <<<"$CORE"
[[ "$MAJ$MIN$PAT" =~ ^[0-9]+$ ]] || die "package.json 里的版本 ${CURRENT} 不是 semver"

if [ -z "$KIND" ]; then
  printf '当前版本 %s\n\n' "$CURRENT"
  printf '  1) patch  %s.%s.%s  修 bug\n' "$MAJ" "$MIN" "$((PAT + 1))"
  printf '  2) minor  %s.%s.0  加功能\n' "$MAJ" "$((MIN + 1))"
  printf '  3) major  %s.0.0  破坏性变更\n' "$((MAJ + 1))"
  printf '  4) 手动输入\n\n'
  printf '选择 [1-4]（直接回车取消）：'
  # 不靠 [ -t 0 ] 判断：Windows 上经 cmd 转一手进来时它未必认得出是终端，
  # 直接读，读不到（管道 / CI）再让人显式给版本。
  read -r pick || die "读不到输入；非交互环境请直接给版本：npm run release -- patch"
  pick="${pick//[[:space:]]/}" # 手滑多敲个空格也认
  case "$pick" in
    1) KIND=patch ;;
    2) KIND=minor ;;
    3) KIND=major ;;
    4)
      printf '版本号：'
      read -r KIND || exit 1
      ;;
    '')
      echo "已取消。"
      exit 0
      ;;
    *) die "看不懂「$pick」，只接受 1-4" ;;
  esac
  echo
fi

case "$KIND" in
  patch) TARGET="$MAJ.$MIN.$((PAT + 1))" ;;
  minor) TARGET="$MAJ.$((MIN + 1)).0" ;;
  major) TARGET="$((MAJ + 1)).0.0" ;;
  *)
    TARGET="${KIND#v}" # 允许顺手写 v0.6.0
    [[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "「$KIND」不是 patch/minor/major，也不是 x.y.z"
    ;;
esac

[ "$TARGET" != "$CURRENT" ] || die "目标版本和当前一样（$CURRENT）"

TAG="v$TARGET"
MSG="${MSG_OVERRIDE:-chore(release): $TAG}"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "标签 $TAG 已经存在了，先想清楚是重发还是换版本"
fi

if [ -n "$(git status --porcelain)" ]; then
  printf '[release] 工作区还有未提交的改动，本次只会提交版本号那 7 个文件。\n\n'
fi

if ! git symbolic-ref -q HEAD >/dev/null; then
  printf '[release] 注意：当前不在任何分支上（detached HEAD），打完标签容易找不到。\n\n'
fi

printf '当前版本  %s\n' "$CURRENT"
printf '目标版本  %s\n' "$TARGET"
printf '提交信息  %s\n' "$MSG"
printf '标签      %s\n' "$TAG"
printf '推送      %s\n\n' "$([ "$PUSH" = 1 ] && echo '会推（触发 CI 发版）' || echo '不推')"

if [ "$YES" != 1 ]; then
  printf '回车继续，输入其它内容取消：'
  read -r go || die "读不到输入；非交互环境请加 -y 跳过确认"
  [ -z "$go" ] || {
    echo "已取消。"
    exit 0
  }
  echo
fi

AIHUB_BUMP_QUIET=1 "$NODE" tools/bump-version.mjs "$TARGET"

git add -- "${FILES[@]}"
if git diff --cached --quiet; then
  die "没有可提交的改动，检查一下 bump 是不是没写进去"
fi

printf '\n'
git diff --cached --stat

git commit -m "$MSG" --only -- "${FILES[@]}"
git tag "$TAG"

printf '\n[release] %s 已提交并打上标签 %s（本地）。\n' "$TARGET" "$TAG"

if [ "$PUSH" = 1 ]; then
  BRANCH="$(git branch --show-current)"
  [ -n "$BRANCH" ] || die "detached HEAD，不知道该推哪个分支"
  git push origin "$BRANCH"
  git push origin "$TAG"
  printf '[release] 已推送，去 Actions 看构建结果。\n'
else
  BRANCH="$(git branch --show-current)"
  printf '\n推送才会真正发版：\n'
  printf '  git push origin %s\n' "${BRANCH:-<分支名>}"
  printf '  git push origin %s\n' "$TAG"
  printf '\n反悔了想撤掉这次：git tag -d %s && git reset --hard HEAD~1\n' "$TAG"
fi
