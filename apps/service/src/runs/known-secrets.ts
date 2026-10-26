import { SecretDecryptError } from '@agent-core/core'
import type { AgentDefinition } from '@agent-core/core'
import type { ConfigRepo } from '@agent-core/store-postgres'

/** The password part of `scheme://user:password@host`, as written and decoded; empty when the text has none. */
function urlPasswords(url: string): string[] {
  let password: string
  try {
    password = new URL(url).password
  } catch {
    return []
  }
  if (password === '') return []
  try {
    return [password, decodeURIComponent(password)]
  } catch {
    return [password] // not valid percent-encoding: the text can only hold it as written
  }
}

type LoadedConnection = { secret: string | null; url: string }

/**
 * The exact secrets the service holds for one agent: the secret and URL password of each of its connections, the tenant's
 * webhook secrets and the LLM API key. Read per run step and per request; a few rows, so no cache.
 * `loaded` are the agent's connections when the caller has read them already. A row that cannot be decrypted is skipped
 * (and logged by id): one damaged row must not stop every run.
 */
export async function knownSecretValues(
  config: ConfigRepo,
  agent: Pick<AgentDefinition, 'connections'>,
  llmApiKey: string | undefined,
  loaded?: LoadedConnection[],
): Promise<string[]> {
  const values: (string | null | undefined)[] = [llmApiKey]
  const connections: LoadedConnection[] = loaded ?? []
  if (loaded === undefined) {
    for (const id of agent.connections) {
      try {
        const connection = await config.getConnection(id)
        if (connection !== null) connections.push(connection)
      } catch (err) {
        if (!(err instanceof SecretDecryptError)) throw err
        console.error(`known secrets: the secret of connection ${id} could not be decrypted; skipped`)
      }
    }
  }
  for (const c of connections) values.push(c.secret, ...urlPasswords(c.url))
  const webhooks = await config.listWebhooks((id) => console.error(`known secrets: the secret of webhook ${id} could not be decrypted; skipped`))
  for (const w of webhooks) values.push(w.secret, ...urlPasswords(w.url))
  return [...new Set(values.filter((v): v is string => v !== null && v !== undefined && v !== ''))]
}
