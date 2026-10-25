# @agent-core/tools-webhook

Calls a team's webhook tool over HTTP. This is part of the tool gate.

## Call contract

For each tool call the service sends:

```
POST <connection url without trailing slash>/<encodeURIComponent(tool name)>
```

Body: `{"tool": "<name>", "input": { ...arguments }, "idempotencyKey": "<key>", "dryRun": false}`

The body is signed; the `Idempotency-Key` and `X-AgentCore-Dry-Run` headers are not. Read the key and the dry-run flag from the body after you verify the signature.

Headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-AgentCore-Signature` | `t=<unix seconds>,v1=<HMAC-SHA256 hex of "<t>.<body>">` with the connection secret. Same scheme as outbound webhooks. |
| `Idempotency-Key` | The key of the call. A retry of a read uses the same key. |
| `X-AgentCore-Dry-Run` | `true` or `false`. |
| `X-AgentCore-Principal` | Only when the run has a principal. An HS256 JWT signed with the connection secret. |

Principal JWT: header `{"alg":"HS256","typ":"JWT"}`; claims `iss` = `agent-core`, `aud` = the connection id, `sub` = principal id, `roles`, `iat`, `exp` = `iat` + 300 s. The tool must check the signature, `aud`, `iss` and `exp`.

The service does not follow redirects. It waits `timeoutMs` (default 15 s) and reads at most 1 MiB of response.

## Responses

| Response | Result |
| --- | --- |
| 2xx with `{"output": X}` | Success. Content is `X` if it is a string, else `JSON.stringify(X)`. |
| Other 2xx body | Error result: `Tool returned an invalid response.` |
| 4xx except 408 and 429 | Error result. Content is `error.message` from the body (max 2000 chars) or `Tool returned HTTP <status>.` |
| 3xx, 408, 429, 5xx, timeout, connection reset, body over 1 MiB | `WebhookToolError` `tool_call_failed`, `notSent: false`. |
| Connection refused, DNS failure | `WebhookToolError` `connection_unreachable`, `notSent: true`. |
| Connection lookup failed | `WebhookToolError` `connection_unavailable`, `notSent: true`. |
| Dry run of a write tool without `supports: ["dry-run"]` | `WebhookToolError` `dry_run_not_supported`, `notSent: true`. No request is sent. |

A `read` tool that fails with `notSent: false` is retried once with the same key. A `write` tool is never retried. Errors name the connection id, never the URL or the secret.
