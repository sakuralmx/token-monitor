# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-17
- 已完成：**审查修复轮**——针对 docs/review.md 的 11 项问题（4 严重 + 5 一般 + 2 建议）逐项修复并验证：
  - `0495d1d` 统一 whole-record 冲突 winner（含墓碑存留、workspace 元数据不再被 stale 覆盖）
  - `ce46a0d` 同时间戳 fallback→local 晋升上传、rejected keys checkpoint、deletes 透传、agent 状态原子写
  - `2966801` Catalog 视图读 Hub 永久目录（分页+认证+本地回退）、按完整主键去重
  - `5cdb25b` 备份脚本 VACUUM INTO + quick_check、certbot bootstrap 流程、hub build registry 重注册
- 上一轮（T1–T11 实现）：commit 序列见 `d139e9d..0af5213`，各任务验收与实现要点见 docs/archive/2026-08-17-session-catalog-tasks.md 对应的 handoff 历史（归档前内容）。
- 验证方式：`npm run lint` 干净；`node --test` 3186 项中 3177 通过、7 跳过、1 失败（`macWidgetLaunchServicesRecovery` symlink 权限，Windows 上改动前即失败）；`update:hub-build` 已重跑；真实 Node hub E2E 验证墓碑存留 + 显式复活语义。
- 已知问题 / 待办：
  - 部署到阿里云 ECS 的真实服务器验收（deploy/README.md 流程）尚未执行——需要真实服务器与 IP 证书。
  - 「两台设备错峰互看」真实设备验收未执行（无第二台设备）。
  - DSH zstd 解压在本机无后端时显示不可用（`zstdAvailable: false`）；装系统 zstd 或 fzstd 即可启用。
  - 本地 `main` 落后 `origin/main`（上游镜像待快进）；`personal` 尚未推送到 fork。
- 给审查/下一轮的提示：本轮修复结论已写入 docs/review.md 的「修复记录」表，11 项全部闭环。如需再次异源复核，重点看修复是否引入新问题（墓碑复活语义、指纹增量、rejected checkpoint）。

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
