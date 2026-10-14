# dsh-control

**你的每台机器上都跑着 dsh？让本地这一个窗口，成为它们全部的前端。**

**Every machine already runs dsh. Make this one window the front end for all of them.**

在本地 dsh 里直接和**其他机器上的 dsh** 对话：远端会话原生出现在你的侧栏，流式逐字返回；
远端用它自己的模型凭据、工具与沙盒干活。零远端改动、零依赖、一条命令安装。

Chat with the dsh instances on your other machines, natively from your local sidebar.
Remote sessions stream back token by token; the remote uses its own model credentials,
tools and sandbox. Zero changes on the remote. Zero dependencies. One-line install.

![两种做法的对比](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/compare.svg)

> 🎬 15 秒实拍 GIF（一键接入 → 侧栏出现远端会话 → 流式回复）即将补充。

## 安装 · Install

```sh
dsh plugin --profile <你的profile> add dsh-control
```

安装后**完全退出并重开 dsh**（⌘Q），右侧边栏出现「远程 dsh 环境」面板。

## 它和 dsh-remote / dsh-remote-ssh 有什么不同？

| | 远程工作区类插件（dsh-remote 等） | **dsh-control** |
|---|---|---|
| 远端机器是什么 | **文件系统**（SFTP 工具集） | **一台已在运行的 dsh** |
| 会话在哪里 | 本地会话 + 远程目录 | **远端会话原生进你的侧栏** |
| 模型凭据/工具 | 本地配，SSH 配置再复制一份 | 远端自带，本地零复制 |
| 远端需要什么 | 只要 SSH | 需已装 dsh（≥0.2.0-rc.2）并跑着 web 实例 |
| 对远端的改动 | 部分会主动部署 dsh | **零改动**（只读探测 + 远端自身 API） |

两者**可以同装**（已实测共存）：远端没装 dsh → 用 dsh-remote；装了 → 用 dsh-control。

## 功能 · What it does

- **一键接入**：填 `user@host`，自动探测远端 dsh、取访问令牌、建加密通道（约 5 秒）
- **自动工作区**：每个环境在本地生成同名工作区；在里面新建会话即**自动成为远端会话**
- **真流式**：远端回复逐字流入本地对话，不是等整轮蹦出
- **远端配对**：远端会话自动命名「控制端·本地标题」，两边对得上
- **会话标识**：侧栏会话行带远端标识；断线如实显示并一键重连（自愈）

## 安全 · Security

**插件在你机器上做什么**：一份状态文件（`$DSH_HOME/dsh-control/state.json`，0600，含远端访问令牌）；
按需启动一个 SSH 隧道进程。
**不做什么**：不在远端装东西/写文件/管生命周期；不读你机器上其他凭据；令牌不进日志。
SSH 免密未配置时给出一条修复命令，绝不保存密码。详见 [SECURITY.md](SECURITY.md)。

## 已知限制 · Known limitations

- 远端需已装 dsh 并运行 web 实例（未装请用远程工作区类插件）
- 接入走 SSH（需免密或已配密钥；直连模式在路线图上）
- 会话行标识与流式观感以各版人工验收为准
- 取消远端运行中的会话：已实现，标注 experimental

## 开发 · Development

```sh
node --check lib/*.js
for t in test/*.test.mjs; do node "$t"; done   # 52 项：单元/契约/结构不变式
scripts/verify-boot-selfheal.sh                # 启动自愈（需本机 dsh 运行时）
```

测试分层与自测准则见 [AGENTS.md](../AGENTS.md)（根仓库）与 `DESIGN.md`。

## License

MIT
