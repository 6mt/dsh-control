# 直连模式方案（LightVela 类：域名 + 令牌，无 SSH）

## 一、场景

用户已在远端机器（如腾讯 LightVela）上跑着 dsh，并通过反代/隧道把它包装成了一个
**带前置鉴权的域名链接**（如 `https://dsh.example.com`）。
本地插件不再需要 SSH——直接通过域名连接远端 dsh。

## 二、已验证的技术基础

| 事实 | 来源 |
|---|---|
| 远端 dsh 已配 `--trusted-host dsh.example.com` | 【实测】服务器 systemd 配置里有此参数 |
| dsh 信任栅栏允许通过受信域名的 API 请求 | 【有据】`dsh-client-connection` 源码 `isTrustedApiRequest` |
| 认证：launch token → `GET /?token=…` → 签名 cookie（30 天，绑定域名） | 【实测】SSH 模式下已验证同一套流程 |
| cookie 绑定 authority；直连时 authority=域名，域名稳定即 cookie 稳定 | 【有据】源码注释 + 早期调研 §6.2 |
| 没有 SSH → 令牌无法自动获取，需用户粘贴一次 | 【推断】无 SSH 通道即无日志读取路径 |

## 三、方案

### 用户填三项

```
名称：      cn-dsh2（可留空，自动取域名）
地址：      https://dsh.example.com
访问令牌：   <从远端 dsh 界面/启动日志复制的一次性令牌>
（可选）前置鉴权：如该域名前面还有 Basic Auth / Bearer / 自定义 header
```

### 插件做的事

```
┌────────────────────────────────────────────────────────┐
│  adopt-direct(endpoint, token, authHeaders?)            │
│                                                         │
│  1. 存入 state.json（endpoint + token + authHeaders）    │
│  2. GET {endpoint}/?token={token}                       │
│     → 302/303 → 拿到签名 cookie（绑定域名，30 天有效）     │
│  3. 以后所有 /api 调用带 cookie + authHeaders             │
│  4. 无 SSH、无隧道、无探测脚本                             │
│  5. 令牌过期（远端重启）→ 面板提示重新粘贴                   │
└────────────────────────────────────────────────────────┘
```

### 连接层改动

| 文件 | 改动 |
|---|---|
| `lib/connections.js` | `RemoteDsh` 构造器接受可选 `authHeaders`；`ensureCookie()` 和 `post()` 发请求时带上 |
| `lib/index.js` | 新增 `adoptDirect(endpoint, token, name, authHeaders?)` 方法：校验可达性（调 `session/list`）→ 存入 state → 返回结果 |
| `lib/client.js` | 「添加环境」面板的「直接地址」模式从灰色改为可用；表单字段：地址 + 令牌 +（折叠）前置鉴权类型与值 |
| `lib/onboarding.js` | 新增 `parseDirectBlock(input)`：支持用户直接粘贴带 token 的 URL（`https://xxx/?token=yyy`）自动拆解 |

### 与 SSH 模式的对比

| | SSH 模式（已实现） | 直连模式（本方案） |
|---|---|---|
| 前提 | 远端可 SSH 免密 | 远端有域名 + 已配 `--trusted-host` |
| 令牌获取 | **自动**（SSH 读日志） | **手动**（用户粘贴一次） |
| 隧道进程 | 有（本地随机端口） | **无** |
| 前置鉴权 | 无 | 可能需要（域名前面的网关/auth） |
| 安全 | SSH 加密隧道 | HTTPS + token + （可选）前置鉴权 |
| 远端改动 | 零 | 零（`--trusted-host` 是远端自己的配置） |

### 前置鉴权的支持范围

| 类型 | 配置方式 | 说明 |
|---|---|---|
| Basic Auth | `user:password` | 插件拼 `Authorization: Basic base64(user:password)` |
| Bearer Token | `Bearer <jwt>` | 插件原样转发 `Authorization` 头 |
| 自定义 header | `X-Api-Key: <value>` | 插件原样转发指定头 |

> 前置鉴权是**域名前面的网关**（nginx/Cloudflare/平台网关），不是 dsh 本身。
> dsh 本身的认证就是 launch token → cookie，已由方案覆盖。

## 四、不做的事（护栏）

- 不帮用户配域名/反代/`--trusted-host`——那是远端运维的事
- 不自动获取令牌（没有 SSH 通道做不到；用户从远端界面复制一次即可）
- 不做域名健康监控/SSL 证书管理

## 五、验收标准

1. 用户粘贴 `https://域名` + 令牌 → 一步接入，远端会话列表出现
2. 在直连环境的工作区里新建会话 → 自动绑定 → 对话 → 流式回复
3. 远端重启换令牌后 → 面板提示重新粘贴 → 重连即恢复
4. 有前置鉴权时 → 填入对应凭据 → 请求通过
5. 以上全部在真实 LightVela 域名上实测通过
