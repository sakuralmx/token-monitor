# Codex / OpenCode Go 兼容边界历史快照（已废弃）

> **状态：已被最终决策取代，不是当前维护契约。** 本文件记录 2026-08-18 容量预估删除工作开始前的工作树快照，仅供追溯当时的输入与决策过程。最终实现及现行边界以 `docs/handoff.md` 的“最近一轮（删除容量预估）”为准。下文所有“必须保留”“后续必须”等措辞都是历史要求，**不得据此恢复**容量设置、校准/拟合/投影函数、`quotaTokenEstimate(s)` wire 字段、`src/shared/quotaTokenEstimate.js` 或 Worker 副本。

## 当前生效的兼容边界

- 删除并保持删除：Codex/OpenCode Go 容量趋势卡、容量/剩余 Token/预计可用时间展示，以及启用、备用容量、安全预留设置。
- 删除并保持删除：容量推算、权重拟合、剩余 Token 投影、校准路径、`quotaTokenEstimate(s)` wire 协议、`src/shared/quotaTokenEstimate.js` 及 Worker 副本。
- 旧 settings/wire 字段只允许在升级输入边界被容忍并丢弃；不得读取、回写、同步或重新暴露为现行能力。
- 保留：主进程在收到有效 limits + usage summary 时记录 Codex 与 OpenCode Go 各自的官方额度百分比观测历史（`remainingPercent`、ISO `at`、可选 `resetsAt`），不依赖 renderer 卡片渲染；两个 provider 隔离。
- 保留：已有百分比历史的迁移/读取，以及多设备同步的有界、净化、按 provider 合并和 limits-only 不覆盖语义。
- 保留：用于审计/归属的 provider token components；它们不得再进入容量计算或展示。OpenCode Go 关联用量只取 `provider=opencode-go`。

以下内容为被取代的历史快照，不具规范效力。

## 1. 历史 Git 工作树基线

- 分支：`personal`（相对 `private/personal` ahead 21）
- HEAD：`364aae39240d9628ab1a13a39af06ef8d97ed7ed`
- 暂存区：空
- 未暂存 diff：14 个已跟踪文件，`330 insertions(+), 25 deletions(-)`
- Git blob 身份：
  - `git diff --binary | git hash-object --stdin` = `ca0687c886af90104aebb4d467936a33e95cb7c3`
  - `git diff --cached --binary | git hash-object --stdin` = `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`（空 diff）
  - `git status --porcelain=v2 | git hash-object --stdin` = `d5d6cb211da6b60dbe1ba2b0be6acb29b0c23d38`
- 本地恢复快照（位于 `.git/`，不进入提交）：
  - `.git/dsh-preflight-working-tree.patch`，SHA-256 `169398D56B8662ED91883E1C71A64A00C6A9AEC4FC802ED90D3CB8813C709B62`
  - `.git/dsh-preflight-index.patch`，SHA-256 `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855`
  - `.git/dsh-preflight-status.txt`，SHA-256 `1134494C769F99FD4B39B84A7F896D7D8C00236E3272C571B50B258CE0E77405`

### 基线文件（必须逐一保留其既有修改）

| 路径 | 基线 numstat | 既有修改归属 |
|---|---:|---|
| `docs/handoff.md` | +2/-1 | provider 归属与 v4 历史迁移交接 |
| `src/electron/main.js` | +6/-1 | 设置持久化边界丢弃 pre-v4 OpenCode 校准 |
| `src/electron/renderer/app.js` | +11/-8 | OpenCode Go 卡改读 `opencode-go` provider 组件 |
| `src/shared/collector.js` | +46/-1 | DSH route provider 恢复；保持 tokscale 合法 session grouping |
| `src/shared/dshSessions.js` | +41/-0 | 从 DSH assistant message 嵌套 source 读取 provider/model |
| `src/shared/quotaTokenEstimate.js` | +15/-6 | provider 组件推算与 calibration version 保留 |
| `src/shared/usage.js` | +56/-0 | provider 聚合字段的输入、归一化、合并 |
| `tests/electron/quotaTokenEstimateSync.test.js` | +8/-2 | v4 迁移与 provider 读取断言 |
| `tests/shared/collectorForceLimits.test.js` | +13/-0 | DSH route provider 恢复回归 |
| `tests/shared/dshSessions.test.js` | +28/-0 | DSH provider/model 提取回归 |
| `tests/shared/quotaTokenEstimate.test.js` | +13/-0 | OpenCode Go provider 隔离推算回归 |
| `tests/shared/usage.test.js` | +20/-0 | client 与 API provider 独立聚合回归 |
| `worker/src/shared/quotaTokenEstimate.js` | +15/-6 | `src/shared` 生成副本 |
| `worker/src/shared/usage.js` | +56/-0 | `src/shared` 生成副本 |

后续核验方法：先排除本盘点文件，再将 `git diff --binary -- <上述14路径>` 的 Git blob 与本节基线比较；若有后续有意修改，则逐文件用 `git diff HEAD -- <path>` 确认基线 hunk 仍存在，并用 `.git/dsh-preflight-working-tree.patch` 做三方人工核对。任何基线 hunk 消失都必须能对应一项明确、已验证的替代实现，不能以“整理代码”为由消失。

