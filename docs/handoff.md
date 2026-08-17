# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-17
- 已完成：Codex 官方额度、聚合 Token 统计与容量预估校准支持多设备同步。设备记录新增安全、版本化、定长的 `quotaTokenEstimate`；额度卡从当前 Codex 额度来源设备读取快照，本地设置作为离线回退，并继续用 Hub 的多设备汇总 Token 推进校准。
- 安全与兼容：最多同步 512 个观测点、256 个容量样本；只含不可逆账户键、额度百分比、聚合 Token 分量和时间，不含凭据、邮箱、正文或路径。旧 Hub 忽略字段时额度显示不受影响。Worker 共享闭包和 Hub build registry 已同步更新。
- 验证：聚焦测试 101/101、Electron 结构回归 56/56 通过。`npm run verify` 共 3503 项，3495 通过、7 跳过、1 失败；唯一失败仍为 Windows 创建 macOS 模拟 symlink 的 EPERM 环境限制。
- 提交：实现提交 `400bb85 feat(quota): sync Codex estimate calibration`。
- 打包安装：新安装包 SHA-256 `4889CD5353AF634771F3ECAE64E8C1B7DC2916A54E12224B16A033A63972F68E`，便携版 SHA-256 `07CE5C82F58AC44A16A2190CF43D30D9E6F17C6E7DCCDB83FF11E1802FD7F544`；静默安装退出码 0，安装文件版本 0.45.0，已重新启动。

## 上一轮

- 时间：2026-08-17
- 已完成：会话 Catalog 首屏改为有界读取，Hub 只请求一页、最多 200 条，本地回退同样截取最近 200 条；不再启动即预取全部永久历史。不同设备同步的会话按 `deviceId + client + sessionId` 隔离，复用本机会话卡片并与已有用量行去重。
- 时间筛选：会话在渲染前服从右上角 DAY / WEEK / 7D / MONTH / 30D / TOTAL 范围，可见会话条数会随筛选变化。
- 上游合并：官方 0.45.0（`origin/main`）已合并到 `personal`，合并提交 `e5d4629`；保留 personal 的 Cherry Studio、DSH 和目录元数据能力，并通过官方新增账户、WSL、托盘与客户端回归测试。
- 验证：聚焦测试 315/315 通过。`npm run verify` 共 3498 项，3490 通过、7 跳过、1 失败；唯一失败是 Windows 创建 macOS 模拟 symlink 返回 EPERM，与代码无关。
- 打包：生成 `Token-Monitor-Setup-0.45.0.exe` 和 `Token-Monitor-0.45.0.exe`，产物命名验证通过；SHA-256 分别为 `A70A8C1CF91251B74699BB5C2FF5D3B0F38C70461C1396463F17FF1BC9BCF1D7`、`A59DFB3626D30C10BA19C77ADAF550F78B28AD5C455179AFA338023FD28733B2`，均未签名。
- 安装：静默安装退出码 0；安装路径 `C:\Users\X\AppData\Local\Programs\token-monitor\Token Monitor.exe`，文件版本 0.45.0，安装后已重新启动。

## 更早一轮

- 时间：2026-08-17
- 已完成：删除独立“目录”视图，将 Catalog 标题与工作间元数据合并到“会话”视图。旧 `catalog` 视图偏好自动迁移到 `session`，底层元数据采集、Hub 同步与设置保持不变。
- 会话结构：工作间名称使用胶囊 Tab；会话标题加粗放大；工具与模型、Token 数位于下一层；时间与消息数量、价格位于底层；不再显示会话 ID。缺失工作间以 `—` 回退，长名称省略。
- 验证：聚焦测试 43/43、补充回归 44/44 通过，ESLint 通过。`npm run verify` 共 3219 项，3211 通过、7 跳过、1 失败；唯一失败仍是 Windows `EPERM` 导致 macOS 模拟 symlink 测试无法创建链接，与本轮改动无关。
- 打包：`npm run dist:win` 生成 Token Monitor 0.44.0 安装包与便携版；`npm run verify:release-artifact-names` 通过。安装包 SHA-256 `9818717038F43752F82C845BA2D57CBFB53BA24162152AE1D1F3F04F3FFF5424`，便携版 SHA-256 `8F8425213CA716827D527C7FEE4F67DFBBBE1810B7B315753B051B50F7947F30`。两份本地构建均未签名。
- 安装：`Token-Monitor-Setup-0.44.0.exe /S` 成功；安装路径 `C:\Users\X\AppData\Local\Programs\token-monitor\Token Monitor.exe`，文件版本 `0.44.0.0`，安装后进程稳定运行。

