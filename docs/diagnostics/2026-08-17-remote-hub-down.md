# 诊断记录：多设备同步连接失败（2026-08-17）

## 结论

**根因：阿里云 Hub 服务器（8.130.39.237）上的 HTTPS 服务已挂死（应用层无响应），所有设备均无法连接 → 多设备同步"始终连接失败"。这是服务器侧故障，不是 token-monitor 客户端代码或本机配置问题。**

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

## 修复步骤（需在阿里云控制台操作）

1. 登录阿里云控制台 → ECS 实例 → 使用 **Workbench / VNC** 远程连接（绕过 SSH）。
2. 初步排查：`uptime; free -m; df -h; top -bn1 | head -20; dmesg -T | tail -30`（看 OOM/负载）；`systemctl status <hub服务> nginx caddy 2>/dev/null`。
3. 恢复：重启反代与 hub 服务（如 `systemctl restart nginx && systemctl restart <hub服务>`），或直接 `reboot`。
4. 验证：外部 `curl -s https://8.130.39.237/api/health` 应返回 `{"role":"hub", ...}`，且 GUI「测试连接」通过。
5. 若反复假死：检查阿里云云监控/安全告警；确认 systemd `Restart=always`；检查证书续期钩子与磁盘占用。

## 遗留问题

- 服务器侧具体故障原因（进程假死原因）需要控制台登录后才能定位。
- 恢复后若「测试连接」返回 `unauthorized`/`needsSecret`，再核对服务器 `TOKEN_MONITOR_SECRET` 与 credentials.json 的 `clientSecret` 是否一致。
