# 任务清单

> 本轮拆解自 `docs/plan.md` 当前迭代「GPT 额度趋势精简与 OpenCode Go 统计」。
> 每个任务一个 commit，commit message 包含任务 id。依赖：无标注的按先后顺序串行。

## ID 约定

- `Q1`–`Q3` 针对 GPT（Codex）额度趋势卡的逻辑修复与精简。
- `G1`–`G4` 针对 OpenCode Go 的新增统计与同步。
- `C1` 人民币计价。
- `R1` 回归验收。

## 任务与依赖

- [ ] **Q1** 修复 Codex 周期切分（依赖：无）
  - 描述：`cycleSummaries` 与 `advanceCalibration`（`src/shared/quotaTokenEstimate.js`）的边界判定，
    不再被「相对/滚动 resetsAt 漂移」误切。先确认 Codex RPC 载荷 `window.resetsAt ?? window.resets_at`
    （`mapCodexRateLimitsToProvider`，`src/shared/limitCollector.js` 2290）返回的具体形态（绝对时间 vs
    相对秒/滚动窗口）。
  - 验收标准：同一周期内 resetsAt 秒级抖动不产生新周期；真正重置（remainingPercent 显著回升 >1 或
    resetsAt 语义明确改变）仍正确封存上一周期；新增回归测试覆盖 resetsAt 漂移场景。

- [ ] **Q2** 重写预估总容量算法（依赖：Q1）
  - 描述：按 plan.md QUOTA.META2 的分层算法改造 `src/shared/quotaTokenEstimate.js`：整周期全量回归、
    累计比值+加权分位数、硬下限不变量、官方变化回补、稀疏时累计外推。
  - 验收标准：容量结论永不低于当前周期实际消耗（硬约束）；≥1 个完整周期样本后稳定收敛、不受单次 cache
    巨值拉扯；无完整周期时显示累计口径外推而非「学习中」；官方削减/扩充可回补；新增测试覆盖「长周期稀疏
    样本」「单点 cache 巨值」「累计比 vs 相邻差」三类场景。

- [ ] **Q3** 精简 GPT 卡片（依赖：Q1）
  - 描述：`quotaTokenEstimateCard()`（`src/electron/renderer/app.js` 约 5230–5292）删除「多设备今日全部
    工具 Token」「估算可信度」两行，精简废话文案。
  - 验收标准：删除项不出现；保留一句必要的周期/归一化说明；卡片指标顺序合理、中文可读；删除项不破坏
    `quotaTokenEstimate` 闭包中仍被 Worker 引用的函数契约；现有相关测试全绿。

- [ ] **G1** 泛化预估闭包（依赖：Q2）
  - 描述：`quotaTokenEstimate.js` 的 client/weights/窗口选择去掉 `codex` 硬编码，新增可注入 clientId、
    provider（codex / opencode）与「百分比 → 额度」换算钩子。
  - 验收标准：codex 路径行为与改造前完全兼容（现有测试全绿）；opencode 可用同一闭包；无 Node 内建依赖，
    Worker 可移植。

- [ ] **G2** OpenCode Go 额度换算层（依赖：G1）
  - 描述：新增 `src/shared/opencodeGoQuota.js`，内置官方文档（https://opencode.ai/docs/zh-cn/go）的模型→
    价格 / 每请求 token 组合 / 每月使用额度表（env 覆盖 `TOKEN_MONITOR_OPENCODE_GO_*` 以应对官方变更）；
    把 usedPercent + 本地 Go 用量 components 换算为「剩余请求数 / 剩余美元额度 / 预估请求容量」。
  - 验收标准：官方未给 used/limit 美元值时明确降级（不伪造精度）；支持「≤/> token 阈值」「Peak/Off-Peak」
    两档价的解析，缺档回退默认价；未知模型走通用回退而非报错；单测覆盖换算与降级。

- [ ] **C1** 人民币计价（依赖：G2）
  - 描述：GPT 卡与 OpenCode Go 卡的额度/容量/成本相关金额用人民币（¥）呈现，复用
    `currencyApi.formatCurrencyFromUsd(value, 'CNY')`；金额仅在展示层转换，存储/同步/API 仍用 USD。
  - 验收标准：OpenCode Go 三档额度显示 ¥ 等价；每模型成本换算用人民币；汇率沿用「覆盖 > 实时 > 内置 6.8」
    优先级；不破坏 wire shape；范围仅限两张额度卡，其余界面保持全局币种默认。

- [ ] **G3** 渲染 OpenCode Go 卡片（依赖：C1）
  - 描述：`quotaTokenEstimateCard()` 泛化为支持 codex + opencode 两张并列卡（位置一致），OpenCode Go 卡
    维度对齐 GPT 卡并额外展示周期数（session/weekly/monthly）。
  - 验收标准：无 Go 订阅/凭据时隐藏而非报错（沿用 entitled/notConfigured 语义）；多设备今日 OpenCode 汇总
    沿用现有 stats 派生；卡片文案经 i18n 或保持中文可读。

- [ ] **G4** 同步与多设备（依赖：G3）
  - 描述：OpenCode Go 校准快照沿用现有 `quotaTokenEstimate` 同步字段（版本化、按 accountKey 选择、离线
    本地回退、limits-only 不覆盖）。
  - 验收标准：扩展字段满足 Worker 可移植（无 Node 内建依赖）；旧 Hub/客户端忽略未知字段仍工作；若改动共享
    闭包需补跑 `npm run sync:worker`（`scripts/sync-worker-shared.js`）防 CI 漂移。

- [ ] **R1** 回归、审查与交付（依赖：C1、G1–G4）
  - 描述：全量回归 + 自审 + 打包 + 安装本机验证。
  - 验收标准：`npm run verify`（lint + test）通过；新增/更新测试覆盖周期切分、容量下限、OpenCode 换算、
    人民币计价、卡片精简与 OpenCode 渲染；自审后打包安装并按 `AGENTS.md` 交付。

## 实施顺序

`Q1 → Q2 → Q3 → G1 → G2 → C1 → G3 → G4 → R1`

其中 `Q3` 仅依赖 `Q1`，可与 `Q2` 并行；`R1` 依赖其余全部。
