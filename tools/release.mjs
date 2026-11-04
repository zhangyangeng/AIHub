#!/usr/bin/env node
// `npm run release` 的入口：挑一个真正能跑 sh 脚本的 bash，把参数原样带过去。
//
// 为什么 package.json 里不直接写 `bash tools/release.sh`：
// Windows 上 npm 用 cmd.exe 起命令，`bash` 会被 PATH 解析成
// C:\Windows\System32\bash.exe——那不是 Git Bash，是 WSL 启动器。
// 脚本于是跑在一个刚拉起来、环境被清空的 WSL 实例里：PATH 里没有 node，
// npm 传给子进程的 npm_node_execpath 也一起丢了，第一步就报「找不到 node」。
//
// 这里按顺序找 Git for Windows 的 bash，并用 `uname -s` 认一下是不是 MSYS
// （WSL 会回 Linux），确认了才用。找不到就退回 `bash`，让报错留在明面上。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "tools", "release.sh");

function isMsysBash(bin) {
  const r = spawnSync(bin, ["-c", "uname -s"], { encoding: "utf8", timeout: 15000 });
  if (r.error || r.status !== 0) return false;
  return /MINGW|MSYS|CYGWIN/i.test(r.stdout || "");
}

function bashCandidates() {
  const out = [];
  // 手动指定优先，装到奇怪位置时可以用这个兜底
  if (process.env.AIHUB_BASH) out.push(process.env.AIHUB_BASH);
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (base) out.push(join(base, "Git", "bin", "bash.exe"));
    }
    // PATH 里出现过 Git\cmd 或 Git\bin 的话，bash 就在它旁边
    for (const dir of String(process.env.PATH || "").split(";")) {
      if (/[\\/]Git[\\/](cmd|bin)[\\/]?$/i.test(dir)) {
        out.push(join(resolve(dir, ".."), "bin", "bash.exe"));
      }
    }
  }
  return out.filter((p) => existsSync(p));
}

function pickBash() {
  // 非 Windows 上 `bash` 就是它自己，没得挑
  if (process.platform !== "win32") return "bash";
  const list = bashCandidates();
  const msys = list.find(isMsysBash);
  if (msys) return msys;
  return "bash";
}

const bash = pickBash();
const r = spawnSync(bash, [SCRIPT, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: ROOT,
});

if (r.error) {
  console.error(`[release] 起不来 ${bash}：${r.error.message}`);
  console.error("[release] 可以用 AIHUB_BASH=/路径/to/bash.exe 指定一个");
  process.exit(1);
}

process.exit(r.status ?? (r.signal ? 1 : 0));
