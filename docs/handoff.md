# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-16
- 已完成：
  - 协作流程初始化（dev-flow）：AGENTS.md 追加 dev-flow 层、`.dsh/skills/dev-flow/SKILL.md`、`docs/{plan,tasks,handoff,review}.md`、`docs/archive/.gitkeep`、`.gitignore` 追加规则（commit `3454910`）。
  - DSH 客户端支持提交到 `personal` 分支（commit `32325b9`，32 文件 +543/−39），`feat/cherrystudio` 保持原样（仍在 `4f48bb4`）。
- 验证方式：`git status` 工作树干净；`git log` 确认 `personal` = `feat/cherrystudio(4f48bb4)` + `32325b9` + `3454910`。
- 已知问题：
  - 本地 `main` 落后 `origin/main` 14 个提交（上游镜像待快进，不影响个人层）。
  - `personal` 尚未推送到 fork（远端无 `fork/personal`）。
- 给审查/下一轮的提示：分支与远程分工、日常循环见下方「个人化工作流」。

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
