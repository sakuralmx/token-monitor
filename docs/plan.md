# Token Monitor 个人多设备同步与会话目录规划

> 本文件是当前功能目标的长期规划。实现阶段必须继续遵守 `AGENTS.md` 的兼容性、生成文件和验证约定。

## 目标

1. 仅运行 Token Monitor 客户端即可让多台不会同时在线的个人设备汇总数据；中转端使用阿里云 Node Hub，不要求域名、Cloudflare 或 Tailscale。
2. 恢复 Cherry Studio 会话的工作区与简要标题，并以同一套数据模型支持 Codex 和 DSH。
3. 只同步统计数据和安全的会话元数据，不上传原始会话正文、提示词、回答、凭据或本地绝对路径。
4. 会话目录永久保留；设备离线、重装或历史日志轮转后，已同步的会话标题与工作区仍可查询。

## 当前迭代：GPT 额度趋势精简与 OpenCode Go 统计

### 背景与现状（已确认根因）

- `src/shared/quotaTokenEstimate.js` 是额度预估的共享闭包（同时被 renderer 与 Worker 使用），暴露
  `clientComponents / equivalentTokens / rawCapacityFromObservations / cycleSummaries / estimate /
  advanceCalibration / fitDeductionModel` 等函数。
- 渲染卡位于 `src/electron/renderer/app.js` 的 `quotaTokenEstimateCard()`（约 5230–5292 行），当前固定展示
  GPT/Codex 一张卡，文案硬编码中文，含一组指标行 + 「额度周期 Token 记录」历史列表。
- 额度周期分组由 `cycleSummaries` / `advanceCalibration` 的「重置边界」判定驱动：当
  `resetsAt` 变化、`remainingPercent` 上升 >1、或 `localEquivalent` 回退时视为跨周期。
- Codex provider 的 `windows[].resetsAt` 直接来自 RPC 载荷的 `window.resetsAt ?? window.resets_at`
  （`mapCodexRateLimitsToProvider`，`limitCollector.js` 2290）。若上游返回的是**相对滚动时间戳**或
  每次刷新重算的「剩余秒数」，则同一周期内的 `resetsAt` 会逐次漂移，导致 `cycleSummaries` 把一个周期
  误切成多条（用户观测到 8/17「额度 5%→1%」与 8/14「额度 75%→1%」并存却是同一周期）。
- OpenCode Go 官方额度以 **USD 计**：5 小时 $12 / 每周 $30 / 每月 $60，非百分比、非 token 数。官方文档
  （https://opencode.ai/docs/zh-cn/go）给出每模型的「每请求预估输入/缓存/输出 token 组合」+「每 1M token
  价格」+「每月使用额度」，可据此推导每个模型在 $12/$30/$60 三个窗口内的**请求数上限**。现有采集链
  `opencodeGoApi.js`（官方 usage API，返回 rolling/weekly/monthly 的 `percent` 与 `resetsAt`）、
  `opencodeWeb.js`（cookie 抓 Go 页面）、`opencodeLimits.js`（本地 SQLite 估算）已存在。
- OpenCode Go 窗口最终经 `normalizeLimitWindow`（`limits.js` 171）同样得到 `remainingPercent = 100 - usedPercent`，
  与 Codex 对齐，故预估闭包可复用；但 `used`/`limit`（美元）官方 API 不返回，需要 OpenCode 专有的
  「百分比 → 请求数 / 剩余额度」换算层。

### 目标

1. 精简 GPT（Codex）额度趋势卡：去掉重复与无意义内容，保留有价值指标，修正周期切分与预估总容量逻辑。
2. 新增 OpenCode Go 统计卡，维度与位置与 GPT 卡一致，增加「周期数」维度，并基于官方文档的模型
   请求/价格/用量表做额度换算与预估。

### 任务与验收标准

