#!/bin/bash
# ============================================================================
# Token Monitor Hub 一键诊断与恢复脚本
# 适用：阿里云 ECS 8.130.39.237 应用层假死（22/443/3000 TCP 通但无响应）
# 用法：阿里云控制台 -> ECS 实例 -> 远程连接(Workbench/VNC) 登录后，以 root 粘贴执行：
#   bash /tmp/recover-hub.sh
# 或先复制到服务器：  bash <(cat <<'EOF' ... EOF)
# 也可直接在控制台 "发送远程命令" 粘贴本脚本内容。
# ============================================================================
set -x
echo "===== 1. 基础状态 ====="
date
uptime
free -m
df -h
top -bn1 | head -25

echo "===== 2. 内核日志（OOM / 磁盘 / 硬件错误）====="
dmesg -T 2>/dev/null | tail -40

echo "===== 3. 失败的系统服务 ====="
systemctl --failed --no-pager

echo "===== 4. 查找 hub 相关服务 ====="
systemctl list-units --type=service --all --no-pager | grep -iE 'hub|token|monitor|nginx|caddy'

echo "===== 5. 监听端口 ====="
ss -lntp | grep -E ':(22|443|3000|17321)\b' || true

echo "===== 6. 恢复：重启反代与 hub ====="
systemctl restart nginx 2>/dev/null || systemctl restart caddy 2>/dev/null || echo "no nginx/caddy unit found"
# hub 服务名按实际探测（见第 4 步输出）
for unit in token-monitor-hub token-monitor hub node-hub; do
  if systemctl list-unit-files | grep -q "^${unit}\.service"; then
    systemctl restart "${unit}.service" && echo "restarted ${unit}"
  fi
done
# 兜底：若 hub 不是 systemd 服务，尝试常见运行方式
pgrep -af 'server\.js|hub' || true

echo "===== 7. 本地验证 ====="
sleep 3
echo "--- hub(127.0.0.1:17321) ---"
curl -s -m 5 http://127.0.0.1:17321/api/health || echo "hub NOT responding locally"
echo ""
echo "--- 反代(127.0.0.1:443) ---"
curl -sk -m 5 https://127.0.0.1/api/health || echo "proxy NOT responding locally"
echo ""

echo "===== 8. 外部验证（从服务器自身出网）====="
curl -s -m 10 https://8.130.39.237/api/health || echo "external health check failed"
echo ""
echo "===== 完成。若第 7/8 步仍未通过，请把 1-6 步输出发回排查。====="
