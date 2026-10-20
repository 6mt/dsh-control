# dsh-control

[English](README.md) | 中文

**你的每台机器上都跑着 dsh？让本地这一个窗口，成为它们全部的前端。**

在本地 dsh 里直接和**其他机器上的 dsh** 对话：远端会话原生出现在你的侧栏，流式逐字返回；
远端用它自己的模型凭据、工具与沙盒干活。零远端改动、零依赖、一条命令安装。

![dsh-control 实际运行](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/hero.png)

*两个 dsh 窗口在回答同一个问题。左窗的会话被自动命名为 `控制端·<本地标题>`（①）——这种命名只出现在被插件驱动的那台机器上。右窗显示插件创建的环境工作区 `cn-dsh2`（②）和指向环境名的模型路由（③）。*

> 🎬 15 秒实拍（一键接入 → 流式回复）正在录制。

## 安装

```sh
dsh plugin --profile <你正在用的profile> add github:6mt/dsh-control
```

填你**已经在用的那个 profile**（一般是 `web` 或 `desktop`）。无构建步骤、无原生模块、无依赖
——插件是纯 JavaScript，装完即可用。

<details>
<summary>GitHub 慢或连不上？用 Release 里的 tarball 安装</summary>

下载 [dsh-control-0.2.1.tgz](https://github.com/6mt/dsh-control/releases/download/v0.2.1/dsh-control-0.2.1.tgz)，然后：

```sh
dsh plugin --profile <你正在用的profile> add ./dsh-control-0.2.1.tgz
```
</details>

安装后**完全退出并重开 dsh**（⌘Q，不是只关窗口），然后：

- 右侧边栏 →「远程 dsh 环境」→ 填 `user@host` → 连接
- 左侧栏 →「🌐 远程环境」→ 点环境标签，进入远端完整界面

> 升级到新版本后同样需要 ⌘Q 重开（宿主半代码在进程启动时加载）。

> npm 包（`dsh-control`）已备好，日后可发布；当前安装路径就是上面这条 GitHub 命令。

## 装失败了？

- **第一次 `add` 失败，重跑一次就好**：安装要从 GitHub 拉包并从 npm 解析依赖，网络差时 pnpm 会超时。
- **看到 `allowBuilds` / “prepare script” 提示**：那是 dsh 对**所有** git 安装失败的通用提示。本插件没有任何构建脚本（`package.json` 里只有 `test`），不需要授权；按上一条重跑即可。
- 仍然不行就用 Release 里的 tarball 安装（见上）。

## 版本与更新

- **装上的是哪一版**：`github:6mt/dsh-control` 取 `main` 的**最新提交**，并在你的 profile
  锁文件里**锁定到该 commit**——之后不会悄悄跟随后续提交
- **升级**：`dsh plugin --profile <你正在用的profile> update dsh-control`
  *（pnpm 会重新解析 git 引用并拉取新代码，已实测）*
- **固定版本**：`github:6mt/dsh-control#v0.2.1`（按 tag）或 `github:6mt/dsh-control#<commit>`
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)

## 和同名的 `dsh-control`（技能）有什么区别？

GitHub 上还有一个同名的 `jacjackai/dsh-control`，它是一个**技能**：让 AI Agent 去操作**本机** DSH 的工作区与会话。本仓库是**插件**，解决的是另一件事——**跨机器**：把你在其他服务器上装好的 dsh 接进本地这一个窗口，远端会话原生出现在侧栏，还能把整台远端的界面搬进来。两者可以同时装，互不冲突。

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

### 场景二：整个远端界面搬进来

左侧栏顶部的「🌐 远程环境」把远端的**完整 dsh 界面**（工作区、会话、对话、设置）
原样呈现在本地一个页面里，顶部用标签切换不同环境：

![远程环境页面](https://raw.githubusercontent.com/6mt/dsh-control/main/docs/remote-env.png)

*真实运行截图（这台是远端机器）。① 顶部环境标签：一个标签一台机器，点哪台进哪台；② 远端机器自己的工作区与会话列表；③ 远端真实在跑的会话——子代理、代码块、模型用量都在页面里；④ 需要独立窗口时「在新窗口打开」。*

- **100% 真实界面**：不是重画的简版——远端 dsh 自己渲染，版本更新自动跟随
- **同源代理**：页面由本地 web 服务转发，远端凭据在服务端注入；浏览器不接触令牌，
  远端外面的反向代理/鉴权层也不影响（流量走加密通道直连远端 loopback）
- **切换不重连**：去处理别的本地会话再回来，远端界面保持原样、不重新加载
- **资源走压缩**：只有文档请求关压缩（要注入），静态资源保留 gzip

## 安全

**插件在你机器上做什么**：一份状态文件（`$DSH_HOME/dsh-control/state.json`，0600，
含远端访问令牌）+ 按需启动的 SSH 隧道进程。
**绝不做什么**：不在远端装东西/写文件、不管远端进程生命周期、不读你机器上的其他凭据、
令牌不进日志。免密未配置时给出一条修复命令，绝不保存密码。详见 [SECURITY.md](SECURITY.md)。

## 已知限制

- 远端需已装 dsh（≥ 0.2.0-rc.2）并运行 web 实例（未装请用远程工作区类插件）
- 接入走 SSH（需免密或已配密钥；免 SSH 的「直接地址」模式已实现但暂未开放入口）
- 远端环境的页面是**远端的界面**：在那里的操作会真实作用于远端机器（与浏览器直访一致）
- 首次打开页面需要加载远端前端资源（数秒，取决于网络）；之后再切换不再重载
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
