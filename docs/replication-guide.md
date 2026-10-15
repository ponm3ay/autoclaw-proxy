# 逆向复刻指南：把桌面客户端的模型额度变成 OpenAI 兼容反代

> 本文是 autoclaw-proxy 的完整建造过程复盘，目标是：**下次遇到任何「桌面客户端里有模型额度，
> 想把它变成标准 API 端点」的同类型问题，可以照着本文的路径直接复刻。**
> 所有结论均为 2026-10-15 针对 AutoClaw（智谱 GLM 桌面客户端）v2.1.0 的实测。

## 0. 全景图

```
┌──────────┐  OpenAI 兼容协议   ┌──────────────┐  逆向出的私有协议   ┌──────────────────┐
│ 任意客户端 │ ───────────────→ │  本反代(proxy) │ ────────────────→ │ 官方网关(上游)     │
│ (DSH等)   │ ←─────────────── │  127.0.0.1    │ ←──────────────── │ zhipuai.cn        │
└──────────┘  SSE 流式透传      └──────────────┘  指纹伪装+SSE       └──────────────────┘
```

反代要解决的全部问题，本质是四个：

1. **看懂**上游协议（抓包逆向）
2. **扮得像**官方客户端（指纹校验绕过）
3. **活得久**（token 过期自愈）
4. **接得上**标准客户端（OpenAI 协议转换 + 边界处理）

## 1. 抓包逆向：怎么看到客户端到底发了什么

### 1.1 环境搭建（MITM）

客户端是 Electron 应用，HTTPS 直连，没有系统代理时无法直接抓。方案是 **hosts 劫持 + 自签 CA**：

1. 生成自签 CA，并用它签一张目标域名的服务端证书
   （目标域名从客户端报错/配置里能找到，本项目是 `autoglm-acceleration-api.zhipuai.cn`）
2. `hosts` 把目标域名指到本机 `127.0.0.1`
3. 本机 443 起一个 HTTPS MITM 服务器，持有自签证书
4. Electron 走 Node 网络栈时认系统证书库之外还会读 `NODE_EXTRA_CA_CERTS`
   环境变量——用包装脚本启动客户端并注入该变量指向自签 CA：
   ```
   set NODE_EXTRA_CA_CERTS=C:\mitm\ca.pem
   ```
5. 客户端发起请求 → MITM 落盘完整请求（headers + body）→ 转发真实上游拿响应

抓到一次**成功的真实请求**后，hosts 还原，MITM 退役——后续全部对着落盘样本复刻。

### 1.2 要抓什么

| 抓取物 | 用途 | 本项目的产出文件 |
|---|---|---|
| 完整请求头 | 逐头复刻（鉴权+指纹） | 写进 `proxy.cjs` 的 `identityHeaders()` |
| 请求 body 结构 | 协议字段、模型 id 映射 | `MODEL_MAP` |
| system prompt | 网关指纹的一部分 | `system-prompt.txt` |
| tools 定义 | 网关指纹的另一部分 | `tools.json` |
| 登录凭据的存储方式 | token 自愈 | `credentials.json` + vault 热提取 |

## 2. 协议要点（实测结论）

### 2.1 双层鉴权

```
第一层：公共身份头（客户端内置常量，人人相同）
  X-Auth-Appid: 100003
  X-Auth-Sign:  md5("100003&<unix秒时间戳>&<appKey>")
  X-Auth-TimeStamp / X-Product / X-Tm / X-Version / X-Lang / X-Channel

第二层：用户身份
  X-Authorization: <accessToken>   ← 凭据库存储的 token 自带 "Bearer " 前缀，原样透传
```

**坑①：双重 Bearer。** 凭据库里存的 accessToken 本身带 `Bearer ` 前缀。如果"规范地"再包一层
`Bearer ${token}`，会变成 `Bearer Bearer eyJ…` → 401。复刻时对存储值先做正则探测再决定是否追加。

### 2.2 指纹校验（本项目最大的坑）

网关对请求做**固定指纹校验**，两样东西必须和官方客户端逐字节一致：

- `messages[0]` 必须是官方 system prompt 原文（5771 字节 @v2.1.0）
- `tools` 必须是完整的官方 40 个工具定义

失败症状非常误导人：
- 改了 system → **406 + 空响应体**（没有错误信息）
- 缺 tools / 数量不对 → **504**（网关上游挂起，像超时）

**定位方法：二分试探。** 从「完整复刻真实请求能 200」的基线出发，一次只改一个变量
（换 system / 删 tools / 改字段…），记下每个变量对状态码的影响。本项目就是这样把
「406/504 的锅」从鉴权头一路排查到 system+tools 指纹上的。

**结构性 vs 内容性校验的判别：**
- 保持 40 个工具**数量与名称**，但改 description → 200 ⇒ 校验是结构性的，不查内容
- ⇒ 于是有了工具合并策略（见 §4.2）

### 2.3 token 生命周期（第二大坑）

- 登录下发的 token：344 字符 JWT，**exp 24 小时**，模型网关认这个
- `/userapi/v1/refresh` 签发的 token：348 字符格式，模型网关**不认**（401 Invalid token）
  —— refresh 端点只能续别的接口，模型网关只认登录原始 token

