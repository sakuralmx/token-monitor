# 交接

> 每轮执行完成时由开发方更新；接手方、审查方必读。每轮完成后归档。

## 最近一轮

- 时间：2026-08-21（合并官方 v0.46.0 到 personal）
- 分支梳理结果（fetch 后权威关系）：
  - `origin/main` = ed2ccca（云端最新 = v0.46.0 + #464/#467/#378/#387 等后续提交）；`v0.46.0` tag = bed9fc3
  - 本地 `main`（19d98b2）= 无个人内容的旧上游快照，落后云端 58，可忽略/可删除
  - **`personal`（66d2d5a → 合并后 4fa9e6c）= 真实工作分支：92 独有提交 + 20 个云端缺失提交**
  - `fork/main`(sakuralmx) = 19d98b2；`private/personal`(604673a) 为 personal 远端，本地超前 29
- git fetch 修复：github.com 亚太 IP 的 HTTPS 在默认 HTTP/2 下被重置；**强制 `git config --global http.version HTTP/1.1` 后 fetch 成功**（已固化）。SSH 通道可达但本机唯一 key 未授权该账户（gh 账号 sakuralmx 有 repo 权限，未加 admin:public_key 所以 `gh api user/keys` 404）。
- 合并结果：`4fa9e6c merge: fold upstream v0.46.0 into personal (DSH, fixes, tokscale bridge)`，22 个真实冲突全部解决。
  - DSH：官方 #408/#427 为用量+会话明细主实现（dshPaths/dshSessionFiles/dshSessionDetail），保留本地 catalog 层与 `restoreDshRouteProviders` provider 归属恢复；`collector.js` 采用官方能力探测式 `tokscaleClientFilter`（含 antigravity 别名展开）。
  - Cherry Studio：collector 采用官方 #387 的 `cherryStudioTranscriptRoots`；本地 `cherryStudioSessions.js` 保留作会话目录适配器。
  - Renderer/清单/文档：client 列表按云端顺序统一（dsh/cherrystudio），`catalogEnabled` 改为**仅当设置面板有该开关时才写入 patch**（测试 DOM 无此元素则不出现该键），README 采用云端 "DeepSeek / DeepSeek Harness" 合并行口径。
  - 生成物：`npm run update:hub-build` 重算 hubBuildRegistry + `sync:worker` 同步 worker/src/shared（14 模块）。
- 验证：`npm run lint` 通过；`npm test` **3687 全过、0 失败、8 跳过**。为让测试在本机（`DSH_HOME=C:\Users\X\.dsh` 存在）通过，给 5 个 DSH 时间戳测试加了 env 隔离（`env: {}` / 临时删除 DSH_HOME）——此即上游测试在装有 DSH 的机器上的环境脆弱点，可考虑回馈上游。

## 已知限制 / 待办

- `docs/usage-snapshots/`（如 2026-08-21-hub-stats-raw.json，1.3MB）为 agent 侧 hub 快照，未纳入 git，勿误删。
- tokscale 供应商桥接（#448/#449 的 vendor/tokscale.json）已随合并进入；本机运行时 `ensure:tokscale` 仅覆盖 4 个打包平台，源码运行仍用 npm 4.13.0（本机实测已支持 dsh）。
- 合并后 personal 领先 origin/main 92+；推送/PR 到云端前建议先跑一次全量 verify。
- `main` 分支若不再维护可删除（内容均为 origin/main 的旧快照，历史已在 personal/origin 中）。
