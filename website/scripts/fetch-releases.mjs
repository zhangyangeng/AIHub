#!/usr/bin/env node
'use strict';

/**
 * 把 GitHub Releases 拉成站点用的静态数据。
 *
 * 用法：node scripts/fetch-releases.mjs
 *
 * 为什么在构建期拉、而不是页面里现请求：
 *   页面里请求会把一个 60 次/小时的公开接口挂到每个访客头上，还会让更新日志
 *   在接口抽风时变空白。构建期拉一次、写成 JSON 提交在仓库里，产物就是静态的，
 *   线上没有一个请求，接口挂了最多是"这次的构建用了上次的数据"。
 *
 * 拉不到（断网、限流）时保留上一份文件并正常退出——本地开发不能因为没网就构建不了。
 * 只有在连旧文件都没有的干净环境里，才写一个空数组，页面会自己退回内置的兜底数据。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src', 'data', 'releases.json');

/** CI 里有 GITHUB_REPOSITORY；本地按 origin 写死的仓库名兜底 */
const REPO = process.env.GITHUB_REPOSITORY || 'zhangyangeng/AIHub';

/**
 * 只保留用户能感知到的分组。
 * 文档 / 测试 / 构建发布是维护者视角的东西，放进产品官网的更新日志里只是噪音，
 * 但它们仍然留在 Release 正文里，谁想知道细节点「完整变更」。
 */
const KEEP = new Set(['新功能', '修复', '性能', '重构', '样式']);

/** 正文里的行内语法：先转义，再认回链接和行内代码，顺序不能反 */
function inline(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

/** Release 正文 -> [{ title, items }]。认不出分组的行直接丢掉，不猜。 */
function parseBody(markdown) {
  const groups = [];
  let cur = null;

  for (const raw of String(markdown || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      cur = { title: heading[1].trim(), items: [] };
      groups.push(cur);
      continue;
    }
    // 空行不要清 cur：分组标题和第一条之间本来就有空行
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet && cur) cur.items.push(inline(bullet[1].trim()));
  }

  return groups.filter((g) => g.items.length && KEEP.has(g.title));
}

/** 正文末尾那条「完整变更」链接，没有就返回 null */
function parseCompare(markdown) {
  const m = /\*\*完整变更\*\*：?\[[^\]]*\]\((https?:\/\/[^)]+)\)/.exec(String(markdown || ''));
  return m ? m[1] : null;
}

function toEntry(release) {
  return {
    version: release.tag_name.replace(/^v/i, ''),
    tag: release.tag_name,
    date: (release.published_at || '').slice(0, 10),
    url: release.html_url,
    compare: parseCompare(release.body),
    groups: parseBody(release.body),
    assets: (release.assets || [])
      .filter((a) => !/\.sig$/i.test(a.name) && !/^latest\.json$/i.test(a.name))
      .map((a) => ({ name: a.name, bytes: a.size, url: a.browser_download_url })),
  };
}

async function main() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'aihub-site-build',
    'x-github-api-version': '2022-11-28',
  };
  // Actions 里带上 token 走 5000 次/小时的额度；不带也能用，只是 60 次
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);

  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('返回的不是数组');

  const releases = list
    .filter((r) => !r.draft && !r.prerelease)
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
    .map(toEntry)
    .filter((r) => r.version);

  if (!releases.length) throw new Error('没有已发布的版本');

  // 版本列表没变就不重写：这个文件是提交在库里的，每次构建都换一个 fetchedAt
  // 会让工作区永远脏着，diff 里全是时间戳。
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    /* 第一次生成 */
  }
  if (prev && JSON.stringify(prev.releases) === JSON.stringify(releases)) {
    console.log(`[releases] ${releases.length} 个版本，无变化，保留原文件`);
    return;
  }

  const payload = {
    // 谁生成、什么时候生成的。页脚会显示日期，让读者知道这份日志有多新。
    repo: REPO,
    fetchedAt: new Date().toISOString(),
    releases,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(
    `[releases] ${releases.length} 个版本，最新 ${releases[0].tag}，已写入 ${OUT}`,
  );
}

try {
  await main();
} catch (err) {
  let kept = 0;
  try {
    kept = JSON.parse(readFileSync(OUT, 'utf8')).releases.length;
  } catch {
    /* 还没有旧文件 */
  }

  if (kept) {
    console.warn(`[releases] 拉取失败（${err.message}），沿用已有的 ${kept} 个版本`);
  } else {
    console.warn(`[releases] 拉取失败（${err.message}），写入空表，页面用内置兜底`);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ repo: REPO, fetchedAt: null, releases: [] }, null, 2) + '\n');
  }
}