## 2. 根因与数据流

### 2.1 状态开始偏离的位置

偏离发生在**用量归属输入/处理边界**，不是卡片 HTML：OpenCode Go 是 API 渠道额度，但旧卡以 `client=opencode` 的全部 token 校准。客户端表示“谁发起调用”，provider 表示“费用/额度归谁”；把 client 当 provider 会把 OpenCode 经 DeepSeek 等第三方渠道的调用混入 Go，甚至令不同卡的历史看起来相同。

证据链：

1. **输入**：OpenCode 本地 DB 明确以 `providerID = 'opencode-go'` 识别 Go（`src/shared/opencodeLimits.js:121-128`）；官方 Go key 的 id 也是 `opencode-go`（`src/shared/opencodeGoApi.js:24-29`）。
2. **处理**：Tokscale session 行仍携带 provider；`src/shared/usage.js` 的基线修改在 `addUsageRowToPeriod` 将 `row.provider*` 归一化后写入 provider 聚合，而 client 聚合继续独立存在。DSH 的 OpenAI-compatible route 会被 tokscale 归为协议族，因此 `src/shared/collector.js` + `src/shared/dshSessions.js` 从 DSH 原始嵌套 `message.source.provider` 恢复实际 route id，且遇到同 model 多 route 时拒绝猜测。
3. **存储**：每个 period 新增 provider 维度；设置中的 OpenCode calibration 从 version 4 起代表 provider 口径，`src/electron/main.js:570-581` 在持久化归一化边界丢弃旧 client 口径历史。
4. **同步**：`src/electron/main.js:2355-2383` 生成旧 Codex singular `quotaTokenEstimate` 与新增 provider-keyed `quotaTokenEstimates.codex/opencode`；`src/shared/usage.js:908-918, 1136-1153, 1408-1412` 负责规范化、limits-only/普通更新保留和 authenticated `devices[]` 输出。
5. **输出/推算**：Codex 保持 `clientComponents(..., 'codex')`；OpenCode Go 基线修改改为 `providerComponents(..., 'opencode-go')`，并把同一 provider 组件送入 `estimate`、`advanceCalibration`、`rawCapacityFromObservations`。卡片只选择 limits provider `opencode` 中 `accountLabel === 'Go'` 的账户。

### 2.2 历史存储边界

- 额度校准历史：本地 `settings.json -> quotaTokenEstimate.calibration/opencodeCalibration`；同步时只发送脱敏 accountKey、百分比、等价 token、四组件、时间与 reset 时间。pre-v4 OpenCode 历史必须删除，因为它是错误的 client 口径。
- 用量 History：`historyAvailable` 是能力位；`history` 缺失表示本 tick 无更新、`null` 表示不可用、对象表示替换 retained history（`src/shared/usage.js:920-925`）。它由 `src/shared/history.js` 的日/月 client/model 图生成，当前没有 provider 维度，不能冒充 OpenCode Go provider 历史。
- Period live/all-time：provider 新字段属于 period wire shape，随 normalize/merge/aggregate 跨设备相加；它们不是 retained History 的替代品。

## 3. 当时提出的保留要求（已被最终决策取代）

### 设置与容量卡（已删除，不得恢复）

- 当时要求保留 `quotaTokenEstimate.enabled/capacity/reservePercent/weights`；最终实现已删除这些设置。
- 当时要求保留 `quotaTokenEstimate.calibration` 与 `quotaTokenEstimate.opencodeCalibration`；最终实现已删除校准路径。旧设置只在输入边界被容忍并丢弃。
- 当时要求保留 `clientComponents`、`providerComponents`、`equivalentTokens`、`rawTokenProjection`、`rawCapacityFromObservations`、`cycleSummaries`、`estimate`、`advanceCalibration`、`fitDeductionModel` 及同步 normalize/select 函数；最终实现已删除这些容量推算契约及其模块。
- 当时的 Codex 默认 client 与 OpenCode 卡片调用约束随容量功能一并失效，不得恢复其调用。
- `opencode` limits provider id 与 `opencode-go` usage provider id 的归属区分仍然有效，但只用于官方百分比观测与审计统计，不再服务于容量卡或容量推算。

### Period wire shape

- 既有核心/兼容字段必须保留：`totalTokens/costUsd`、client/model/component maps、`clientModels/clientModelCosts`、`projects/sessions`、`capabilities`。
- 新增且必须保留：`providerTokens`、`providerCosts`、`providerCacheReads`、`providerCacheWrites`、`providerOutputs`、`clientProviders`。
- provider 字段必须经过 `emptyPeriod -> addUsageRowToPeriod -> normalizePeriod -> addPeriodInto/mergePeriods -> normalizeDeviceRecord -> aggregateDevices` 全链；不能只在 renderer 临时推导。
- `clientProviders` 是诊断/交叉归属矩阵，不能替代 provider 四组件；仅有总 token 无法按 cache/output 权重推算容量。

