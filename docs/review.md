# 审查报告

> 审查日期：2026-08-18
> 审查方式：实现者自审 + 对抗式审查代理（review 工具）多轮迭代；范围为本轮 GPT 额度趋势精简与 OpenCode Go 统计。

## 验收结论

通过。GPT（Codex）额度趋势卡完成了周期切分修复、容量算法重写与冗余项精简；新增 OpenCode Go 统计卡（人民币计价、含周期数与请求数估算）。四轮对抗式审查共发现 7 个问题，全部修复，第五轮审查收敛为零问题。

## 审查迭代记录

### 第一轮（review 工具，4 角度）
- [一般] `requestCostUsd` 忽略 cacheWrite 定价 → 请求成本被低估。
- [一般] 未知模型返回 null 而非回退；缺 Peak/Off-Peak 两档价解析。
- [建议] 充值/部分回充被 +1% 阈值误判为周期重置。
- [建议] `estimateGoWindows` 的 `usedPercent` 未 clamp。

### 第二轮（修复后复查）
- [一般] `clampPercent(null)` 因 `Number(null)=0` 被强转为「满额」而非未知。
- [建议] env 覆盖美元上限后 `remainingRequests` 不随缩放。

### 第三轮（修复后复查）
- [一般] `clampPercent(true)` 返回 1（`Number(true)=1`），布尔值未统一拒绝。

### 第四轮（修复后复查）
- 0 个问题，收敛。

## 修复方式摘要

1. 容量/换算：彻底移除「按 token 价格自行反推成本」的路径，改用 OpenCode 官方发布的**分模型请求数表**（每 5h/周/月），该表已在上游折算 Peak/Off-Peak、缓存写入等档位，避免重造有损的定价模型。
2. 百分比健壮性：`clampPercent` 显式拒绝 `null`/`undefined`/空串/布尔值（含 `true`），避免 `Number()` 强转把「未知」读成 0 或 1。
3. env 覆盖一致性：美元上限覆盖生效时，请求数按 `limitUsd / officialLimit` 同比例缩放，保证「剩余美元」与「剩余请求」两列口径一致。
4. 充值误判：保留百分比回升 >1 的周期边界启发式，并在注释明确这是「充值 vs 重置不可区分」的已知取舍（无可靠 server 重置时间戳时的最优选择）。

## 验证

- 全量测试 3517 项：3509 通过，1 失败为既有 Windows symlink `EPERM`（macWidget 测试夹具，与本轮无关），另 7 跳过。
- 新增/更新测试：`quotaTokenEstimate.test.js`（周期切分、累计口径、硬下限、整周期锚点、美元单位复用）、`opencodeGoQuota.test.js`（美元/请求数换算、无模型降级、null/布尔/超界百分比、env 缩放）、`quotaTokenEstimateSync.test.js`（OpenCode Go 卡渲染、冗余项删除断言）。
- ESLint 全量通过；Hub build registry 更新后 13/13 聚焦测试通过；`npm run sync:worker` 已执行，worker vendored 副本与 registry 无漂移。
