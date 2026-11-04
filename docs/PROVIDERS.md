# 数据源说明

> 这些接口大多是各家**非公开**的内部接口，可能随时变化。出现问题时，先用 `log.txt` 确认返回内容，再改 `app/core/providers.js` 对应的 `fetchXxx`，并更新 `test/providers.test.js` 的假响应。
> 参考实现：[steipete/CodexBar](https://github.com/steipete/CodexBar)（macOS，支持的数据源很多）、[javargasm/pi-usage-bars](https://github.com/javargasm/pi-usage-bars)。

## Claude（`fetchClaude`）

凭据按顺序尝试：

1. 设置里手动填写：`sk-ant-sid…` 当作网页 sessionKey；其他字符串当作 OAuth 令牌。
2. Claude Code 登录：`~/.claude/.credentials.json` 的 `claudeAiOauth.accessToken`。macOS 上在钥匙串里，服务名为 `Claude Code-credentials`（仅在 `~/.claude` 存在时读取）。
3. 本程序「登录网页版」窗口留下的 Cookie（会话 `persist:aimon` 里的 `sessionKey`）。

接口：

- OAuth：`GET https://api.anthropic.com/api/oauth/usage`，请求头 `Authorization: Bearer …` 和 `anthropic-beta: oauth-2025-04-20`。
- 网页：先 `GET https://claude.ai/api/organizations`（选含有 `claude_max` / `claude_pro` / `chat` 能力的组织），再 `GET https://claude.ai/api/organizations/{uuid}/usage`。

两者返回同样的结构：`five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` / `seven_day_oauth_apps`，每项为 `{utilization, resets_at}`；`extra_usage` 为 `{is_enabled, used_credits, monthly_limit, utilization}`（金额以美分计）。

套餐判断：网页接口看 `capabilities`（`claude_max`→Max，`claude_pro`→Pro），`rate_limit_tier` 中的 `5x` / `20x` 作为后缀；OAuth 方式看凭据里的 `subscriptionType` / `rateLimitTier`。

7 天趋势：本地 `~/.claude/projects/**/*.jsonl` 中 assistant 消息的 `usage`（input + output + cache 读写），按 `message.id:requestId` 去重。

**不要**刷新 OAuth 令牌并写回（见 AGENTS.md）。

## Codex（`fetchCodex`）

- 凭据：`~/.codex/auth.json` 的 `tokens.access_token`、`tokens.account_id`、`tokens.id_token`（JWT 中有邮箱和 `chatgpt_plan_type`）。
- 本地优先：`~/.codex/sessions/**/*.jsonl` 中 `payload.type == "token_count"` 的事件带有 `rate_limits.primary/secondary`（`used_percent`、`window_minutes`、`resets_at` 或 `resets_in_seconds`）。如果本地快照在 2 分钟内且距上次联网不到 5 分钟，**不联网**直接使用。
- 在线：`GET https://chatgpt.com/backend-api/wham/usage`，请求头 `Authorization`、`ChatGPT-Account-Id`。返回 `rate_limit.primary_window/secondary_window`（`used_percent`、`limit_window_seconds`、`reset_at`、`reset_after_seconds`）、`plan_type`、`credits`、`additional_rate_limits`。
- 在线失败时回退到本地快照；快照已过重置点时视为 0%。
- 7 天趋势：同一会话文件中 `total_token_usage.total_tokens` 的增量。

## Cursor（`fetchCursor`）

凭据按顺序尝试：

1. 手动填写：`WorkosCursorSessionToken` 的值或完整 Cookie。
2. 本机 Cursor：从 `…/Cursor/User/globalStorage/state.vscdb`（以及 `-wal`）中**直接扫描字节**，找键 `cursorAuth/accessToken` 后面的 JWT。新版 Cursor 会加密为 `cursor-safe-storage:v1:<base64>`：
   - macOS：钥匙串 `Cursor Safe Storage` 中的密码，经 PBKDF2-SHA1（盐 `saltysalt`，1003 轮，16 字节）派生密钥，再用 AES-128-CBC（IV 为 16 个空格）解密。
   - Windows：`%APPDATA%\Cursor\Local State` 的 `os_crypt.encrypted_key`（去掉 `DPAPI` 前缀后用 PowerShell 调 DPAPI 解出），再用 AES-256-GCM（`v10` + 12 字节 nonce + 密文 + 16 字节 tag）解密。
3. 本程序「登录网页版」留下的 Cookie。

Cookie 格式：`WorkosCursorSessionToken={sub 最后一段}%3A%3A{jwt}`。

接口：`GET https://cursor.com/api/usage-summary`（`billingCycleStart/End`、`membershipType`、`individualUsage.plan.{used,limit,totalPercentUsed,autoPercentUsed,apiPercentUsed}`、`onDemand`）；`GET https://cursor.com/api/auth/me`（邮箱）。

## Gemini CLI（`fetchGemini`）

- 凭据：`~/.gemini/oauth_creds.json`（`access_token`、`refresh_token`、`expiry_date`）。令牌过期时用 `https://oauth2.googleapis.com/token` 刷新（只保存在内存里，不写回）。OAuth client 优先从已安装的 gemini-cli 的 `oauth2.js` 中读取，读不到用内置的公开值。
- `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` 获取项目和套餐层级；`POST …:retrieveUserQuota {project}` 返回 `buckets[{modelId, remainingFraction, resetTime}]`。
- primary 取 Pro 模型（每日），secondary 取 Flash 模型。

## GitHub Copilot（`fetchCopilot`）

- 凭据：手动填写的 Token，或 `~/.config/github-copilot/{apps,hosts}.json`（Windows 为 `%LOCALAPPDATA%\github-copilot\…`）里 `github.com*` 项的 `oauth_token`。
- `GET https://api.github.com/copilot_internal/user`，请求头 `Authorization: token …` 加 Editor-Version 系列头。返回 `quota_snapshots.{premium_interactions,chat,completions}.{entitlement,remaining,percent_remaining,unlimited}`、`quota_reset_date(_utc)`、`copilot_plan`。

## Kimi Code（`fetchKimi`）

- API Key（设置里填写，或环境变量 `KIMI_API_KEY`）。
- `GET https://api.kimi.com/coding/v1/usages`：`usage{limit,used,remaining,resetTime}` 当作每周；`limits[{window{duration,timeUnit},detail{…}}]` 中 ≤10 小时的窗口当作当前会话。也兼容 `usages.limit_5h/limit_7d.used_ratio` 格式。

## 智谱 GLM（`fetchGLM`）

- API Key。区域 `cn` 对应 `https://open.bigmodel.cn`，`global` 对应 `https://api.z.ai`。
- `GET /api/monitor/usage/quota/limit`，请求头 `Authorization: <key>`（不加 Bearer）。`data.limits[]`：`TOKENS_LIMIT` 中 unit=3 为 5 小时，unit=6 为每周；`TIME_LIMIT` 为 MCP 每月额度；`percentage`、`nextResetTime`、`currentValue`、`usage`。
