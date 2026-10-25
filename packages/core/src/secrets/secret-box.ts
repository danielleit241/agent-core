import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const PREFIX = 'v1'
const KEY_ERROR = 'AGENT_CORE_MASTER_KEY must be 32 bytes encoded in base64'
const TAG_BYTES = 16

export class SecretDecryptError extends Error {
  constructor() {
    super('secret could not be decrypted')
    this.name = 'SecretDecryptError'
  }
}

export type SecretBox = {
  seal(plain: string, aad: string): string
  open(sealed: string, aad: string): string
}

/** Decode a base64 master key. The error message never contains the input. */
export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64')
  if (key.length !== 32) throw new Error(KEY_ERROR)
  return key
}

/** AES-256-GCM box. Output: `v1:<nonce b64url>:<ciphertext||tag b64url>`. The AAD binds a value to its row. */
export function createSecretBox(masterKey: Buffer): SecretBox {
  const key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'agent-core secrets v1', 32))
  return {
    seal(plain, aad) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(Buffer.from(aad, 'utf8'))
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
      return `${PREFIX}:${nonce.toString('base64url')}:${body.toString('base64url')}`
    },
    open(sealed, aad) {
      try {
        const parts = sealed.split(':')
        if (parts.length !== 3 || parts[0] !== PREFIX) throw new SecretDecryptError()
        const nonce = Buffer.from(parts[1], 'base64url')
        const body = Buffer.from(parts[2], 'base64url')
        if (nonce.length !== 12 || body.length < TAG_BYTES) throw new SecretDecryptError()
        const decipher = createDecipheriv('aes-256-gcm', key, nonce)
        decipher.setAAD(Buffer.from(aad, 'utf8'))
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
        return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8')
      } catch {
        throw new SecretDecryptError()
      }
    },
  }
}

export function secretAad(tenantId: string, table: 'connections' | 'webhooks', id: string): string {
  return `${tenantId}:${table}:${id}`
}