- [ ] QUOTA.META1 Codex 周期切分修复
  - 验收标准：`cycleSummaries` 与 `advanceCalibration` 的边界判定不再被「相对/滚动 `resetsAt` 漂移」误切；
    同一周期内 `resetsAt` 秒级抖动不产生新周期；真正重置（`remainingPercent` 显著回升或 `resetsAt` 语义
    明确改变）仍能正确封存上一周期；新增回归测试覆盖 `resetsAt` 漂移场景。
- [ ] QUOTA.META2 预估总容量算法修正（重写，解决「周期长、样本少」）
  - 背景（已确认瓶颈）：`advanceCalibration` 生成样本要求单次刷新 `deltaPct >= 0.2 && deltaLocal >= 100`，
    `rawCapacityFromObservations` 要求跨相邻 observation 的 `deltaPercent > 0 && raw >= 100`——两者都以
    「相邻两点」为采样单元。额度周期以月计、刷新频繁时，单点 percentage 下降常常 <0.2 或被 cache 波动吃掉，
    大量观察被丢弃，样本长期不积累，容量停留在「学习中 / low confidence」或严重偏低。
  - 核心思路（按数据来源分层，从「有」到「无」逐步兜底）：
    1. **整周期全量回归**：不以相邻点为单位，而以「每个已封存周期的首尾两点」为回归样本——用
       `(cycleStart.remainingPercent - cycleEnd.remainingPercent)` 作为消耗比、`(cycleEnd.components -
       cycleStart.components)` 作为实耗，直接解出每个完整周期的容量，得到一个「每次重置才更新但极少受噪声
       影响」的强锚点；周期越长越准。
    2. **均值/分位数替换中位数**：把 `rawCapacityFromObservations` 的单次 `deltaPercent` 相邻采样改为
       「当前周期内累计消耗 / 累计百分比」的**累计比值**（cumulative ratio），并把容量估计从「中位数」改为
       「加权分位数 + 累计比值上限归并」，避免 cache 波动个别巨值/低值直接决定容量。
    3. **硬下限兜底**：任何时刻 `capacity = max(容量估计, 当前周期已观测消耗 / 已消耗百分比 × 100)`，
       保证「预估值永远 ≥ 当前周期实际消耗」；这是**绝对不变量**，先于一切拟合结论。
    4. **官方变化回补**：当官方额度削减/扩充信号（如历史完整周期容量中位数与当前周期累计比值偏离超过阈值、
       或 residuals 连续爬升）出现时，用「当前周期累计比值」作为近期容量主导项，向历史锚点做衰减融合，
       而不是继续引用旧的整周期容量。
    5. **数据不足时的诚实退化**：样本不足一个完整周期之前，只显示「当前周期累计消耗 + 已消耗百分比」的
       线性外推（标注为「累计口径」），不再显示凭空的中位数容量；一旦有一个完整周期样本即切换为强锚点口径。
  - 验收标准：任何容量结论 ≥ 当前周期实际消耗（硬约束）；有 ≥1 个完整周期样本后容量稳定收敛、不受单次
    cache 波动大幅拉扯；无完整周期时显示累计口径外推而非「学习中」空转；官方削减/扩充时可回补调整；
    新增测试覆盖「长周期稀疏样本」「单点 cache 巨值」「累计比 vs 相邻差」三类场景。
- [ ] QUOTA.META3 精简 GPT 卡片
  - 验收标准：移除「多设备今日全部工具 Token」（首页已有）、「估算可信度」两处冗余项；文案去掉无意义
    废话（保留一句必要的周期/归一化说明，其余口号删除）；卡片视觉与指标顺序合理，中文文案经 i18n 或
    至少保持可读；删除项不破坏 `quotaTokenEstimate` 闭包中仍被 Worker 引用的函数契约。
- [ ] QUOTA.GO1 泛化预估闭包使其可复用
  - 验收标准：`quotaTokenEstimate` 的 client/weights/窗口选择不硬编码 `codex`；新增可注入的
    `clientId`、`provider`（codex / opencode）、以及 provider 专属「百分比 → 额度」换算钩子；codex 路径行为
    与改造前完全兼容（现有测试全绿）。
