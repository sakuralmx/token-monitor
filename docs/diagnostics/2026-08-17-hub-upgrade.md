# 记录：Node Hub 升级（2026-08-17）

> 状态：**完成并验证通过**。起因：客户端「Hub 部署状态」提示服务器 Node Hub 有更新（旧构建 core rev4 / node-hub rev1 vs 当前 rev6 / rev9）。

## 服务器部署实况（侦查确认）

- 主机：8.130.39.237，Ubuntu（5.15.0-174-generic），主机名 XMingL，root 登录
- 部署方式：`/opt/token-monitor` 为**直接拷贝的源码目录（非 git 仓库）**——升级不能走 git pull
- 服务：
  - `token-monitor-hub.service`（User=token-monitor，EnvironmentFile=/etc/token-monitor/hub.env）
    ExecStart=`/opt/token-monitor/node/bin/node src/hub/server.js`，监听 127.0.0.1:17321
  - `token-monitor-https.service`：自定义 `https-proxy.cjs`（非 nginx），监听 0.0.0.0:443
- hub 运行 Node：**v24.19.0**（独立安装于 /opt/token-monitor/node；PATH 的 node 是 v20.20.2，与此无关）
- 数据：`/var/lib/token-monitor/`（devices.json + devices-catalog.db）

## 升级过程

1. 本机 `tar czf hub-upgrade.tgz src/hub src/shared`（408 KB）
2. scp 上传 `/tmp/hub-upgrade.tgz`，`tar xzf -C /opt/token-monitor` 覆盖
3. 覆盖前备份旧 `src/hub`、`src/shared` 到 `/tmp/*-backup-*`
4. `chown -R root:root`，`systemctl restart token-monitor-hub`
5. 验证

## 验证结果

- 服务器本地 `/api/health`：`coreRevision: 6`、`runtimeRevision: 9`、**`catalogVersion: 2`**（会话目录上线，日志 "Session catalog: enabled (schema v2)"）
- 公网 `https://8.130.39.237/api/health`：同上，deviceCount 2，secretRequired true
- `/api/stats`：两设备记录完好（xm 刚上报），today 5.3 亿 tokens / $92.93，historyPreview 正常
- 客户端「Hub 部署状态」应显示为最新（core/适配器均与本地注册表一致）

## 说明

- 数据未动（只覆盖 src/hub 与 src/shared 代码）；旧代码备份在服务器 `/tmp/*-backup-*`，回滚 = 还原该目录并重启服务
- 设备无需任何改动；widget 自动重连
- 服务器另有无关服务：`/game/` 下 3 个 node 游戏服务器（未触碰）
