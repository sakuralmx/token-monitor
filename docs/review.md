# 审核报告

## 范围

- commits `98dc6d8..ff7cf63` 与其后的长期额度百分比历史修复。
- 目标：删除 Codex/OpenCode Go Token 容量预估；保留各账户官方百分比长期历史；连续相同百分比仅保留平台期首尾；支持 Electron、headless、Node Hub、Worker 与多设备同步。

## 发现及修复

1. **严重：旧 pending 在主进程规范化时丢失。** 统一规范化保留 pending；绑定时与已有账户历史共同合并。
2. **严重：每个 provider 只有一个账户槽。** 升级为 `provider.accounts[accountKey]`，A→B→A 不覆盖；采集遍历全部 provider 行。
3. **一般：Headless Agent 不记录历史。** agent runtime 转发 `transformRecord`，agent 在共享数据目录持久化本地历史。
4. **严重：长期历史进入普通 ingest，最终超过 1 MiB。** `serializeSyncPayload` 的所有重建路径都剥离历史；新增认证 `/api/quota-history` 独立数据面，以最多 200 条分块上传。
5. **严重：多设备同账户历史没有形成并集。** Node/Worker Hub 使用 hub-scoped 历史，按 provider/account/timestamp 幂等合并并压缩。
6. **严重：Hub 写失败后内存与磁盘不一致。** 专用历史写及旧 ingest 兼容导入均在 persist 失败时回滚。
7. **一般：每次重传完整历史。** Electron settings 与 headless 文件分别保存成功上传的 observation timestamp 集合；迟到的旧时间观测仍会上传，不会被最大时间游标跳过。
8. **严重：旧顶层 accountKey 被忽略。** 迁移读取 `legacy.accountKey` 与 `legacy.opencodeAccountKey`，避免把已知 A 账户历史绑定到 B。
9. **安全/隐私。** 仅接受非 `source=local` 官方窗口；公共 stats 不读取 quota history；GET/POST 历史端点位于现有 secret gate 后。

## 验收结果

- `npm run lint`：通过。
- 聚焦测试：67/67 通过。
- 完整 `npm test`：3509 tests，3502 passed，0 failed，7 skipped。
- Hub build registry：与当前 Node/Worker 闭包一致。
- `git diff --check`：通过。

## 结论

审核问题已闭合，当前交付满足功能、迁移、长期数据、普通同步大小、失败回滚与隐私边界要求，可以进入 Windows 打包与本机重装验收。
