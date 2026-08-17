# 诊断记录：多设备同步连接失败（2026-08-17）

> 状态：**已恢复**（2026-08-17 09:40 UTC，用户在阿里云控制台重启实例后）

## 结论

**根因：阿里云 Hub 服务器（8.130.39.237）上的 HTTPS 服务已挂死（应用层无响应），所有设备均无法连接 → 多设备同步"始终连接失败"。这是服务器侧故障，不是 token-monitor 客户端代码或本机配置问题。**

## 恢复验证（重启实例后）

- `GET https://8.130.39.237/api/health` → 200，`{"ok":true,"role":"hub","runtime":"node-hub","hubBuild":{...}}`，`secretRequired:true`。
- 用 `credentials.json` 的 `hub.clientSecret` 认证 → `/api/devices` 200，**2 台设备在线**：`xm`（本机）、`jyhy-liumingxi`，均持续上报（updatedAt 在检查时刻）。
- `/api/stats` 聚合正常：`periods.today.totalTokens` 459,224,291 / `costUsd` 64.97；`/api/subscriptions` 共享列表完好（codex Plus 1 条）。
- 客户端无需任何改动：widget 3 秒自动重连机制在服务器恢复后自动恢复上报与 SSE 流。
- 注：health 无 `catalogVersion` 字段，服务器 Node 版本可能不支持 `node:sqlite`，会话目录（catalog）不可用，但不影响设备/用量/订阅同步。

## 配置事实（本机 Windows widget）

| 项 | 值 | 来源 |
|---|---|---|
| hubMode | `client` | `%APPDATA%\Token Monitor\settings.json` |
| hubUrl | `https://8.130.39.237`（裸 IP，443） | 同上 |
| 客户端 secret | `2e4e6daf…0ee5d`（credentials.json `hub.clientSecret`） | `%APPDATA%\Token Monitor\credentials.json` |
| 主机 secret | `CqNNMwfW…UXlYi`（credentials.json `hub.hostSecret`） | 同上 |

- `settings.json` 中 `subscriptionsCacheHub = "https://8.130.39.237"`：该字段只在成功从 hub 拉取过共享订阅文档后写入，**证明此 URL 曾连接成功过**（8/16 部署后、8/17 失败前）。
- `~/.ssh/token-monitor-hub-ed25519` 密钥与 `known_hosts` 中 8.130.39.237 条目（8/16 18:00 生成）佐证部署时间点。
- 部署架构与 `docs/plan.md` T1 一致：Node Hub 经 systemd 仅监听 `127.0.0.1:17321`，独立 HTTPS 反代（443 → 回环 17321），Certbot IP 证书。

## 服务器现状探测（本机 → 8.130.39.237，2026-08-17 多次复测）

| 探测 | 结果 | 含义 |
|---|---|---|
| ICMP ping | 3/3 通，38 ms，0% 丢包 | 主机与网络层健康 |
| 22（SSH）TCP 握手 | 成功 | 端口有监听 |
| 22 SSH banner | **超时（banner exchange timeout）** | 应用层无响应 |
| 443 TCP 握手 | 成功 | 端口有监听 |
| 443 TLS 握手 | **超时（无 ServerHello）** | 反代应用层无响应 |
| 443 HTTPS GET（curl -k / Node fetch） | 超时 | 同上 |
| 80 | 拒绝连接 | 无 80 服务（正常，仅 443 对外） |
| 17321 | 不通 | 符合设计：hub 只监听回环，公网仅 443 |

关键判读：**TCP 三次握手全部成功、但所有应用层（sshd、TLS 反代）一律无响应**，且 sshd 与反代同时失效，指向**系统级异常**（资源耗尽 / 负载打满 / 云盾等安全产品隔离 / 服务假死），而非单个 hub 进程故障。若仅 hub 挂掉，nginx/caddy 的 TLS 握手应仍正常并返回 502。

## 客户端侧排除项

- 本机用原生 `curl`（含 `-k`）、`openssl`、Node `fetch` 直连同一 URL，失败形态与 widget 完全一致 → 与 token-monitor 代码无关。
- 本机外网正常（baidu 200），到服务器 ICMP/路由正常 → 非本机网络问题。
- 配置（URL、secret）完整且曾成功 → 非配置问题。

## 已排除的替代通道

- **Cloudflare Worker（备用）**：账户 `727651985lmx@gmail.com`（ID `f5469aae…`）中已部署 `token-monitor-hub` Worker（2026-08-16T08:50Z，含 HubDO + STALE_AFTER_MS 绑定），wrangler OAuth 有效。但本机（大陆网络）访问 `*.workers.dev` 被 DNS 污染：系统 DNS 解析 `token-monitor-hub.727651985lmx.workers.dev` 到腾讯云 IP `159.138.20.20`（8.8.8.8 返回 `108.160.165.189`、1.1.1.1 返回 `31.13.80.169`），443 连接全部超时。大陆网络下 Worker 通道不可用，除非配置自定义域名。
- **阿里云 API 重启**：本机无 aliyun CLI / AccessKey，无法走 API。
- **SSH 备用端口**：扫描 22 个常见端口，仅 22/443/3000 TCP 开放且全部应用层无响应，无备用入口。

## 修复步骤（需在阿里云控制台操作）

**最快路径：控制台直接重启实例**（systemd 设计为自动拉起 hub，T1 验收标准）

1. 阿里云控制台 → ECS → 实例列表 → 找到 8.130.39.237 → 「重启」（必要时强制重启）。
2. 等待 1–2 分钟，从本机验证：`curl -s https://8.130.39.237/api/health`，应返回 `{"role":"hub", "runtime":"node-hub", ...}`。
3. 客户端无需任何改动：widget 每 3 秒自动重连（SSE 流 + 上报），恢复后自动回到正常。

**若重启后仍失败：Workbench/VNC 登录诊断**

1. 控制台 → 该实例 → 「远程连接」→ Workbench/VNC（SSH 已不可用）。
2. 以 root 执行 `docs/diagnostics/recover-hub.sh`（诊断 + 重启反代/hub + 本地/外部验证）。
3. 重点看脚本输出的第 1–2 步：`free -m`、`dmesg -T | tail -40`（OOM）、`systemctl --failed`，把输出发回定位假死原因。
4. 若反复假死：检查阿里云云监控/安全告警（云盾隔离）；确认 systemd `Restart=always`；检查证书续期钩子与磁盘占用。

## 遗留问题

- 服务器侧具体故障原因（进程假死原因）需要控制台登录后才能定位。
- 恢复后若「测试连接」返回 `unauthorized`/`needsSecret`，再核对服务器 `TOKEN_MONITOR_SECRET` 与 credentials.json 的 `clientSecret`（`2e4e6daf…`）是否一致。
- 多设备均连同一 hub，服务器恢复即全部恢复；若某台设备仍失败，检查其自身 `settings.json`（hubUrl/secret）。
