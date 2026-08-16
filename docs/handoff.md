# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-17
- 已完成：**异源审查返工轮**——针对异源团队复盘的 docs/review.md 8 项问题（3 严重 + 5 一般）逐项修复并验证：
  - 服务端隐私再清洗：Hub `upsertEntries` 统一走 `normalizeCatalogEntry`，新增 `sanitizeWorkspaceKey`/`sanitizeWorkspaceLabel` 丢弃/收编 path-shaped workspace 字段，upsert 不再接受 `deletedAt`（#1）。
  - 墓碑一致性：`winnerExpr` 增删除时间守卫（#2）；`invalidateKeys` 改 `INSERT…ON CONFLICT` 对未知 key 也落墓碑（#3）；invalidate 携带客户端事件时间 `deletedAt` 做条件更新 + 幂等（#5）；客户端 `computeCatalogDelta` 在删除后条目重现时用 `monotonicAfter` 制造严格更新事件时间做显式复活（#4）。
  - 一致性与响应：抽取 `remoteEntryWins` 统一 `mergeRemoteCatalog` 的 tie 规则（#6）；invalidate 返回 `rejectedKeys` 且客户端只 checkpoint 已接受删除（#7）；nginx SSE location 加 `limit_conn`（#8）。
  - `scripts/hub-build-manifest.js` 的 `NODE_RUNTIME_SOURCE_FILES` 增补 `sessionCatalog.js`、`hashKey.js`，`update:hub-build` 已重跑。
- 验证方式：`npm run lint` 干净；`npm test` 3197 项中 3189 通过、7 跳过、1 失败（`macWidgetLaunchServicesRecovery` symlink EPERM，Windows 上改动前即失败）；Catalog 专项测试 70/70（新增 11 项乱序时序测试）。
- 已知问题 / 待办：
  - 部署到阿里云 ECS 的真实服务器验收（deploy/README.md 流程）尚未执行——需要真实服务器与 IP 证书。
  - 「两台设备错峰互看」真实设备验收未执行（无第二台设备）。
  - DSH zstd 解压在本机无后端时显示不可用（`zstdAvailable: false`）；装系统 zstd 或 fzstd 即可启用。
  - 本地 `main` 落后 `origin/main`（上游镜像待快进）；`personal` 尚未推送到 fork。
- 给审查/下一轮的提示：修复结论已写入 docs/review.md 的「修复记录」表，8 项全部闭环。如需再次异源复核，重点看墓碑复活语义（严格更新事件时间）、服务端路径清洗、invalidate 幂等与 rejected checkpoint。

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
