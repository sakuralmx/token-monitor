# 审查报告

> 审查日期：2026-08-17
> 审查方式：dsh-agent-teams 异源团队。成功产出来自 `yx/gpt-5.6-sol` 与 `yx/gpt-5.6-terra`；`yx/grok-4.6`、`yx/claude-sonnet-5` 启动即失败，原始记录保留在 `.agent-teams/`。

## 审查范围

- 基线：`d139e9d..HEAD`
- 范围：T1–T11（阿里云部署、会话目录模型与适配器、Node Hub SQLite、增量同步、Catalog UI、测试与 Hub build 注册）
- 重点：`src/shared/sessionCatalog.js`、`src/shared/*Sessions.js`、`src/shared/catalogStore.js`、`src/shared/catalogSync*.js`、`src/hub/server.js`、`src/electron/main.js`、`deploy/`
- 验证：成员 focused 测试 54/54 通过；队长运行 `npm.cmd run verify`，3177 项中 3169 通过、7 跳过、1 失败。唯一失败为 Windows 无符号链接权限导致 `tests/electron/macWidgetLaunchServicesRecovery.test.js:155` EPERM，与 Catalog 变更无关。
- 已验证通过：Catalog GET 位于 `src/hub/server.js:216` 的统一 `isAuthorized` 门禁之后；无认证请求会得到 401。

## 问题清单

### 严重

#### 1. Catalog UI 没有读取 Hub 永久目录，无法显示其他设备会话

**证据**：`src/electron/main.js:4614-4629` 的 `getLocalCatalogEntries()` 只扫描当前机器本地文件；Renderer 通过 `catalog:getLocal` 使用该结果。全仓唯一 `/api/catalog/v1/sessions` GET 实现在 `src/hub/server.js`，客户端没有对应 fetch、分页或 merge。注释称 Hub entries 经 stats/stream 到达，但 stats/SSE 不携带 Catalog entries。

**复现**：设备 A 上传会话后关机；设备 B 使用同一 Hub 打开 Catalog。B 不请求 `/api/catalog/v1/sessions`，只能看到 B 的本地扫描结果。

**修复建议**：在 client/host 模式增加带认证的 Hub Catalog 分页读取与离线缓存；local 模式保留本地扫描。补两设备错峰 E2E：A 上传→停止 A→B 拉取并渲染 A 条目。

#### 2. 较旧 upsert 可清除较新的删除墓碑

**证据**：`src/shared/catalogStore.js:195-199` 在 `excluded.deleted_at IS NULL` 时直接清除现有墓碑，不比较 `updated_at`。`invalidateKeys()` 在 `:325-335` 用当前时间写墓碑，离线客户端重放更旧记录仍可使会话复活，与文件头“cannot resurrect”冲突。

**复现**：upsert K（旧时间）→invalidate K→重放相同旧 upsert；默认 `listSessions()` 再次返回 K。

**修复建议**：仅当新写满足冲突时间规则时才允许清墓碑；明确是否允许显式复活，补 stale-after-delete 回归测试。

#### 3. 官方备份模板静默漏掉整个 Catalog 数据库

**证据**：`deploy/hub.env.example:18` 和 Hub 默认推导使用 `/var/lib/token-monitor/devices-catalog.db`；`deploy/scripts/backup.sh:21-25` 却只复制 `catalog.db{,-wal,-shm}`，随后仍打印 `backup written`。

**复现**：按 env 示例创建 `devices.json` 与 `devices-catalog.db`，运行脚本并 `tar -tzf`；归档无 Catalog DB。

**修复建议**：从真实环境变量及 Hub 默认规则解析路径；使用 SQLite backup/VACUUM INTO 或停服复制，备份后执行关键文件检查和 `PRAGMA quick_check`，缺失时非零退出。

#### 4. Certbot/nginx 首次部署流程不可执行

**证据**：README 未安装 `deploy/certbot/cli.ini`、未把 `renewal-hook.sh` 安装为 0755 的 `reload-nginx.sh`，也未创建 `/var/www/certbot`。更早的 nginx 步骤直接启用引用尚未签发证书的 TLS 配置，`nginx -t` 会先失败。

**复现**：干净 Ubuntu 按 README 第 1–4 步执行；第 3 步因证书不存在失败。绕过后仍会遇到 cli.ini、hook 或 webroot 不存在。

**修复建议**：先安装 Certbot 配置与 hook、创建 webroot；提供仅用于 HTTP-01 的 bootstrap nginx 配置，签发后再启用 TLS。增加干净 VM/容器部署 smoke test。

### 一般

#### 5. stale upsert 无条件覆盖 workspace 元数据

**证据**：`catalogStore.js:172-174` 无条件更新 `workspace_key/workspace_label`，而 title、时间和 stats 均按 `updated_at` 冲突规则更新。

**复现**：先写新版 workspace，再写更旧 workspace；查询得到旧 workspace 与新版其他字段的混合记录。

**修复建议**：workspace 字段服从同一 whole-record winner；补 stale workspace 测试。

#### 6. 同一 updatedAt 的 fallback→local 标题晋升不会上传

