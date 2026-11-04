#!/usr/bin/env node
'use strict';

/**
 * 生成 Release 说明正文。
 *
 * 用法：node .github/scripts/make-release-notes.mjs <输出文件|-> [base]
 *
 * 传 `-` 时打印到 stdout，用来在本地预览某个区间的样子。
 *
 * 正文只有两段：本次更新列表、上一版本以来的完整变更链接。
 * 安装方式、系统要求、签名状态这类固定内容归 README，不在每个版本重复一遍。
 *
 * 基准按优先级取：命令行参数 → 上一个版本标签 → .github/changelog-base。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 分组顺序即输出顺序；build 与 ci 合并成一段，避免同一件事分成两截 */
const SECTIONS = [
  ['feat', '新功能'],
  ['fix', '修复'],
  ['perf', '性能'],
  ['refactor', '重构'],
  ['style', '样式'],
  ['docs', '文档'],
  ['test', '测试'],
  ['build', '构建与发布'],
  ['ci', '构建与发布'],
];

const ORDER = ['新功能', '修复', '性能', '重构', '样式', '文档', '测试', '构建与发布', '其他'];
const SECTION_OF = new Map(SECTIONS);

/** 版本号提交本身不该出现在更新列表里 */
const SKIP = /^chore\(release\)/;

const [outFile, explicitBase] = process.argv.slice(2);
if (!outFile) {
  console.error('用法: node make-release-notes.mjs <输出文件|-> [base]');
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

function tryGit(args) {
  try {
    return git(args, { stdio: ['ignore', 'pipe', 'ignore'] }) || null;
  } catch {
    return null;
  }
}

function readBaseFile() {
  const file = join(root, '.github', 'changelog-base');
  if (!existsSync(file)) return null;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#'));
  return line || null;
}

function resolveBase() {
  if (explicitBase) return explicitBase;
  // 从 HEAD^ 起算，避免把当前正在发的那个标签自己当成基准
  return tryGit(['describe', '--tags', '--abbrev=0', 'HEAD^']) || readBaseFile();
}

/** 当前版本的标识：CI 里是标签名，本地退回精确标签，再退回提交号 */
function resolveHead() {
  return process.env.GITHUB_REF_NAME
    || tryGit(['describe', '--tags', '--exact-match', 'HEAD'])
    || tryGit(['rev-parse', '--short', 'HEAD']);
}

/** owner/repo：CI 里有环境变量，本地从 origin 推断 */
function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = tryGit(['config', '--get', 'remote.origin.url']);
  const m = url && /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1] : null;
}

/** 提交主题 -> 分组标题与正文；不符合约定式提交的原样保留 */
function splitSubject(subject) {
  const m = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(subject);
  if (!m) return { section: '其他', text: subject };
  return { section: SECTION_OF.get(m[1].toLowerCase()) || '其他', text: m[2].trim() };
}

function buildBody(base) {
  const lines = ['## 本次更新', ''];

  const subjects = base
    ? git(['log', '--no-merges', '--pretty=format:%s', `${base}..HEAD`])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !SKIP.test(s))
    : [];

  const buckets = new Map();
  for (const subject of subjects) {
    const { section, text } = splitSubject(subject);
    if (!buckets.has(section)) buckets.set(section, []);
    buckets.get(section).push(text);
  }

  if (!buckets.size) {
    lines.push('本次只有版本号变动。', '');
  } else {
    for (const title of ORDER) {
      const items = buckets.get(title);
      if (!items) continue;
      lines.push(`### ${title}`, '');
      for (const item of items) lines.push(`- ${item}`);
      lines.push('');
    }
  }

  const repo = resolveRepo();
  const head = resolveHead();
  if (repo && base && head) {
    lines.push(`**完整变更**：[${base}...${head}](https://github.com/${repo}/compare/${base}...${head})`);
  }

  return lines.join('\n') + '\n';
}

const base = resolveBase();
const body = buildBody(base);

if (outFile === '-') {
  process.stdout.write(body);
} else {
  writeFileSync(outFile, body, 'utf8');
  console.log(`[release-notes] 基准 ${base || '(无)'}，已写入 ${outFile}`);
}
