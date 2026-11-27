import data from './releases.json';

/**
 * 版本、日期、体积、文件列表全部来自 `releases.json`——它由 scripts/fetch-releases.mjs
 * 在构建前从 GitHub Releases 拉下来。发版后站点重建，这里就自动跟着变，不用手改数字。
 *
 * 唯一的例外是文件不存在时的兜底（下称 FALLBACK）：干净环境里第一次构建又恰好断网，
 * 页面仍然要能出，不能因为一个接口把整站卡死。兜底只在没有数据时生效。
 */

export interface ReleaseAsset {
  name: string;
  bytes: number;
  url: string;
}

export interface Platform {
  /** 这个版本有没有这个平台的包。没有时页面上不出现下载链接，避免死链 */
  available: boolean;
  name: string;
  url: string;
  /** 已格式化的体积，如 "3.7 MB"；没有包时是空串 */
  size: string;
  /** 一行说明：系统版本、架构 */
  arch: string;
}

export interface ReleaseFile {
  os: string;
  name: string;
  desc: string;
  size: string;
  url: string;
  ext: 'primary' | 'more';
}

export const repo = `https://github.com/${data.repo || 'zhangyangeng/AIHub'}`;

const latest = data.releases[0];

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

const FALLBACK = {
  version: '0.5.5',
  date: '2026-11-14',
  released: `${repo}/releases/latest`,
  windows: { available: true, name: 'Aihub_0.5.5_x64-setup.exe', url: `${repo}/releases/download/v0.5.5/Aihub_0.5.5_x64-setup.exe`, size: '3.7 MB', arch: '10 / 11 · x64' },
  macos: { available: true, name: 'Aihub_0.5.5_aarch64.dmg', url: `${repo}/releases/download/v0.5.5/Aihub_0.5.5_aarch64.dmg`, size: '5.4 MB', arch: 'Apple Silicon · 14+' },
  linux: { available: false, name: '', url: '', size: '', arch: 'x64 · 暂未出包' },
};

const find = (re: RegExp): ReleaseAsset | undefined => latest?.assets.find((a) => re.test(a.name));

const winExe = find(/x64-setup\.exe$/i);
const macDmg = find(/(?:universal|aarch64|x64)\.dmg$/i);
const linuxApp = find(/\.AppImage$/i) || find(/\.deb$/i);

/** dmg 文件名里带 aarch64 就只支持 Apple Silicon——README 里写的最低系统是 14 */
function macArch(asset?: ReleaseAsset) {
  if (!asset) return 'x64 · 暂未出包';
  if (/universal/i.test(asset.name)) return '12+ · 通用版';
  if (/aarch64|arm64/i.test(asset.name)) return 'Apple Silicon · 14+';
  return 'Intel · 14+';
}

const platform = (
  asset: ReleaseAsset | undefined,
  arch: string,
  fallback: Platform,
): Platform =>
  asset
    ? { available: true, name: asset.name, url: asset.url, size: mb(asset.bytes), arch }
    : { ...fallback, available: false, name: '', url: '', size: '' };

export const release = {
  version: latest?.version || FALLBACK.version,
  date: latest?.date || FALLBACK.date,
  released: latest?.url || FALLBACK.released,
  windows: platform(winExe, '10 / 11 · x64', FALLBACK.windows),
  macos: platform(macDmg, macArch(macDmg), FALLBACK.macos),
  linux: platform(linuxApp, linuxApp ? 'x64 · AppImage / deb' : 'x64 · 暂未出包', FALLBACK.linux),
};

/** 文件名 -> 这是什么，用来给「全部文件」表加一行说明 */
function describe(name: string): { os: string; desc: string; primary: boolean } {
  if (/x64-setup\.exe$/i.test(name)) return { os: 'win', desc: '安装版 · 推荐', primary: true };
  if (/\.msi$/i.test(name)) return { os: 'win', desc: 'MSI · 批量部署', primary: false };
  if (/portable.*\.zip$/i.test(name)) return { os: 'win', desc: '便携版 · 解压即用', primary: false };
  if (/\.dmg$/i.test(name)) return { os: 'mac', desc: macArch({ name, bytes: 0, url: '' }), primary: true };
  if (/\.AppImage$/i.test(name)) return { os: 'linux', desc: '免安装 · 双击运行', primary: true };
  if (/\.deb$/i.test(name)) return { os: 'linux', desc: 'Debian / Ubuntu', primary: false };
  // 这是 tauri-plugin-updater 的更新包，不是给人点的
  if (/\.app\.tar\.gz$/i.test(name)) return { os: 'mac', desc: '自动更新包 · 无需手动下载', primary: false };
  return { os: '—', desc: '其他', primary: false };
}

export const releaseFiles: ReleaseFile[] = (latest?.assets || []).map((a) => {
  const d = describe(a.name);
  return { os: d.os, name: a.name, desc: d.desc, size: mb(a.bytes), url: a.url, ext: d.primary ? 'primary' : 'more' };
});