- [ ] QUOTA.GO2 OpenCode Go 额度换算层
  - 验收标准：新增 OpenCode 专有模块（建议 `src/shared/opencodeGoQuota.js`），内置官方文档的模型→价格/
    每请求 token 组合/使用额度表（env 可覆盖以应对官方变更）；能把 `usedPercent`（各窗口）+ 本地 Go 用量
    components 换算为「剩余请求数 / 剩余美元额度 / 预估请求容量」，并在官方未提供 `used/limit` 美元值时
    给出明确降级（不伪造精度）。
- [ ] QUOTA.GO3 渲染 OpenCode Go 卡片
  - 验收标准：在 limits 面板与 GPT 卡并列（位置一致）渲染 OpenCode Go 卡；维度对齐 GPT（官方剩余额度、
    预估总容量、预估剩余、缓存命中比例、已覆盖周期、预计可用等）并**额外展示周期数**（session/weekly/
    monthly）；无 Go 订阅/凭据时隐藏而非报错（沿用现有 `entitled/notConfigured` 语义）；多设备今日 OpenCode
    汇总沿用现有 stats 派生。
- [ ] QUOTA.GO4 同步与多设备
  - 验收标准：OpenCode Go 的校准快照沿用现有 `quotaTokenEstimate` 同步字段（版本化、按 accountKey 选择、
    离线本地回退、limits-only 不覆盖），扩展字段满足 workers 可移植（无 Node 内建依赖），旧 Hub/客户端忽略
    未知字段仍工作。
- [ ] QUOTA.CNY 人民币计价
  - 背景：货币链路已完备（`currency.js` 支持 USD/TWD/HKD/CNY，内置 CNY=6.8 硬编码兜底；`exchangeRates.js`
    经 @fawazahmed0/currency-api 拉实时汇率；renderer `formatCost()` 已按 `state.settings.currency` 转换，
    设置页有币种选择器 + 汇率 auto/manual）。但 **GPT 额度趋势卡当前只显示 Token/百分比，无成本维度**；
    OpenCode Go 的额度是美元口径（$12/$30/$60），本地 SQLite 的 `cost` 也是美元。
  - 目标：GPT 卡与 OpenCode Go 卡的额度/容量/消耗相关金额一律用人民币呈现（`¥`），遵循用户「尽可能用
    人民币」的偏好；涉及「美元 → 人民币」的换算复用现有 `currencyApi.formatCurrencyFromUsd(value, 'CNY')`。
  - 验收标准：OpenCode Go 的 $12/$30/$60 三档额度在卡片上显示为 `¥` 等价金额（含换算，非原文美元）；
    Go 每个模型「每月使用额度 / 每 1M token 价格」换算出的成本用人民币显示；GPT 卡若新增成本相关指标
    同样走人民币；汇率来源沿用现有「覆盖 > 实时 > 内置 6.8」优先级，不新造汇率源；币种仍是全局设置
    （默认 USD 不变，但本卡片默认优先人民币或以 `CNY` 呈现额度口径），需要时加一个该卡专属的币种说明，
    且不破坏 `docs/API.md` 的 wire shape（金额仍以 USD 存储与同步，仅展示层转换）。
- [ ] QUOTA.META5 回归、审查与交付
  - 验收标准：`npm run verify`（lint + test）通过；新增/更新测试覆盖周期切分、容量下限、OpenCode 换算、
    人民币计价、卡片精简与 OpenCode 渲染；自审后打包安装本机版本并按 `AGENTS.md` 流程交付。

### 实施顺序（建议）

`QUOTA.META1（周期切分）→ QUOTA.META2（容量）→ QUOTA.META3（精简 GPT 卡）→ QUOTA.GO1（闭包泛化）→ QUOTA.GO2（OpenCode 换算）→ QUOTA.CNY（人民币）→ QUOTA.GO3（OpenCode 卡）→ QUOTA.GO4（同步）→ QUOTA.META5（验收）`