### 同步兼容

- 当时要求保留 legacy `quotaTokenEstimate` 与 additive `quotaTokenEstimates.codex/opencode`；最终实现已删除这些 wire 字段。Hub/Worker 必须丢弃旧设备传入的字段，不能继续读取、转发或合并。
- 当前同步契约只保留官方额度百分比观测历史：有界、净化、按 provider 合并，且 limits-only 更新不得覆盖另一 provider 的已有观测。
- `historyAvailable/history/periodWindows` 的缺失与 null 语义及 history-less tick carry-forward 仍按各自现行协议维护，与已删除的容量快照无关。

### 共享源码与 Worker

- `src/shared/usage.js` 及其 Worker 生成副本仍遵循单一事实源和 `npm run sync:worker` 规则。
- `src/shared/quotaTokenEstimate.js` 与 `worker/src/shared/quotaTokenEstimate.js` 已删除，**不得恢复**，也不得重新加入 Hub build 闭包。
- 修改仍存在的共享闭包后，继续执行 `npm run sync:worker`、相关测试，并在最终稳定后执行一次 `npm run update:hub-build`；不能手改 generated Worker metadata。

### Provider 归属修正路径

- 必须保留 `src/shared/collector.js` 的合法 tokscale grouping `client,session,model`；注释已记录 `client,session,provider,model` 会令扫描失败，不能为“字段齐全”改回非法组合。
- 必须保留 `src/shared/dshSessions.js` 的嵌套 provider/model 提取和 ambiguous-route fail-closed。
- 必须保留 `src/shared/opencodeLimits.js` 的 `providerID='opencode-go'` SQL 过滤、`src/shared/opencodeGoApi.js` 的 `GO_AUTH_PROVIDER_ID='opencode-go'`。
- 必须保留对应六组聚焦测试，尤其 provider/client 隔离、DSH route 恢复、v4 迁移与 Worker 同步测试。

## 4. 待删清单（仅限明确废弃/污染内容）

1. **应删除/拒收**：`opencodeCalibration.version < 4` 的持久化与同步历史。现有基线已在 main 设置归一化边界和 renderer 双重拒收；后续不得恢复兼容读取，否则污染历史会复活。
2. **应删除/禁止重新引入**：OpenCode Go 卡中 `clientComponents(period, 'opencode')` 作为额度校准来源，以及 `estimate` 未指定 `usageProvider: 'opencode-go'` 的调用。
3. **应删除/禁止重新引入**：把 DSH `yx`/实际 route 统一写成协议族 `openai` 的归属结果；无歧义时应恢复 route，有歧义时保持原值而不是猜测。
4. **确认已不存在，继续保持删除**：`src/shared/opencodeGoQuota.js`、`tests/shared/opencodeGoQuota.test.js`、`worker/src/shared/opencodeGoQuota.js`。当前 token 容量方案不再使用旧“美元/请求数换算模块”；不要仅因旧 plan 文本仍提到它而复活。
5. **展示层候选删除，不得误删底层字段**：卡片冗余文案/指标可按产品要求精简，但 `confidence`、capacity samples、组件权重等共享函数返回字段仍可能被 Worker/测试/其他消费者使用，除非先完成全仓调用证明和协议迁移。

## 5. 当前缺口（后续实施项，不在本盘点中覆盖基线）

- `docs/API.md` 的 period 示例与字段说明尚未列出六个 provider 聚合字段；它们已进入 wire shape，后续必须补文档，不能以“文档未写”为由删除实现。
- retained `history.js` 只有 client/model 维度；若产品要求跨日 provider 历史，需要新增版本化 provider history，而不能把 `perClient.opencode` 当作 `opencode-go`。
- provider 聚合字段属于新增 wire 数据，需评估同步 payload 裁剪/归档路径是否完整保留；验证必须覆盖 normalize、merge、聚合、limits-only、旧记录缺字段五种情况。

## 6. 验证时并发工作树告警

完成第 1 节快照后、执行验证期间，工作树被另一执行者继续修改：新增改动涉及 `docs/API.md`、`tests/shared/deviceWireCompatibility.test.js`，且多个基线路径的 numstat 已变化（例如 renderer 从基线 `+11/-8` 变为大幅删除）。因此本轮**没有**把验证时的当前 diff 误写成初始基线，也没有 reset/checkout/覆盖这些并发修改；初始 patch 与三项 hash 保持为唯一可复现证据。

反馈闭合结果：共享 provider 数据流聚焦测试 113/113 通过；包含 renderer 静态契约的 `tests/electron/quotaTokenEstimateSync.test.js` 验证失败，因为并发重构后的 `app.js` 已找不到该测试仍要求的 `quotaOpenCodeEstimateCard`、`selectSyncSnapshot(...)` 和局部 settings-save 字面结构。接手者必须先判断这些契约是否已迁移到 main/process 层，再更新测试或恢复输出；在此之前不能宣称整体验证通过。
