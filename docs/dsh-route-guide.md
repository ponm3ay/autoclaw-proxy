# 最速 DSH 白嫖路由：autoclaw 反代白嫖 4w 积分额度

> 给 agent 看的极简流程：把 DSH（或任何 OpenAI 兼容客户端）接到本地 autoclaw-proxy，
> 直接消耗 AutoClaw 桌面客户端账号里的 GLM 积分额度（约 4w）。
> 原理、逆向细节、踩坑 → 见 [README](../README.md) 与 [replication-guide](replication-guide.md)。
> 仅供个人学习研究，账号风险自负。

## 0. 前置条件（缺一不可）

- [ ] Windows，且以**安装并登录过 AutoClaw 客户端的同一个用户**运行（token 自愈依赖 DPAPI）
- [ ] Node.js ≥ 16
- [ ] AutoClaw 客户端账号积分余额 > 0（GLM-5.3 / GLM-5.3-Flash 可用）

## 1. 启动反代（约 1 分钟）

```bash
git clone https://github.com/ponm3ay/autoclaw-proxy.git
cd autoclaw-proxy
cp credentials.example.json credentials.json   # 全部留空即可，token 会自动提取
npm start
```

- 监听 `http://127.0.0.1:8101`（改端口：环境变量 `AUTOCLAW_PROXY_PORT`）
- 凭据**留空即可**：首次 401 时自动从客户端凭据库热提取最新 token 并写回 `credentials.json`
- 自检：`curl http://127.0.0.1:8101/health` 应返回 ok

## 2. DSH 接线（provider 声明）

在 `D:\.dsh\profiles\desktop\cordis.patch.yml` 的 llm 插件 `providers:` 下加：

```yaml
      autoclaw:
        apiKeyEnv: AUTOCLAW_PROXY_KEY      # 反代本地端点无鉴权，任意非空值即可
        api: openai-completions
        baseURL: http://127.0.0.1:8101/v1
        models:
          - id: GLM-5.3
            name: GLM-5.3
            contextWindow: 1000000
            maxTokens: 131072
            reasoningEfforts:
              low: low
              high: high
              max: max
          - id: GLM-5.3-Flash
            name: GLM-5.3-Flash
            contextWindow: 1000000
            maxTokens: 131072
            reasoningEfforts:
              low: low
              high: high
              max: max
```

再设一个用户级环境变量（PowerShell，一次性）：

```powershell
[Environment]::SetEnvironmentVariable('AUTOCLAW_PROXY_KEY', 'local', 'User')
```

重启 DSH → 模型选择器里 provider `autoclaw` 下出现 GLM-5.3 / GLM-5.3-Flash，选中即走反代。

## 3. 验证

```bash
curl http://127.0.0.1:8101/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.3-Flash","messages":[{"role":"user","content":"ping"}]}'
```

返回正常补全即通。DSH 侧开个会话问一句，看模型回复 + 反代控制台有请求日志即完成。

## 4. 运行时注意（故障速查）

| 症状 | 原因 | 处置 |
|---|---|---|
| 401 反复出现 | 客户端凭据库里 token 过期 | 打开一次 AutoClaw 客户端让它刷新凭据，再重试 |
| 406 / 504 | 客户端升级，system/tools 指纹失效 | 重抓请求更新 `system-prompt.txt` / `tools.json`（replication-guide §6） |
| 504 / hang up | 短时高频触发上游限流 | 冷却几分钟自愈，调用方自然限速即可 |
| 连接拒绝 | proxy 没在跑 | `npm start`（当前手动启动，未注册自启） |

## 5. 纪律

- `credentials.json` / `proxy.log` / `debug-last-fail.json` 含敏感信息，已 gitignore，**永不提交**
- 流式（SSE）、`tools`、`reasoning_effort` 均支持且透传；超长会话由反代自动折叠防上游 500
- 一个人一个号自用，别商用、别转售额度