先修 GPT 卡的逻辑 bug（切分/容量），再精简 UI，最后做 OpenCode 的泛化与新增，保证每一步都独立可验证、
每任务一个 commit（commit message 含任务 id）。

### 已确认的细节约束

- 「多设备今日全部工具 Token」对应 `quotaTokenEstimateCard` 中 `todayAll` 一行，首页/总览已展示，删除。
- 「估算可信度」来自 `rawCapacityFromObservations`/`fitDeductionModel` 的 `confidence`（high/medium/low），
  用户判定无意义，卡片展示层移除；底层函数与字段保留（避免破坏 Worker/测试契约）。
- OpenCode Go 额度是美元口径（$12/$30/$60），百分比换算需要 OpenCode 专属系数，不能用 Codex 的默认
  weights 直接复用；默认 weights 的 `cacheRead:0.1 / output:6` 等是 Codex 的 token 权重，与 Go 的美元定价
  无关，须在 Go 换算层单独建模。
- 官方 Go limits 中 GPT 5.6 Luna / Qwen Plus / DeepSeek V4 等模型存在「≤/> token 阈值」与「Peak/Off-Peak」
  两档价，换算层至少支持「默认档 + 阈值/时段档」的解析，缺档时回退默认价。
- 人民币计价：所有金额在**展示层**转换，存储/同步/API 仍用 USD（`costUsd`、`used/limit` 美元），避免破坏
  wire shape 与 Worker 可移植性；CNY 汇率优先级沿用「用户覆盖 → 实时 → 内置 6.8」。OpenCode Go 的官方
  美元额度（$12/$30/$60）与每模型价格表在 `opencodeGoQuota.js` 内以美元为单一事实源，展示时才转人民币。
- **拍板结论（2026 需求更新）**：① 人民币计价范围仅限 GPT 额度趋势卡 + OpenCode Go 卡两张卡的额度/容量/
  成本相关金额，其余界面保持全局币种设置（默认 USD）不变；② 数据不足（无完整周期样本）时段，容量栏显示
  「累计口径」的线性外推（当前周期累计消耗 ÷ 已消耗百分比），并明确标注「累计口径/估算中」，拿到首个完整
  周期样本后切换为整周期强锚点口径。

## 已确定方案（历史迭代，长期保留）

### 多设备中转

- 阿里云 ECS 常驻 Node Hub，客户端地址为裸公网 IP 的 HTTPS URL。
- Let's Encrypt IP 证书由 Certbot 自动续期；独立 HTTPS 反向代理把 443 转发到仅监听 `127.0.0.1:17321` 的 Hub。
- 客户端仍使用现有共享密钥认证、SSE 更新和 HTTP 回退机制。每台设备只需启动 Token Monitor；无需 VPN、Tailscale 或额外客户端。
- Hub 保存设备最新记录和中心化会话目录，因此设备不必同时在线：A 上传后关机，B 稍后上线仍可读取 A 的数据。
- 服务器秘密、证书私钥和实际部署凭据不进入 Git；仓库只记录部署模板、升级与备份步骤。

### 会话目录

- 新增统一 `SessionCatalogEntry`，主键为 `deviceId + client + sessionId`，至少包含：稳定会话 ID、客户端类型、脱敏工作区键、工作区显示名、标题、首次/最后活动时间、消息数及可选统计摘要。
- 标题优先采用客户端已有的本地标题；没有时取第一条有效用户消息并做本地截断与清洗。禁止调用 AI 生成标题。
- 工作区仅同步稳定哈希/规范化项目键和安全显示名；不得同步用户名、主目录或本地绝对路径。
- Cherry Studio、Codex、DSH 分别实现本地适配器，输出统一模型。解析失败必须按文件/会话隔离，不能中断用量采集。
- Hub 的永久会话目录使用 SQLite。优先评估 Node 24 内置 `node:sqlite`，避免给 Electron 主程序增加原生依赖；若兼容性验证不满足，再单独讨论依赖方案，不在实现时擅自新增依赖。
- 展示层按工作区分组，工作区内按最后活动时间倒序；保留“全部会话”和客户端筛选。总量来自永久目录，今日/月度使用现有周期窗口计算。

