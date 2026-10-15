# autoclaw-proxy

把 **AutoClaw（澳龙）桌面客户端**的 GLM 模型额度，封装成本地 **OpenAI 兼容 API 端点**。

任意支持 OpenAI 协议的客户端（DSH、Chatbox、LobeChat、你自己写的脚本…）指向本反代，
即可直接使用客户端账号里的 GLM-5.3 / GLM-5.3-Flash，支持 SSE 流式与 tool_calls。

**零依赖**：纯 Node.js 标准库，`clone` 下来就能跑。

> 完整的逆向过程与复刻方法论见 [docs/replication-guide.md](docs/replication-guide.md)。

## 快速开始

### 前置条件

- Windows（token 自愈依赖 DPAPI，需与 AutoClaw 客户端同一用户）
- Node.js ≥ 16
- 本机已安装并**登录过** AutoClaw 客户端（凭据库里有有效 token）

### 安装与启动

```bash
git clone https://github.com/ponm3ay/autoclaw-proxy.git
cd autoclaw-proxy
cp credentials.example.json credentials.json   # 填入凭据（见下）
npm start
```

凭据三种获取方式（任选其一）：

1. **推荐：留空让反代自提取**——`accessToken` 留空，首次 401 时反代会自动从
   AutoClaw 客户端凭据库（Electron safeStorage）热提取最新 token 并写回
2. 从客户端抓包/凭据库手动提取一次，填入 `credentials.json`
3. 只要凭据库有 token，甚至可以直接删掉 `credentials.json` 里的值

### 端点

| 路由 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容对话补全（支持 `stream`、`tools`、`reasoning_effort`） |
| `GET /v1/models` | 模型列表 |
| `GET /health` | 健康检查 |

```
http://127.0.0.1:8101/v1/chat/completions      # 端口可用环境变量 AUTOCLAW_PROXY_PORT 改
```

### 模型

| 请求里的 model | 实际上游模型 |
|---|---|
| `GLM-5.3` | `zaicoding_glm-5.3` |
| `GLM-5.3-Flash` | `zai_glm-5.3-flash` |

### curl 示例

```bash
curl http://127.0.0.1:8101/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "GLM-5.3",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

## 工作原理

```
调用方 ──OpenAI协议──▶ autoclaw-proxy ──逆向出的私有协议──▶ 智谱网关
        ◀──SSE透传──                ◀──SSE──────────────
```

反代做了五件事：

1. **指纹伪装**：注入官方客户端的 system prompt（`system-prompt.txt`）与 40 个标准工具
   （`tools.json`）——网关对这两样做逐字节校验，缺/改即 406/504
2. **工具合并**：官方工具全部标记 `[UNAVAILABLE]`，调用方自带的真实工具原样追加，
   模型会自主避开官方工具、调用你的工具，`tool_calls` 原样回传执行
3. **体积保护**：超长会话历史（>700KB）自动折叠为「官方 system + 调用方 system + 最近 N 条」，
   防止上游 500
4. **token 自愈**：401 时自动经 DPAPI + AES-256-GCM 从客户端凭据库提取最新登录 token
5. **协议转换**：模型名映射、`reasoning_effort` 透传、SSE 流式透传

协议细节与踩坑实录（双重 Bearer、refresh token 网关不认、指纹校验定位方法…）
见 [docs/replication-guide.md](docs/replication-guide.md)。

## 项目结构

```
proxy.cjs                 # 反代本体（Node 标准库，无依赖）
system-prompt.txt         # 官方 system prompt（网关指纹，v2.1.0）
tools.json                # 官方 40 工具定义（网关指纹）
credentials.example.json  # 凭据模板（真实 credentials.json 已 gitignore）
docs/replication-guide.md # 逆向复刻指南（方法论）
```

## 维护

- **客户端升级后突然 406/504**：指纹变了，重抓一次请求更新
  `system-prompt.txt` / `tools.json`（步骤见复刻指南 §6）
- **token 过期且自愈失败**：打开一次 AutoClaw 客户端（它会刷新凭据库），再重试
- **限流**：短时高频会 504，冷却几分钟自愈

## 安全与合规

- `credentials.json`、`proxy.log`、`debug-last-fail.json` 含敏感信息，已列入 `.gitignore`，**切勿提交**
- 本项目通过逆向官方客户端协议实现，仅供个人学习与研究；请遵守 AutoClaw 服务条款，
  账号风险自负；请勿用于商用或转售额度
- `X-Auth` 签名常量为客户端内置公开值，非个人凭据

## License

[MIT](LICENSE)
