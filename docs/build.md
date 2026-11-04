# 打包与发版

## 1. 本机构建

```powershell
npm run tauri:build    # 出安装包
```

产物在 `src-tauri/target/release/bundle/`：

- Windows：`nsis\Aihub_x.y.z_x64-setup.exe`，约 2 MB
- macOS：`dmg\Aihub_x.y.z_aarch64.dmg` 和 `macos\Aihub.app.tar.gz`（后者是更新包）

第一次要十几分钟（Rust 依赖树全量编译 + LTO），之后有缓存会快很多。
需要 Rust 工具链和 MSVC Build Tools；`rustup` 装完默认就带。

**更新签名**：如果环境里没有 `TAURI_SIGNING_PRIVATE_KEY`，包照样出得来、也装得上，
只是不带 `.sig`，自动更新会拒绝它。CI 上这个值从仓库 Secret 取（整份私钥内容粘进去）；
密钥如果设了密码，再加一个 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。本地手动打包不用管。

## 2. 发版

自动更新认的是 Release 上的 `latest.json`，它是 CI 在推标签时生成的，
所以发版必须走标签，不能手动传安装包：

```powershell
# 一条命令：升版本号 + 推平到所有文件 + 提交 + 打标签
npm run release              # 交互式选：1 patch / 2 minor / 3 major / 4 手动输入

git push origin main --tags  # 剩下的交给 GitHub Actions
```

`tools/release.sh` 做四件事：算下一个版本号 → 调 `tools/bump-version.mjs` 推平下面那张表里的
7 个文件 → 用 `chore(release): vX.Y.Z` 提交（**只带这 7 个文件**，工作区里别的改动不会被卷进来）
→ 打本地标签。推送它不做，跑完会把该敲的两条 `git push` 打出来；想一步到位加 `--push`。

不想交互就直接给版本，也可以绕过 npm 在 Git Bash 里跑：

```powershell
npm run release -- patch     # 或 minor / major / 1.0.0
npm run release -- patch --push
```

```bash
./tools/release.sh 0.6.0     # 效果一样
```

它会在写文件之前把「当前版本 → 目标版本、提交信息、标签名、推不推」列出来让你回车确认；
同版本、非法版本号、标签已存在这三种情况会直接拦下，不会留下半截状态。

只想改文件、自己决定怎么提交：

```powershell
npm run bump patch    # 或 node tools/bump-version.mjs 0.6.0
```

版本号出现的位置（全部由脚本维护，**不要手改**）：

| 文件 | 谁在用 | 改漏的后果 |
| --- | --- | --- |
| `src-tauri/tauri.conf.json` | 编译进 exe 的版本，更新器拿它和 `latest.json` 比 | 唯一真正会出问题的：客户端收不到更新，或装完还是旧版本反复提示 |
| `package.json` / `src-ui/package.json` | npm 元数据、Electron 回退版 | 界面/仓库显示的数字不对，不影响更新 |
| `src-tauri/Cargo.toml` / `Cargo.lock` | crate 版本 | 无 |
| 两个 `package-lock.json` | npm 自己的记录 | 无 |

CI 里有一道「版本与标签一致」的检查：标签 `vX.Y.Z` 和 `tauri.conf.json` 对不上时直接失败，
不会出现「包版本和更新源对不上」的静默故障。

`.github/workflows/build-tauri.yml` 会先跑 Rust 单测，再构建两个平台，
把所有安装包和 `.sig` 挂到 Release，最后由 `.github/scripts/make-latest-json.mjs`
汇总成 `latest.json`。

| 文件 | 少了会怎样 |
| --- | --- |
| `latest.json` | 更新源找不到，客户端一直报 404，永远收不到新版本 |
| `*.sig` | 签名校验不过，客户端拒绝安装 |
| 安装包本体 | 下载不到 |

> **最容易踩的坑（现在有闸门了）：`version` 没升就打了标签。** 标签推了、Release 也出来了，
> 但包里的版本号没变，客户端一比「线上和我一样」，谁都收不到更新。以前 `package.json` 和
> `tauri.conf.json` 是两处手改，漏一个就中招；现在是 `npm run release` 一条命令推平 + CI 版检，
> 除非绕过脚本手打标签，否则撞不上。

Release 说明由 `.github/scripts/make-release-notes.mjs` 生成：按约定式提交分组，
末尾附上一版本以来的完整变更链接。安装方式、系统要求、签名状态这些固定内容只写在 README，
不随每个版本重复。

改说明格式时可以本地预览任意区间，不用推标签等 CI：

```bash
node .github/scripts/make-release-notes.mjs -            # 上一个标签至今
node .github/scripts/make-release-notes.mjs - 84fe2af    # 指定基准
```

## 3. 签名状态

两个平台都没有代码签名：

- Windows：未签名会触发 SmartScreen「已保护你的电脑」，点「更多信息 → 仍要运行」即可。
  彻底消除需要买代码签名证书（一年几百到上千元）。
- macOS：未签名 + 未公证，首次打开会被 Gatekeeper 拦。打包时会补一次 ad-hoc 签名
  （Apple Silicon 上不加签名的 app 根本起不来），但去公证需要 Apple 开发者账号。

## 4. Electron 回退版

```powershell
npm run icons      # 改了 assets/logos 时：重新生成 icons/ 与 icons.js
npm run dist       # 生成 Windows 一键安装包（会自动先跑 icons + menu-icons）
```

产物在 `dist\`，双击即装。想快速验证打包流程可以用 `npm run dist:dir`（只出免安装目录）。

`icons/`、`icons/dark`、`icons/light`、`icons/menu` 都是生成物，不要手改；
`tools/build-icons.js` 和 `tools/build-menu-icons.js` 都支持 `--check`，只校验、绝不写盘。
