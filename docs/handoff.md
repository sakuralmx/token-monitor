# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-17
- 已完成：**T1–T11 全部实现**（个人多设备同步 + 会话目录计划），每个任务独立 commit：
  - T1 `02a1d2d` deploy/ 模板（systemd/nginx/certbot/健康检查/升级回滚备份）
  - T2 `f6082de` Hub 连接测试错误分类 + Test connection 按钮（5 语言）
  - T3 `03ed48e` docs/API.md 会话目录协议（upsert/分页/invalidate/降级）
  - T4 `cd5ea33` sessionCatalog.js 统一模型 + 隐私清洗（白名单字段、NFC/控制字符/代理对、稳定工作区键）
  - T5 `54adc3a` Cherry Studio 适配器（Claude Code transcripts，根目录与 collector 共享）
  - T6 `f42a2df` Codex 适配器（sessions/archived_sessions 日期分区，Win/macOS/WSL fixture）
  - T7 `d143a80` DSH 适配器（session.jsonl.zstd，zstd 特性检测：CLI→fzstd→清晰不可用态）
  - T8 `90be4c4` Hub SQLite 永久目录（node:sqlite，schema 迁移、幂等 upsert、tombstone、VACUUM INTO 备份、批量限制）
  - T9 `ccb9d06`+`0b8369b` 增量同步（delta 计算、分批、断网重试不重复、widget/agent 接入、catalogEnabled 开关）
  - T10 `11b8802` Catalog 视图（按工作区分组、折叠、筛选、空态/禁用态、长标题省略）
  - T11 `0af5213` hub build 闭包注册 + `.env.example`；真实 hub E2E 冒烟通过
- 验证方式：`npm run lint` 干净；`node --test` 3177 项中仅剩 1 个环境性失败（`macWidgetLaunchServicesRecovery` 需 symlink 特权，Windows 上改动前即失败）；真实 Node hub E2E 验证了 upsert 幂等、stale 写冲突拒绝、分页、重启持久化、secret 门禁、备份恢复、tombstone。
- 已知问题 / 待办：
  - 部署到阿里云 ECS 的真实服务器验收（deploy/README.md 流程）尚未执行——需要真实服务器与域名/IP 证书。
  - 会话目录的「两台设备错峰互看」真实设备验收未执行（无第二台设备）。
  - DSH zstd 解压在本机无后端时显示不可用（`zstdAvailable: false`）；装了系统 zstd 或 fzstd 即可启用。
  - 本地 `main` 落后 `origin/main`（上游镜像待快进）；`personal` 尚未推送到 fork。
  - 审查（docs/review.md）尚未执行：按 dev-flow，下一轮应跑「你来审查」。
- 给审查/下一轮的提示：审查范围默认本次 T1–T11 增量（相对 d139e9d）；重点看隐私边界（sessionCatalog 白名单、适配器路径处理）、SQLite 冲突 SQL、catalogSync 状态机。

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
