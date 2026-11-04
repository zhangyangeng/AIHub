#!/usr/bin/env node
// 统一版本号：只维护一份，其余由这个脚本推平。
//
// 用法：
//   node tools/bump-version.mjs patch          # 0.5.1 -> 0.5.2，改完所有文件
//   node tools/bump-version.mjs minor          # 0.5.1 -> 0.6.0
//   node tools/bump-version.mjs 1.0.0          # 直接指定
//   node tools/bump-version.mjs --sync         # 以根 package.json 为准，推平到其它文件
//
// `--sync` 是给 npm 的 `version` 生命周期用的：
//   npm version patch -m "chore(release): v%s"
// npm 会先改好 package.json / package-lock.json 并建好提交和标签，中途调用
// `version` 脚本；这时版本已经定了，脚本只负责把它抄到别处，然后 `git add -A`
// 让这些改动并进 npm 那次提交里。
//
// 为什么改这么多处：真正决定「包是哪个版本」的只有 src-tauri/tauri.conf.json，
// 其余（Cargo.toml、src-ui/package.json、两个 lock）是元数据。漏改不会编译失败，
// 但 CI 用标签名生成 latest.json，和 config 版本对不上时客户端会一直收到同一个
// 版本的更新——所以干脆让它们不可能漂移。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

const args = process.argv.slice(2);
const syncMode = args.includes("--sync");
const arg = args.find((a) => !a.startsWith("-"));

function fail(msg) {
  console.error(`[version] ${msg}`);
  process.exit(1);
}

function readJSON(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) fail(`找不到 ${rel}`);
  return { abs, text: readFileSync(abs, "utf8") };
}

function parseSemver(v, where) {
  const m = SEMVER.exec(v);
  if (!m) fail(`${where} 里的版本 ${JSON.stringify(v)} 不是 semver`);
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: v };
}

// 只替换第一处 "version": "..."，够用且不会碰到别处的同名字段
function replaceFirstVersion(text, version) {
  const re = /("version"\s*:\s*")[^"]*(")/;
  if (!re.test(text)) fail('没找到 "version" 字段');
  return text.replace(re, `$1${version}$2`);
}

// 根 package.json 是版本的唯一来源
const rootPkg = readJSON("package.json");
const current = parseSemver(JSON.parse(rootPkg.text).version, "package.json");

let next;
if (syncMode) {
  next = current.raw;
  if (arg) fail("--sync 不接受版本号参数（npm 已经改好了）");
} else if (!arg) {
  fail("用法：node tools/bump-version.mjs patch|minor|major|x.y.z");
} else if (["patch", "minor", "major"].includes(arg)) {
  next =
    arg === "patch"
      ? `${current.major}.${current.minor}.${current.patch + 1}`
      : arg === "minor"
        ? `${current.major}.${current.minor + 1}.0`
        : `${current.major + 1}.0.0`;
} else {
  parseSemver(arg, "参数");
  next = arg;
}

if (next === current.raw && !syncMode) fail(`版本没变化（还是 ${next}）`);

const changes = [];

// 简单文件：只换第一处 "version"
for (const rel of ["src-ui/package.json", "src-tauri/tauri.conf.json"]) {
  const { abs, text } = readJSON(rel);
  const out = replaceFirstVersion(text, next);
  if (out !== text) {
    writeFileSync(abs, out);
    changes.push(rel);
  }
}

// lock 文件：两处 version（顶层 + packages[""]），走 JSON 解析，避免误伤依赖的版本
for (const rel of ["package-lock.json", "src-ui/package-lock.json"]) {
  const { abs, text } = readJSON(rel);
  const json = JSON.parse(text);
  const before = JSON.stringify(json);
  json.version = next;
  if (json.packages && json.packages[""]) json.packages[""].version = next;
  if (JSON.stringify(json) !== before) {
    writeFileSync(abs, JSON.stringify(json, null, 2) + "\n");
    changes.push(rel);
  }
}

// Cargo.toml：只动 [package] 里那行 `version = "x.y.z"`
{
  const rel = "src-tauri/Cargo.toml";
  const { abs, text } = readJSON(rel);
  const out = text.replace(/^version = "[^"]*"/m, `version = "${next}"`);
  if (out !== text) {
    writeFileSync(abs, out);
    changes.push(rel);
  }
}

// Cargo.lock：只动 name = "aihub" 那个包，别碰依赖
{
  const rel = "src-tauri/Cargo.lock";
  const { abs, text } = readJSON(rel);
  const out = text.replace(
    /(\[\[package\]\]\nname = "aihub"\nversion = ")[^"]*(")/,
    `$1${next}$2`,
  );
  if (out !== text) {
    writeFileSync(abs, out);
    changes.push(rel);
  }
}

// 根 package.json 放在最后：--sync 时 npm 已经改过它了，这里只兜底
{
  const out = replaceFirstVersion(rootPkg.text, next);
  if (out !== rootPkg.text) {
    writeFileSync(rootPkg.abs, out);
    changes.push("package.json");
  }
}

const label = syncMode ? "同步" : "升级";
if (changes.length === 0) {
  console.log(`[version] ${current.raw} → ${next}：所有文件已经是这个版本，没有改动`);
} else {
  console.log(`[version] ${label} ${current.raw} → ${next}`);
  for (const rel of changes) console.log(`  ✓ ${rel}`);
  // release.sh 里紧接着就提交、打标签了，这句提示对它是多余的噪音
  if (!process.env.AIHUB_BUMP_QUIET) {
    console.log("\n别忘了：改完要提交并打标签 v" + next + "，推送标签才会发版。");
  }
}