**证据**：Hub 支持相同时间戳下 `local` 胜过 `fallback`（`catalogStore.js:175-187`），但 `computeCatalogDelta()` 只在时间戳严格变大时上传（`catalogSync.js:54-59`）；同步状态不保存 titleSource 或内容指纹。

**复现**：state 与新 entry 时间相同、新 entry 为 `titleSource:'local'`；`upserts` 为空。

**修复建议**：状态保存 titleSource 与规范化内容指纹；同时间戳的 fallback→local 或内容变化也上传。

#### 7. Hub 部分拒绝后 Runtime 仍推进全部状态

**证据**：Store 可返回 `{accepted,rejected}`；上传层忽略 rejected；Runtime 在 HTTP 200 后保存整个 `delta.nextState`。被拒条目只要时间戳不变便永久失去重试机会。

**复现**：同批包含 1 个有效和 1 个无效 entry；Hub 返回 accepted=1/rejected=1，下一轮两项都不再进入 delta。

**修复建议**：返回 rejected keys/indices 与原因，只 checkpoint accepted 项；或有 rejected 时整批失败且不推进。补 mixed-result 测试。

#### 8. 显式删除 API 在正常 Agent/Widget 流程中不可达

**证据**：`computeCatalogDelta()` 支持 deletes，但 `runCatalogSync()` 只聚合 entries；三个 adapter 也只返回 entries。`/invalidate` 只有服务端与测试调用。

**复现**：删除本地会话后同步；扫描消失不推断删除，且无显式删除事件，Hub 条目永久保留。

**修复建议**：定义可靠的用户操作或 tombstone 来源并透传 `{entries,deletes}`；否则明确 invalidate 只是预留管理 API。

#### 9. Agent Catalog 同步状态非原子写入

**证据**：`src/agent/agent.js:124-135` 用 `fs.writeFileSync` 覆盖；读取失败静默返回 `{}`。截断 JSON 会触发下次全量重传。

**修复建议**：复用 `writeJsonAtomic` 或 temp+fsync+rename；保留最近有效副本并对损坏明确告警。

### 建议

#### 10. 展示层去重键可能跨设备误合并 sessionId

**证据**：`catalogRows` 使用 `client|sessionId` 去重，但协议主键为 `deviceId + client + sessionId`。不同设备独立生成相同 sessionId 时可能被错误折叠。

**修复建议**：默认按完整协议主键去重；若需要跨设备合并，应定义并验证全局稳定身份规则。

#### 11. 活跃 WAL 数据库不应通过逐文件 cp 宣称一致备份

**证据**：`backup.sh` 分别复制 DB/WAL/SHM，无法保证同一事务时点；项目已有使用 `VACUUM INTO` 的 `catalogStore.backup()`。

**修复建议**：提供 Hub backup 命令调用 SQLite 一致性备份，或 stop→copy→start；恢复测试必须执行 integrity/quick check 与条目比对。

## 异源团队运行记录

- 首次误用未注册的 `anthropic/openai/xai` provider id，成员无法创建。
- 改用已注册的 `yx` 路由后：
  - `yx/grok-4.6`：启动即失败，无报告。
  - `yx/claude-sonnet-5`：启动即失败，无报告。
  - `yx/gpt-5.6-terra`：成功，发现 UI 远程目录缺失、删除不可达、rejected 状态推进、去重碰撞。
  - `yx/gpt-5.6-sol`：成功，发现 SQLite 冲突、备份遗漏、delta 与状态持久化问题，并运行 focused 54 tests。
- 原始团队状态与消息保留在 `.agent-teams/token-monitor-review/`。

## 结论

**需返工，不放行。**

必须先修复严重问题 1–4，尤其是多设备 Catalog UI 未闭环、墓碑复活、备份漏库及不可执行的首次部署流程。修复一般问题后重新运行异源审查，并完成真实“两台设备错峰互看 + 备份恢复”验收。

## 2026-08-17 重新异源审查运行记录

用户修复 API Key 后要求使用 Grok、GLM 和 Claude 重新审查。本轮按 dsh-agent-teams 再次组队，结果如下（原始记录保留，不把失败伪装成审查结论）：

- `yixin/glm-5.3`：成员创建成功、任务成功 claim，并进入 `in_progress`；在多次明确的收尾指令后仍未返回任何审查报告，任务最终取消。
- `yixin/claude-sonnet-5`：成员创建成功、任务成功 claim，并进入 `in_progress`；在多次明确的收尾指令后仍未返回任何审查报告，任务最终取消。
- 用户请求的 `grok-5.6`：`yixin` provider 返回“未配置该模型”，无法创建成员。
- 降级尝试 `yixin/grok-4.6`：成员创建并 claim 成功，但未产出报告，任务最终取消。
- 队长重新运行覆盖模型、三适配器、Store、Sync Runtime、Hub API 的 focused 测试：**90/90 通过**。

因此，本轮没有获得可用于推翻或修订现有问题清单的新增异源证据；上方 11 项问题及“不放行”结论保持不变。若要完成 Grok/GLM/Claude 三方复核，需要先确认 AgentTeams provider 中存在可调用的 Grok 精确模型 ID，并排查成员收到任务后持续运行但不返回结果的问题。
