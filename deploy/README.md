# 阿里云 ECS 部署：Node Hub + HTTPS IP 证书

> 本文档把 Token Monitor 的个人多设备中转 Hub 固化为可重复的部署流程：
> 一台阿里云 ECS，裸公网 IP，Let's Encrypt IP 证书，无域名、无 Cloudflare、无 Tailscale。
> 服务器秘密、证书私钥与真实部署凭据**不进入 Git**——仓库只记录模板、升级、回滚与备份步骤。

## 拓扑

```
公网客户端 (widget / agent)
        │  https://<ECS 公网 IP>/
        ▼
ECS 公网网卡 :443 ── nginx (TLS 终结 + 限流) ──► 127.0.0.1:17321 ── Node Hub
                                                     │
                                                     ▼
                                  /var/lib/token-monitor/ (devices.json + catalog.db)
```

- Hub 进程只监听 `127.0.0.1:17321`，公网永远碰不到裸 Hub。
- 443 由 nginx 终结 TLS；Let's Encrypt IP 证书由 Certbot 自动续期。
- 客户端仍然走现有共享密钥认证、SSE 更新与 HTTP 回退机制，无需任何额外客户端。

## 目录结构

| 文件 | 作用 |
|---|---|
| `systemd/token-monitor-hub.service` | Hub 的 systemd 单元（回环监听、开机自启、崩溃自恢复） |
| `nginx/token-monitor-hub.conf` | 443 → 回环 17321 的 HTTPS 反向代理模板 |
| `nginx/token-monitor-hub-bootstrap.conf` | 首次签发前的 HTTP-01 bootstrap 配置（无 TLS 块） |
| `certbot/cli.ini` | Certbot 配置（IP 证书、续期策略） |
| `certbot/renewal-hook.sh` | 证书续期 deploy hook（重载 nginx） |
| `scripts/healthcheck.sh` | 健康检查（systemd 监控 / 外部探活） |
| `scripts/backup.sh` | 数据备份（保留最近 N 份，可 rsync 异地） |
| `scripts/upgrade.sh` | 平滑升级 |
| `scripts/rollback.sh` | 回滚到上一版本 |
| `hub.env.example` | 服务器端环境变量模板（真实值放 `/etc/token-monitor/hub.env`，0600） |

## 一次性部署

以下命令假设：Ubuntu 24.04（其他发行版把包名换成对应工具）、ECS 公网 IP 记为 `1.2.3.4`、安全组已放行 80/443。

### 1. 安装运行时与依赖

```bash
# Node 22.13+（本仓库 engines 下限；部署建议 Node 24 LTS，启用 node:sqlite）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot

# 专用运行用户与数据目录
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin token-monitor
sudo mkdir -p /opt/token-monitor /var/lib/token-monitor /etc/token-monitor /var/log/token-monitor
sudo chown token-monitor:token-monitor /var/lib/token-monitor /var/log/token-monitor
```

### 2. 部署代码与配置

```bash
# 代码：Git 拉取或解压发布包，安装生产依赖
sudo git clone https://github.com/<your-fork>/token-monitor.git /opt/token-monitor
cd /opt/token-monitor
sudo npm ci --omit=dev          # hub 依赖链只有 dotenv + 内置模块，无需 dev 依赖
sudo chown -R token-monitor:token-monitor /opt/token-monitor

# 环境变量：复制模板并填入真实密钥（不进 Git）
sudo install -m 0600 deploy/hub.env.example /etc/token-monitor/hub.env
sudo -e /etc/token-monitor/hub.env    # 设置 TOKEN_MONITOR_SECRET（openssl rand -hex 32）
```

> **安全关键**：`TOKEN_MONITOR_HOST=127.0.0.1` 必须显式写在 hub.env 里。
> 有 secret 时 hub 的默认绑定是 `0.0.0.0`（`resolveBindHost` 只在无 secret 时强制回环），
> 漏掉这一行会让 Hub 直接暴露在公网 17321 上。

### 3. 安装 systemd 单元与 Certbot 配置

```bash
sudo install -m 0644 deploy/systemd/token-monitor-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now token-monitor-hub

# Certbot 配置 + 续期 deploy hook + ACME webroot（先装好，签发时直接可用）
sudo install -m 0644 deploy/certbot/cli.ini /etc/letsencrypt/cli.ini
sudo install -m 0755 deploy/certbot/renewal-hook.sh /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo mkdir -p /var/www/certbot
```

### 4. 签发 IP 证书（先 bootstrap，再启用 HTTPS）

Let's Encrypt 支持给公网 IP 签发证书（HTTP-01 校验，需要 80 端口可访问）。**必须先装 HTTP-only 的 bootstrap 配置**——此时还没有证书，直接启用含 `ssl_certificate` 的完整模板会让 `nginx -t` 失败。

