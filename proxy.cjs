/**
 * AutoClaw 反代 —— 把 AutoClaw 账号的 GLM 额度暴露成 OpenAI 兼容端点。
 *
 * 协议逆向记录（2026-10-15 实测）：
 * - 网关 POST https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions
 *   （OpenAI chat.completions 协议，SSE 流式）
 * - 鉴权两层：
 *   ① 公共身份头（客户端内置常量）：X-Auth-Appid=100003、
 *      X-Auth-Sign=md5("100003&<ts>&38d2391985e2369a5fb8227d8e6cd5e5")、
 *      X-Auth-TimeStamp、X-Product=autoclaw、X-Tm=win、X-Version=2.1.0、
 *      X-Lang=zh-CN、X-Channel=official
 *   ② 模型层：X-Authorization: Bearer <accessToken>（refresh 走
 *      POST /userapi/v1/refresh，body {refresh_token, source_id:"autoclaw", device_id}）
 *   其它必需头：X-Client-Type=pc、x_trace_id=autoclaw-desktop、X-Trace-Id/X-Request-Id
 *   （同 UUID）、X-Request-Model=<模型id>、X-Session-Id、X-Query-Id、X-Agent-Id=main、
 *   Accept=application/json、User-Agent=node
 * - **网关校验 system prompt**：messages[0].content 必须与 AutoClaw 官方 system
 *   逐字节一致，否则 406（空响应）。故本反代强制在 messages 头部插入
 *   system-prompt.txt（2026-10-15 版，客户端 v2.1.0）；官方换版本需重新抓取。
 * - 模型映射：GLM-5.3 → zaicoding_glm-5.3；GLM-5.3-Flash → zai_glm-5.3-flash。
 *
 * 凭据：credentials.json（accessToken/refreshToken/deviceId），401 自动刷新并写回。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// ── 从 AutoClaw 客户端凭据库热提取登录 token（401 自愈用）────────────────
// Electron safeStorage on Windows = DPAPI? no: Chromium os_crypt "v10" 格式
// （前缀 "v10" + 12B nonce + AES-256-GCM 密文 + 16B tag），密钥在 Local State
// 的 os_crypt.encrypted_key（base64，前缀 "DPAPI"，DPAPI 解出 32B 主密钥）。
// DPAPI 解密需要同 Windows 用户 —— 本反代以同一用户运行即可。
const APPDATA = process.env.APPDATA;
const ACCOUNTS_DIR = path.join(APPDATA, 'AutoClaw-official', 'accounts');
function findVaultFile() {
  for (const d of fs.readdirSync(ACCOUNTS_DIR)) {
    const p = path.join(ACCOUNTS_DIR, d, 'account-credentials.enc');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function dpapiUnprotectKey() {
  return new Promise((resolve, reject) => {
    const localState = path.join(APPDATA, 'AutoClaw-official', 'Local State');
    const out = path.join(os.tmpdir(), 'autoclaw-oskey.b64');
    const ps = `$ls = Get-Content "${localState}" -Raw | ConvertFrom-Json; ` +
      `$blob = [Convert]::FromBase64String($ls.os_crypt.encrypted_key); ` +
      `Add-Type -AssemblyName System.Security; ` +
      `$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob[5..($blob.Length-1)], $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
      `[IO.File]::WriteAllText("${out}", [Convert]::ToBase64String($key))`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], (err) => {
      if (err) return reject(err);
      try { resolve(Buffer.from(fs.readFileSync(out, 'utf8').trim(), 'base64')); } catch (e) { reject(e); }
    });
  });
}
async function extractVaultToken() {
  const vault = findVaultFile();
  if (!vault) return null;
  const key = await dpapiUnprotectKey();
  const enc = fs.readFileSync(vault);
  if (enc.slice(0, 3).toString() !== 'v10') return null;
  const nonce = enc.slice(3, 15);
  const body = enc.slice(15);
  const tag = body.slice(body.length - 16);
  const ct = body.slice(0, body.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  const pt = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
  return pt.accessToken || null;
}

const APP_ID = '100003';
const APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5';
const ORIGIN = 'https://autoglm-acceleration-api.zhipuai.cn';
const CHAT_PATH = '/autoclaw-proxy/proxy/autoclaw/chat/completions';
const REFRESH_PATH = '/userapi/v1/refresh';
const REAL_IPS = ['47.104.143.157', '120.27.23.152'];
const REAL_HOST = 'autoglm-acceleration-api.zhipuai.cn';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf8');
// 网关对 (system, tools) 做固定指纹校验：缺 tools 或 tools 数量不对 → 504/406。
// 这 40 个是 AutoClaw 客户端 v2.1.0 的标准 agent 工具表（2026-10-15 抓包）。
const TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools.json'), 'utf8'));

// ── 工具集合并策略（2026-10-15 实测：网关为结构性校验，追加/改描述均 200）────
// 官方 40 个工具的 description 全部前置 [UNAVAILABLE]，让模型不再倾向调用它们；
// DSH 请求自带的真实工具原样追加（模型直接调 DSH 工具，tool_calls 原样回传 DSH 执行）。
// 与 DSH 工具同名的官方工具直接剔除（避免同名二义）。
function buildToolSet(dshTools) {
  const dshNames = new Set((Array.isArray(dshTools) ? dshTools : [])
    .map((t) => t.function && t.function.name).filter(Boolean));
  const marked = TOOLS
    .filter((t) => !(t.function && dshNames.has(t.function.name)))
    .map((t) => ({
      ...t,
      function: { ...t.function, description: `[UNAVAILABLE in this environment — do not call] ${t.function.description || ''}` },
    }));
  return [...marked, ...(Array.isArray(dshTools) ? dshTools : [])];
}
const CRED_FILE = path.join(__dirname, 'credentials.json');
const PORT = process.env.AUTOCLAW_PROXY_PORT ? Number(process.env.AUTOCLAW_PROXY_PORT) : 8101;

const MODEL_MAP = {
  'glm-5.3': 'zaicoding_glm-5.3',
  'glm-5.3-flash': 'zai_glm-5.3-flash',
  'zaicoding_glm-5.3': 'zaicoding_glm-5.3',
  'zai_glm-5.3-flash': 'zai_glm-5.3-flash',
};
const DISPLAY_NAME = { 'zaicoding_glm-5.3': 'GLM-5.3', 'zai_glm-5.3-flash': 'GLM-5.3-Flash' };

function loadCred() { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); }
function saveCred(c) { fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2)); }

function identityHeaders(cred, requestId) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'host': REAL_HOST,
    'connection': 'keep-alive',
    'accept': 'application/json',
    'x-auth-appid': APP_ID,
    'x-auth-sign': crypto.createHash('md5').update(`${APP_ID}&${ts}&${APP_KEY}`).digest('hex'),
    'x-auth-timestamp': ts,
    'x-channel': 'official',
    'x-client-type': 'pc',
    'x-lang': 'zh-CN',
    'x-product': 'autoclaw',
    'x-query-id': crypto.randomUUID(),
    'x-request-id': requestId,
    'x-session-id': crypto.randomUUID(),
    'x-tm': 'win',
    'x-trace-id': requestId,
    'x-version': '2.1.0',
    'x_trace_id': 'autoclaw-desktop',
    'x-agent-id': 'main',
    // ⚠ 凭据库里存的 accessToken 本身就带 "Bearer " 前缀（客户端这么存的），
    //   这里**原样**作为头值 —— 再包一层 Bearer 会变成 "Bearer Bearer eyJ…" 被 401。
    'x-authorization': /^Bearer\s+/i.test(cred.accessToken) ? cred.accessToken : `Bearer ${cred.accessToken}`,
    'user-agent': 'node',
    'accept-encoding': 'identity',
  };
}

function refreshCredential(cred) {
  // 保留备用：refresh 签发的 token 网关不认（见请求处理处注释），当前不用于 chat。
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const h = identityHeaders(cred, requestId);
    delete h['x-authorization'];
    h['authorization'] = /^Bearer\s+/i.test(cred.accessToken) ? cred.accessToken : `Bearer ${cred.accessToken}`;
    h['content-type'] = 'application/json';
    const body = JSON.stringify({ refresh_token: cred.refreshToken, source_id: 'autoclaw', device_id: cred.deviceId });
    const req = https.request({ host: REAL_IPS[0], servername: REAL_HOST, port: 443, method: 'POST', path: REFRESH_PATH, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.code === 0 && j.data && j.data.access_token) {
            const next = { ...cred, accessToken: j.data.access_token, refreshToken: j.data.refresh_token || cred.refreshToken, updatedAt: new Date().toISOString() };
            saveCred(next);
            resolve(next);
          } else reject(new Error(`refresh failed code=${j.code} msg=${j.msg}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function upstream(cred, bodyBuf, requestId, modelId, cb) {
  const h = identityHeaders(cred, requestId);
  h['x-request-model'] = modelId;
  h['content-type'] = 'application/json';
  h['content-length'] = bodyBuf.length;
  delete h['accept']; // let upstream see stream correctly via accept from client
  h['accept'] = 'application/json';
  const req = https.request({ host: REAL_IPS[0], servername: REAL_HOST, port: 443, method: 'POST', path: CHAT_PATH, headers: h }, cb);
  req.on('error', () => {});
  req.end(bodyBuf);
  return req;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: ['GLM-5.3', 'GLM-5.3-Flash'].map((id) => ({ id, object: 'model', owned_by: 'autoclaw-proxy' })) }));
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'autoclaw-proxy' }));
    return;
  }
  if (req.method !== 'POST' || !/\/(v1\/)?chat\/completions$/.test(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json' } }));
      return;
    }
    const requested = String(body.model || 'GLM-5.3');
    const modelId = MODEL_MAP[requested.trim().toLowerCase()] || MODEL_MAP[requested] || 'zaicoding_glm-5.3';
    const upstreamMessages = [];
    const userSystem = (body.messages || []).filter((m) => m.role === 'system');
    for (const m of body.messages || []) { if (m.role !== 'system') upstreamMessages.push(m); }
    // 官方 system 必须逐字节占据 messages[0]；用户 system 跟在后面
    const finalMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...userSystem.map((m) => ({ role: 'system', content: m.content })), ...upstreamMessages];
    // ── 体积保护（2026-10-15 实测：上游网关对超大 body 报 500 "parse response failed"）──
    // DSH 长会话历史可达 1MB+（真客户端仅 ~68KB）。超限时保留官方 system + DSH system
    // + 最近一段历史，中间折叠为一条占位；从 16 条起指数回退直到塞得下。
    let finalMsgs = finalMessages;
    const LIMIT = 700 * 1024;
    const msgsSize = (arr) => Buffer.byteLength(JSON.stringify(arr));
    if (msgsSize(finalMsgs) > LIMIT) {
      const head = finalMsgs.slice(0, 2);
      const tail = finalMsgs.slice(2);
      let keep = 16;
      let candidate = null;
      while (keep >= 2) {
        candidate = [...head,
          { role: 'user', content: `[system note: ${tail.length - keep} earlier messages omitted to fit the upstream size limit]` },
          ...tail.slice(-keep)];
        if (msgsSize(candidate) <= LIMIT) break;
        keep = Math.floor(keep / 2);
      }
      if (keep < 2) candidate = [...head, ...tail.slice(-1)];
      console.log(`[autoclaw-proxy] body size trim: ${finalMsgs.length} msgs (${msgsSize(finalMsgs)}B) -> ${candidate.length} msgs (${msgsSize(candidate)}B, kept last ${Math.min(keep, tail.length)})`);
      finalMsgs = candidate;
    }
    const outBody = {
      model: modelId,
      messages: finalMsgs,
      stream: body.stream !== false,
      store: false,
      max_completion_tokens: body.max_tokens || body.max_completion_tokens || 8192,
      tools: buildToolSet(body.tools),
    };
    if (outBody.stream) outBody.stream_options = { include_usage: true };
    // 推理等级透传：DSH（openai 格式）以 body.reasoning_effort 下发，网关原样接受
    if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.length > 0) {
      outBody.reasoning_effort = body.reasoning_effort;
    }
    const bodyBuf = Buffer.from(JSON.stringify(outBody));

    let cred = loadCred();
    console.log(`[autoclaw-proxy] chat req: model=${requested} -> ${modelId}, msgs=${finalMsgs.length}, stream=${outBody.stream}`);
    const doRequest = (c) => new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const upReq = upstream(c, bodyBuf, requestId, modelId, (upRes) => {
        console.log(`[autoclaw-proxy] upstream status: ${upRes.statusCode}`);
        if (upRes.statusCode === 401) { resolve({ retry: 'vault' }); upRes.resume(); return; }
        if (upRes.statusCode !== 200) {
          let eb = '';
          upRes.on('data', (c) => (eb += c));
          upRes.on('end', () => {
            // 调试快照：上游拒绝时落盘完整请求体与响应，便于复现定位（可能含会话内容，勿外传）
            try {
              fs.writeFileSync(path.join(__dirname, 'debug-last-fail.json'), JSON.stringify({
                time: new Date().toISOString(),
                upstreamStatus: upRes.statusCode,
                upstreamBody: eb.slice(0, 2000),
                modelId,
                msgRoles: finalMessages.map((m) => m.role),
                msgBytes: finalMessages.map((m) => Buffer.byteLength(JSON.stringify(m.content ?? ''))),
                bodyBytes: bodyBuf.length,
                requestBody: outBody,
              }, null, 2));
              console.log(`[autoclaw-proxy] fail snapshot written (upstream ${upRes.statusCode})`);
            } catch (e) {}
            res.writeHead(upRes.statusCode, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `upstream ${upRes.statusCode}: ${eb.slice(0, 300)}`, type: 'autoclaw_proxy_error' } }));
            resolve({});
          });
          return;
        }
        const isStream = outBody.stream;
        if (isStream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          upRes.on('data', (c) => { try { res.write(c); } catch (e) {} });
          upRes.on('end', () => { try { res.end(); } catch (e) {} resolve({}); });
        } else {
          let buf = '';
          upRes.on('data', (c) => (buf += c));
          upRes.on('end', () => {
            try {
              const j = JSON.parse(buf);
              if (j.model && DISPLAY_NAME[j.model]) j.model = DISPLAY_NAME[j.model];
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(j));
            } catch (e) { res.writeHead(502); res.end(buf.slice(0, 300)); }
            resolve({});
          });
        }
      });
      upReq.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream network error: ' + e.message } }));
        resolve({});
      });
    });

    let r = await doRequest(cred);
    if (r && r.retry === 'vault') {
      // ⚠ 2026-10-15 实测：refresh 端点签发的 access_token（348 字符格式）模型网关
      // **不认**（401 Invalid token）；网关只认登录时下发的原始 token（344 字符，
      // JWT exp 24 小时）。过期时从 AutoClaw 客户端凭据库热提取最新登录 token。
      const fresh = await extractVaultToken();
      if (fresh) {
        cred.accessToken = fresh;
        saveCred(cred);
        const r2 = await doRequest(cred);
        if (r2 && r2.retry) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'AutoClaw token invalid even after vault re-extract; re-login AutoClaw.', type: 'autoclaw_proxy_auth' } }));
        }
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'AutoClaw token expired; open AutoClaw once (re-login) so the vault has a fresh token, then retry.', type: 'autoclaw_proxy_auth' } }));
      }
    }
    } catch (e) {
      console.error('[autoclaw-proxy] handler error:', e && e.message);
      try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'proxy handler error: ' + (e && e.message) } })); } catch (e2) {}
    }
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`[autoclaw-proxy] listening on http://127.0.0.1:${PORT}`));
server.on('error', (e) => { console.error('[autoclaw-proxy]', e.message); process.exit(1); });