## 更早轮次

- 时间：2026-08-17
- 已完成：**收工验证与 Windows 安装**——在 Node 24.19.0 / npm 11.17.0 / Windows x64 上重新验证当前 `personal` 分支，生成并安装 Token Monitor 0.44.0。
- 验证方式：`npm run verify` 的 lint 通过；测试 3202 项中 3194 通过、7 跳过、1 失败。唯一失败仍是 `tests/electron/macWidgetLaunchServicesRecovery.test.js` 在 Windows 创建 macOS 模拟 symlink 时返回 `EPERM`，与本轮 Catalog 改动及 Windows 运行路径无关。`npm run dist:win` 成功生成 NSIS 安装包与便携版，`npm run verify:release-artifact-names` 通过。
- 安装结果：`Token-Monitor-Setup-0.44.0.exe /S` 退出码 0；安装文件版本为 `0.44.0.0`，路径为 `C:\Users\X\AppData\Local\Programs\token-monitor\Token Monitor.exe`；安装后启动并确认进程稳定运行。
- 产物校验：安装包 SHA-256 `DDD1C2ECEA098DDBFAA1DCADFCD43654BFA893EF3927227FBF0CD47750C2ACA3`；便携版 SHA-256 `85F439DA0EE7CE8C438E2899235F1EFD20D77AF3909650F2E83A262797146CBE`。本地构建未配置发布证书，两份 EXE 均未签名，不宜作为对外正式发行件。
- 已知问题 / 待办：
  - 部署到阿里云 ECS 的真实服务器验收（deploy/README.md 流程）尚未执行——需要真实服务器与 IP 证书。
  - 「两台设备错峰互看」真实设备验收未执行（无第二台设备）。
  - DSH zstd 解压在本机无后端时显示不可用（`zstdAvailable: false`）；装系统 zstd 或 fzstd 即可启用。
  - 本地 `main` 落后 `origin/main`（上游镜像待快进）；`personal` 尚未推送到 fork。
- 给下一轮的提示：当前 Windows 安装可运行；若要正式分发，必须使用发布签名流程重新构建。真实 ECS 与双设备错峰同步仍是最终验收缺口。

## 个人化工作流

### 远程与分支分工

| 引用 | 指向 | 角色 |
|---|---|---|
| `origin` | Javis603/token-monitor | 上游官方项目 |
| `fork` | sakuralmx/token-monitor | 个人 fork |
| `main` | 跟踪 `origin/main` | 上游镜像，保持干净 |
| `feat/cherrystudio` | 跟踪 `fork/feat/cherrystudio` | 给上游的 PR 分支，保持干净 |
| `personal` | 无远端 | 个人层（DSH 支持 + dev-flow），日常在此开发 |

### 个人化改动（只在 personal）

```bash
git checkout personal
# ……改代码……
npm run verify          # lint + test，必跑
git add -A && git commit -m "feat(dsh): 描述这次改动"
git push -u fork personal   # 首次推送；之后直接 git push
```

坑：
1. 改 `src/shared/` 后跑 `npm run sync:worker`（`worker/src/shared/` 是 `@generated` 副本，CI 查漂移）；动了 hub 核心稳定后跑 `npm run update:hub-build`。
2. dev-flow 的 `docs/`、`.dsh/` 只存在于 `personal`，不会混进上游；上游 `AGENTS.md` 更新也不会覆盖 dev-flow 层（末尾独立一段）。

### 拉上游更新（origin 才是上游）

顺序 main → feat/cherrystudio → personal：

```bash
git fetch origin

git checkout main && git pull origin main            # 上游镜像快进

git checkout feat/cherrystudio
git merge origin/main        # 与现有历史一致；要线性历史可 rebase（已推 fork 则需 force-push）

git checkout personal
git merge feat/cherrystudio  # 冲突手动解决；personal 未推送，rebase 也安全
```

### 打包分发

见 `README.md` "Build from source"（Node 22.13+、目标 OS 上构建）：

```bash
npm run verify      # 打包前 lint + test
npm run dist:win    # Windows x64 安装包 .exe → dist/
npm run pack        # 免安装解包目录（--dir），快速本地自测
npm run dist:linux  # Linux x64 AppImage
npm run dist:mac    # macOS arm64 .dmg（需 Apple Developer ID 签名）
```

产物落 `dist/`（`.gitignore` 已忽略）。自用分发取 `.exe`；发 release 走 GitHub Releases（可先 `npm run verify:release-artifact-names` 查产物命名）。