```bash
# 第一步：bootstrap 配置（只有 HTTP-01 webroot，无 TLS 块）
sudo install -m 0644 deploy/nginx/token-monitor-hub-bootstrap.conf /etc/nginx/sites-available/token-monitor-hub
sudo ln -s /etc/nginx/sites-available/token-monitor-hub /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 第二步：签发 IP 证书（HTTP-01 走 bootstrap 的 /.well-known/acme-challenge/）
sudo certbot certonly \
  --config /etc/letsencrypt/cli.ini \
  --webroot -w /var/www/certbot \
  -d 1.2.3.4 \
  --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# 第三步：换成完整 HTTPS 模板并 reload
sudo install -m 0644 deploy/nginx/token-monitor-hub.conf /etc/nginx/sites-available/token-monitor-hub
sudo nginx -t && sudo systemctl reload nginx

# 确认签发成功
sudo certbot certificates
```

> IP 证书要求 Certbot ≥ 2.9 / 较新的 ACME 客户端。老版本报 `No IP addresses in request` 时先升级。
> 完整模板里的 `ssl_certificate*` 路径已指向 `/etc/letsencrypt/live/1.2.3.4/`，签好后无需再手改。

### 5. 验证

```bash
# 本机健康检查（hub 侧，不经过代理）
curl -fsS http://127.0.0.1:17321/api/health

# 经公网（客户端视角：证书 + 认证）
curl -fsS https://1.2.3.4/api/health
curl -fsS -H "Authorization: Bearer $SECRET" https://1.2.3.4/api/stats | head
```

## 日常运维

### 健康检查

- 手动：`deploy/scripts/healthcheck.sh`（本机直连回环 Hub）。
- 外部探活：定时 `curl -fsS https://1.2.3.4/api/health`（无需认证），失败告警。
- systemd 已配 `Restart=always` + `RestartSec=5`：崩溃自动拉起，服务器重启自动恢复。

### 升级

```bash
sudo deploy/scripts/upgrade.sh <tag-or-branch>   # 例：upgrade.sh v0.45.0
```

脚本做的事：拉取目标版本 → `npm ci --omit=dev` → 重启服务 → 健康检查。
升级前建议先跑一次 `scripts/backup.sh`。

### 回滚

```bash
sudo deploy/scripts/rollback.sh <previous-tag-or-branch>
```

只回滚代码，**不回滚数据**：`/var/lib/token-monitor/` 保持不动（schema 迁移见 `docs/API.md` 目录协议一节）。

### 备份

```bash
sudo deploy/scripts/backup.sh          # 打到 /var/lib/token-monitor/backups/，保留最近 14 份
# 异地：rsync -av /var/lib/token-monitor/backups/ user@elsewhere:/backups/token-monitor/
```

备份覆盖 `devices.json`（设备记录 + 订阅文档）与 `catalog.db`（会话目录 SQLite）。恢复 = 停服务 → 解包覆盖 → 起服务。

### 证书续期与到期监控

- Certbot 自带 systemd timer（`certbot.timer`）每天跑 `certbot renew`，deploy hook 自动重载 nginx。
- 建议每月手动 `certbot renew --dry-run` 验证续期链路。
- 到期监控：`certbot certificates` 输出 `EXPIRY DATE`，配合 crontab 检查剩余天数并告警：

```bash
# 每日检查，剩余 < 14 天打印告警（可接邮件/钉钉 webhook）
0 3 * * *  certbot certificates 2>/dev/null | grep -q 'VALID: 14 days' || echo "cert expiring soon"
```

## 回滚/恢复演练清单

1. 备份：`deploy/scripts/backup.sh`，并验证归档可解包。
2. 恢复：停服 → `tar xzf` 覆盖 `/var/lib/token-monitor/` → 起服 → `/api/health` + `/api/stats` 冒烟。
3. 全新主机重建：按「一次性部署」跑通 1–4 步，再从备份恢复数据目录。

## 风险与对策

- **IP 证书有效期 90 天**：续期链路用 timer 自动跑 + 每月 dry-run + 到期天数监控三重保障；备份不含私钥，只备份证书配置。
- **公网暴露面**：17321 不对外监听；nginx 限流（模板内 `limit_req`）；`client_max_body_size` 对齐 1 MiB ingest 上限；日志不打印 Authorization。
- **阿里云单点**：定期异地备份；文档化全新主机恢复流程（上面第 3 条）。
- **数据安全**：hub.env 0600 且不进 Git；密钥轮换 = 改两端 secret 后重启 Hub 与所有客户端。
