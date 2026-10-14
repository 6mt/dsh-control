---
name: dsh-control
description: 连接并管理其他机器上的 dsh 环境（远程 dsh）。当用户说"把某台服务器加进来/连接 xx 上的 dsh/看看远程 dsh 里有什么会话"时使用：SSH 通道 + 远端自检 + 采纳接入信息，最终在「远程 dsh 环境」面板里可见。
disable-model-invocation: false
---

# dsh-control：远程 dsh 环境

本地插件 `dsh-control` 提供 `dshControl` 服务，界面在右侧边栏「远程 dsh 环境」面板。
一个**远程环境** = 一台机器上的 dsh，通过 SSH 隧道 + 访问 token 连接，不向公网暴露。

## 数据位置

- 静态声明：profile `cordis.patch.yml` 里 `dsh-control` 条目的 `config.environments`
- 面板添加：`$DSH_HOME/dsh-control/state.json`（`{"environments": {...}}`，600 权限，含 token）

## 一句话接入新环境（agent 流程）

用户给出 `user@host`（只给 IP 时依次试 root / ubuntu / lighthouse）后：

1. **探测远端**：`ssh -o BatchMode=yes user@host 'ps -ef | grep -E "dsh.*web|bin.js.*web" | grep -v grep'`
   - 已有实例：记下监听端口
   - 没有实例：按 `dsh-control/remote/setup.sh --setup` 部署（systemd 常驻
     `dsh --profile web --no-open --port 127.0.0.1:3080`，只绑 loopback，禁止 0.0.0.0）
2. **取 token**：`journalctl -u <服务名> --no-pager -o cat | grep "dsh web:" | tail -1`（找不到就重启一次服务）
3. **建隧道**：`ssh -f -N -L 127.0.0.1:<本地空闲端口>:127.0.0.1:<远端端口> user@host`
4. **写入环境**：向 `state.json` 的 `environments` 写入
   `{name, endpoint:"http://127.0.0.1:<本地端口>", token, remotePort, localPort}`（600 权限），面板刷新即见
5. **验证**：面板状态点变绿，或 `POST /api/dshControl/refresh`

## 界面上的等价操作

面板「添加环境」= 填服务器地址 → 复制隧道命令（本机终端运行）→ 复制发给远端 dsh 会话的话 →
把远端回复的 `dshctl-connect` 块粘回 → 完成接入。

## Remote 方法（SRC 模式，`POST /api/dshControl/<method>`）

| 方法 | 参数 | 说明 |
|---|---|---|
| `environments` | — | 列出环境与状态 |
| `refresh` | — | 重新探测所有环境 |
| `sessions` | `environment` | 某环境的会话列表 |
| `setupSteps` | `sshTarget`, `name?`, `remotePort?` | 生成接入步骤（本地端口自动分配，用户无需关心） |
| `adopt` | `input`, `name?`, `sshTarget?`, `localPort?`, `remotePort?` | 采纳接入信息并验证 |
| `removeEnvironment` | `name` | 移除面板添加的环境 |
| `openWebUrl` | `environment` | 带登录态的远端界面地址 |

## 安全红线

- token = 该远程机器的完全控制权：不外传、不入 git、不写日志
- 远端 dsh 只允许绑 127.0.0.1，跨机一律走 SSH 隧道