⇒ 结论：**refresh 路线走不通，token 自愈必须换源**。本项目从 AutoClaw 客户端
（Electron safeStorage）凭据库热提取最新登录 token（§3）。

### 2.4 体积与限流

- 上游网关对超大 body 报 **500 "parse response failed"**：真实客户端请求约 68KB，
  但接到 DSH 后长会话历史可达 1MB+。⇒ 反代内置体积保护：超限保留官方 system +
  调用方 system + 最近 N 条（从 16 条起指数回退砍半），中间折叠为一条占位消息
- 短时间高频请求触发 504 / socket hang up，冷却几分钟自愈；反代不内置节流，
  由调用方自然限速

## 3. Electron 凭据库解密（token 自愈的核心）

AutoClaw 客户端把登录 token 存在 Electron safeStorage 里，Windows 上的实现是
Chromium os_crypt **"v10" 格式**：

```
account-credentials.enc = "v10" + 12B nonce + AES-256-GCM密文 + 16B tag
```

解密链：

1. `%APPDATA%\AutoClaw-official\Local State` 里的 `os_crypt.encrypted_key`
   （base64，前 5 字节是 `"DPAPI"` 前缀，去掉）
2. 剩余 blob 用 **Windows DPAPI**（CurrentUser 域）解出 32B 主密钥
   —— 所以反代必须以**同一个 Windows 用户**运行
3. 主密钥 + nonce 对密文做 AES-256-GCM 解密 → JSON → `accessToken`

工程要点：DPAPI 调用走 PowerShell（`System.Security.Cryptography.ProtectedData`），
Node 侧 `execFile` 调起，密钥经临时文件中转。401 时自动触发整条链，实现无人值守自愈；
唯一前提是**客户端在本地登录过**（凭据库有新 token）。

## 4. 协议转换（OpenAI 兼容层）

### 4.1 system 消息的拼接顺序

网关要求官方 system 逐字节占据 `messages[0]`，而调用方（DSH）自己也有 system。
拼接顺序：**官方 system → 调用方 system → 其余消息**。官方 system 只占位过指纹，
模型实际遵循的是后面的调用方 system（实测推理行为正常）。

### 4.2 工具合并策略

```
官方 40 工具（保持数量过指纹）
  ├─ 与调用方工具同名的 → 剔除（避免同名二义）
  └─ 其余 → description 前置 "[UNAVAILABLE in this environment — do not call]"
调用方真实工具 → 原样追加
```

实测效果：模型推理链会明确引用 UNAVAILABLE 标记并自主选择调用方工具；
`tool_calls` 在 SSE 流里原样回传，反代作为透明管道不需解析——调用方框架自己会执行。

### 4.3 其它透传

- `stream: true` + `stream_options.include_usage`；非流式时改写返回体里的 model 显示名
- `reasoning_effort`：OpenAI 格式字段，网关原样接受（实测 low → reasoning_tokens=0）

## 5. 排查方法论（同类型问题通用）

1. **先拿到 200 基线**：逐字节复刻一次真实请求，确认能通。之后所有改动都从基线出发。
2. **一次只改一个变量**：任何"改了就 406"的结论必须建立在单变量对照上。
3. **失败快照**：上游非 200 时把完整请求体+响应落盘（本项目 `debug-last-fail.json`，
   含会话内容，已进 .gitignore）。比对快照与真实请求样本的差异，比看状态码有用得多。
4. **区分「校验」的层级**：鉴权层（401）→ 指纹层（406/504）→ 业务层（500 body 超限）。
   状态码就是分层探针。
5. **客户端资源直接复用**：system prompt、tools、token 都不用自己构造，
   从客户端安装目录/凭据库/抓包样本里拿原始件。
6. **日志要记裁剪和映射**：`model=GLM-5.3 -> zaicoding_glm-5.3`、
   `body size trim: 761 msgs -> 19 msgs` 这类行，事后排查时是唯一线索。

## 6. 适配新版客户端

客户端升级后指纹可能失效（system prompt / tools / 端点变化），症状是突然 406/504：

1. 重搭 §1.1 的 MITM 抓一次新请求
2. diff 新旧 `system-prompt.txt` / `tools.json`，替换
3. 检查 `X-Version` 等身份头是否需要跟随升级
4. 端点或鉴权算法变了 → 同法重逆向，改动集中在 `proxy.cjs` 头部常量区

## 7. 复刻到其它客户端的检查清单

- [ ] 找到模型网关域名与路径（客户端配置/报错/抓包）
- [ ] MITM 抓到一次成功请求，存档 headers + body
- [ ] 识别鉴权层级（公共身份头 / 用户 token / 签名算法）
- [ ] 试出指纹校验范围（system? tools? 其它字段?）——单变量二分
- [ ] 搞清 token 生命周期（有效期 / refresh 是否可用 / 存哪里）
- [ ] 若 token 存 Electron safeStorage：DPAPI + os_crypt v10 解密链
- [ ] 体积保护（真实客户端 body 多大？上限多少？超限怎么折叠？）
- [ ] OpenAI 兼容层：/v1/models、/v1/chat/completions、SSE 透传
- [ ] 失败快照 + 结构化日志
- [ ] 敏感文件（凭据/日志/快照）进 .gitignore
