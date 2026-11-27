import data from './releases.json';

/**
 * 更新日志 = GitHub Releases 的正文，构建时抓下来（scripts/fetch-releases.mjs）。
 *
 * 以前这份名单是手写的，发一版要记得回来改一次，改漏了就出现"站点停在 0.5.5、
 * 客户端已经 0.6.0"。现在版本、日期、每条改动都来自发版那一份 Release，
 * 站点只负责展示。Release 正文里的分组（新功能 / 修复 / …）原样保留，
 * 因为那本身就是按提交类型分好的。
 */

export interface Group {
  title: string;
  items: string[];
}

export interface Release {
  version: string;
  date: string;
  url: string;
  /** 与上一版的 diff 地址。页面上不再渲染（链接已收到版本号上），
   *  留着是因为它是真数据，将来做「逐条对比」还用得上。 */
  compare?: string | null;
  groups: Group[];
  current?: boolean;
}

/** 接口挂了、文件是空的时候，页面至少还有一版能看 */
const FALLBACK: Release[] = [
  {
    version: '0.5.5',
    date: '2026-11-14',
    url: 'https://github.com/zhangyangeng/AIHub/releases/tag/v0.5.5',
    compare: 'https://github.com/zhangyangeng/AIHub/compare/v0.5.4...v0.5.5',
    groups: [
      {
        title: '修复',
        items: ['后台标签自动休眠的选项切换后不生效', '顶栏 ✕ 改回关闭页面，关闭后不再自动打开相邻标签'],
      },
    ],
  },
];

export const changelog: Release[] = (data.releases.length ? data.releases : FALLBACK).map((r, i) => ({
  version: r.version,
  date: r.date,
  url: r.url,
  compare: r.compare,
  groups: r.groups,
  current: i === 0,
}));

/** 数据是什么时候抓的，页面上标一行，读者能判断这份日志新不新 */
export const changelogFetchedAt = data.fetchedAt ? data.fetchedAt.slice(0, 10) : null;
