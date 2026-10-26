# Security policy

There is no released version yet. Only `main` receives fixes.

**Do not report vulnerabilities in public issues.** Use the repository's **Security** tab → **Report a vulnerability**, or write to **<security-contact>**.

Include what an attacker can do, how to reproduce it, and the commit you tested. We reply within 3 working days.

## Secrets in content

Before any text enters the event log or the LLM context, the service replaces secrets with `[REDACTED:<kind>]`. This covers tool outputs (errors too), run input, human messages and answers. It removes the exact secrets the service holds (the agent's connection secrets and URL passwords, the tenant's webhook secrets, the LLM API key) and values that match known token formats (private keys, AWS, GitHub, Slack, OpenAI, Anthropic, Stripe and Google keys, JWTs, agent-core keys, bearer and basic tokens, passwords in URLs, and `password=`, `api_key:` style assignments). The events record how many were removed per kind, never a value. Pattern matching is best effort: a secret in an unknown format passes. Model output and fixed texts the service writes are not screened.
