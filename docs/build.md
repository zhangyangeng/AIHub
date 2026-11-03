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
# 1. 改 package.json 和 src-tauri/tauri.conf.json 的 version（两处都要改）
# 2. 提交
git commit -am "chore(release): v0.4.1"
# 3. 打标签推上去，剩下的交给 GitHub Actions
git tag v0.4.1
git push origin main --tags
```

`.github/workflows/build-tauri.yml` 会先跑 Rust 单测，再构建两个平台，
把所有安装包和 `.sig` 挂到 Release，最后由 `.github/scripts/make-latest-json.mjs`
汇总成 `latest.json`。

| 文件 | 少了会怎样 |
| --- | --- |
| `latest.json` | 更新源找不到，客户端一直报 404，永远收不到新版本 |
| `*.sig` | 签名校验不过，客户端拒绝安装 |
| 安装包本体 | 下载不到 |

> **最容易踩的坑：忘了改 `version`。** 标签推了、Release 也出来了，但包里的版本号没变，
> 客户端一比「线上和我一样」，于是谁都收不到更新。`package.json` 和
> `src-tauri/tauri.conf.json` 是两个地方，漏一个就会出现「界面显示的版本和实际不符」。

Release 的说明会把 `.github/release-footer.md` 放在最前面，再拼上自动生成的 commit 列表。
顺序是有意的：升级须知（比如「要重新登录一次」）必须在用户点下载之前就看见。

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
