# dsh-control

[English](README.md) | 中文

**你的每台机器上都跑着 dsh？让本地这一个窗口，成为它们全部的前端。**

在本地 dsh 里直接和**其他机器上的 dsh** 对话：远端会话原生出现在你的侧栏，流式逐字返回；
远端用它自己的模型凭据、工具与沙盒干活。零远端改动、零依赖、一条命令安装。

![dsh-control 实际运行](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/hero.png)

*真实的两机场景。**左**：远端机器自己的 dsh——那条会话是插件为你创建的，并自动命名为 `控制端·<本地标题>`（①）。**右**：你本地的 dsh——同一个问题由远端执行（③ 模型路由就是环境名 `cn-dsh2`），回答落在插件为该环境自动创建的工作区里的本地会话中（②）。*

> 🎬 15 秒实拍（一键接入 → 流式回复）正在录制。

## 安装

```sh
dsh plugin --profile <你正在用的profile> add github:6mt/dsh-control
```

填你**已经在用的那个 profile**（一般是 `web` 或 `desktop`）。无构建步骤、无原生模块、无依赖
——插件是纯 JavaScript，装完即可用。

<details>
<summary>GitHub 慢或连不上？用 Release 里的 tarball 安装</summary>

下载 [dsh-control-0.1.0.tgz](https://github.com/6mt/dsh-control/releases/download/v0.1.0/dsh-control-0.1.0.tgz)，然后：

```sh
dsh plugin --profile <你正在用的profile> add ./dsh-control-0.1.0.tgz
```
</details>

安装后**完全退出并重开 dsh**（⌘Q），右侧边栏出现「远程 dsh 环境」面板。

> npm 包（`dsh-control`）已备好，日后可发布；当前安装路径就是上面这条 GitHub 命令。

## 版本与更新

- **装上的是哪一版**：`github:6mt/dsh-control` 取 `main` 的**最新提交**，并在你的 profile
  锁文件里**锁定到该 commit**——之后不会悄悄跟随后续提交
- **升级**：`dsh plugin --profile <你正在用的profile> update dsh-control`
  *（pnpm 会重新解析 git 引用并拉取新代码，已实测）*
- **固定版本**：`github:6mt/dsh-control#v0.1.0`（按 tag）或 `github:6mt/dsh-control#<commit>`
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)

## 它和 dsh-remote / dsh-remote-ssh 有什么不同？

![两种做法的对比](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/compare.svg)

| | 远程工作区类插件（dsh-remote 等） | **dsh-control** |
|---|---|---|
| 远端机器是什么 | **文件系统**（SFTP 工具集） | **一台已在运行的 dsh** |
| 会话在哪里 | 本地会话 + 远程目录 | **远端会话原生进你的侧栏** |
| 凭据/工具 | 本地配，SSH 配置再复制一份 | 远端自带，本地零复制 |
| 远端需要什么 | 只要 SSH | 需已装 dsh（≥0.2.0-rc.2）并跑着 web 实例 |
| 对远端的改动 | 部分会主动部署 dsh | **零改动**（只读探测 + 远端自身 API） |

两者**可以同装**（已实测共存）：远端没装 dsh → 用 dsh-remote；装了 → 用 dsh-control。

## 功能

![远程 dsh 环境面板](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/panel.png)

*「远程 dsh 环境」面板：填 `user@host` 即可连接；环境行会显示状态与是否已有工作区。*

- **一键接入**：填 `user@host`，自动探测远端 dsh、取访问令牌、建加密通道（约 5 秒）
- **自动工作区**：每个环境在本地生成同名工作区；在里面新建会话即**自动成为远端会话**
- **真流式**：远端回复逐字流入本地对话，不是等整轮蹦出
- **远端配对**：远端会话自动命名「控制端·本地标题」，两边对得上
- **可见且自愈**：侧栏会话行带远端标识；断线如实显示，一键重连修复

## 安全

**插件在你机器上做什么**：一份状态文件（`$DSH_HOME/dsh-control/state.json`，0600，
含远端访问令牌）+ 按需启动的 SSH 隧道进程。
**绝不做什么**：不在远端装东西/写文件、不管远端进程生命周期、不读你机器上的其他凭据、
令牌不进日志。免密未配置时给出一条修复命令，绝不保存密码。详见 [SECURITY.md](SECURITY.md)。

## 已知限制

- 远端需已装 dsh 并运行 web 实例（未装请用远程工作区类插件）
- 接入走 SSH（需免密或已配密钥；直连免 SSH 模式在路线图上）
- 会话行标识与流式观感以各版人工验收为准
- 取消远端运行中的会话：已实现，标注 experimental

## 开发

```sh
node --check lib/*.js
for t in test/*.test.mjs; do node "$t"; done   # 52 项：单元/契约/结构不变式
scripts/verify-boot-selfheal.sh                # 启动自愈（需本机 dsh 运行时）
```

## 许可证

MIT © 6mt
