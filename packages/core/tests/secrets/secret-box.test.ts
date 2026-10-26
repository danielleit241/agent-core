import { randomBytes } from 'node:crypto'
import { SecretDecryptError, createSecretBox, parseMasterKey, secretAad } from '../../src/secrets/secret-box'

const box = () => createSecretBox(randomBytes(32))

describe('secret box', () => {
  it('round-trips', () => {
    const b = box()
    expect(b.open(b.seal('hunter2', 'a:connections:x'), 'a:connections:x')).toBe('hunter2')
  })

  it('sealed text does not contain the plain text', () => {
    const sealed = box().seal('hunter2-plain', 'aad')
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(sealed).not.toContain('hunter2-plain')
  })

  it('two seals of the same value differ', () => {
    const b = box()
    expect(b.seal('same', 'aad')).not.toBe(b.seal('same', 'aad'))
  })

  it('open with another AAD throws SecretDecryptError', () => {
    const b = box()
    const sealed = b.seal('v', 'aad-1')
    expect(() => b.open(sealed, 'aad-2')).toThrow(SecretDecryptError)
  })

  it('open with another master key throws SecretDecryptError', () => {
    const sealed = box().seal('v', 'aad')
    expect(() => box().open(sealed, 'aad')).toThrow(SecretDecryptError)
  })

  it('open of a tampered ciphertext throws SecretDecryptError', () => {
    const b = box()
    const [v, nonce, ct] = b.seal('value', 'aad').split(':')
    const bytes = Buffer.from(ct, 'base64url')
    bytes[0] ^= 1
    const tampered = `${v}:${nonce}:${bytes.toString('base64url')}`
    expect(() => b.open(tampered, 'aad')).toThrow(SecretDecryptError)
    expect(() => b.open(tampered, 'aad')).toThrow('secret could not be decrypted')
  })

  it('open of a value without v1: throws SecretDecryptError', () => {
    expect(() => box().open('plain-value', 'aad')).toThrow(SecretDecryptError)
    expect(() => box().open('v2:a:b', 'aad')).toThrow(SecretDecryptError)
  })

  it('parseMasterKey accepts 32 bytes', () => {
    const key = randomBytes(32)
    expect(parseMasterKey(key.toString('base64')).equals(key)).toBe(true)
  })

  it('parseMasterKey rejects 31 and 33 bytes and the message does not contain the input', () => {
    for (const n of [31, 33]) {
      const input = randomBytes(n).toString('base64')
      let message = ''
      try {
        parseMasterKey(input)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toBe('AGENT_CORE_MASTER_KEY must be 32 bytes encoded in base64')
      expect(message).not.toContain(input)
    }
  })

  it('secretAad joins tenant, table and id', () => {
    expect(secretAad('acme', 'webhooks', 'w1')).toBe('acme:webhooks:w1')
  })
})