### Codex 额度统计与预估多设备同步（历史迭代结论，仍适用）

- 校准数据是额度百分比与分类 Token 累计值，不同步 Codex 凭据或账户可读身份；账户关联仅使用现有不可逆 `accountKey`。
- 多账户不得混合学习：聚合快照必须与当前展示的 provider 账户键匹配；缺失账户键时只采用明确来源设备对应的兼容快照。
- 校准数组必须沿用现有数量边界（`SYNC_SAMPLE_LIMIT=256` / `SYNC_OBSERVATION_LIMIT=512`）并在归一化时丢弃异常值。

## 任务清单（历史遗留，长期跟踪）

- [ ] T1 固化阿里云 Hub 部署
- [ ] T2 完成客户端公网 Hub 配置体验
- [ ] T3 定义会话目录兼容协议
- [ ] T4 实现本地隐私清洗与统一模型
- [ ] T5 恢复 Cherry Studio 会话适配
- [ ] T6 增加 Codex 会话适配
- [ ] T7 增加 DSH 会话适配
- [ ] T8 实现 Hub SQLite 永久目录
- [ ] T9 实现增量同步和冲突规则
- [ ] T10 实现按工作区分组的会话 UI
- [ ] T11 端到端与运维验收

## 风险点与对策

- **`resetsAt` 语义不稳定**：先确认 Codex RPC 返回的具体形态（绝对时间 vs 相对秒/滚动窗口），修复以「语义
  层」为准而非字符串相等；必要时在 `advanceCalibration` 用「小幅容差 + 百分比回升」替代对 `resetsAt` 的严格
  不等比较，并保留真正重置的封存能力。
- **容量算法过度拟合 cache 波动**：用多周期历史区间 + 当前 mix 归一化的中位数/分位数容量（现有
  `rawCapacityFromObservations` 已具备雏形），叠加「当前周期消耗下限」硬约束；明确区分「显示比例」与
  「容量估计比例」。
- **OpenCode 美元口径误用 token 权重**：Go 换算层单独建模，禁止直接复用 Codex 默认 weights；官方未给
  `used/limit` 时显示「请求数/额度估算」而非伪造美元精度。
- **官方 Go 文档价格变动**：内置表用常量 + env 覆盖（`TOKEN_MONITOR_OPENCODE_GO_*`），并提示引用文档日期；
  未知模型走通用回退而非报错。
- **Worker 可移植性**：任何新增共享逻辑不进 `node:` 内建依赖；若修改共享闭包需补跑 `npm run sync:worker`
  （`scripts/sync-worker-shared.js`），保证 CI 不漂移。
- **客户端/旧版兼容**：只做增量字段与展示层改动，不破坏 `docs/API.md` 既有 wire shape；新增同步字段
  版本化、可被旧 Hub 忽略。

## 最终验收定义

在所有设备均未安装或运行 Tailscale、Cloudflare 客户端及其他同步软件的情况下，仅启动 Token Monitor：
设备能通过受信任 HTTPS 把统计和安全会话元数据写入阿里云 Hub；另一台稍后上线的设备能读取聚合统计；GPT
额度趋势卡逻辑正确（周期不误切、容量不低估、无冗余项），OpenCode Go 卡按官方口径正确展示额度与周期，
并按工作区查看 Cherry Studio、Codex、DSH 的永久会话标题目录。任何抓包和 Hub 数据检查均不得发现原始会话
正文、凭据或本地绝对路径。
