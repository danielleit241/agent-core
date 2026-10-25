import { createHmac } from 'node:crypto'
import { expect, test } from 'vitest'
import { signPrincipalJwt, verifyPrincipalJwt } from './principal-jwt'

const NOW = 1761290000
const opts = { secret: 's3cret', audience: 'shop', nowSec: NOW }
const principal = { id: 'user-1', roles: ['agent', 'support'] }

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
function forge(header: unknown, claims: unknown, secret = 's3cret') {
  const head = `${b64(header)}.${b64(claims)}`
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`
}
const goodClaims = { iss: 'agent-core', aud: 'shop', sub: 'user-1', roles: [], iat: NOW, exp: NOW + 300 }

test('signed token verifies and carries sub, roles, aud, iss and exp = iat + 300', () => {
  const token = signPrincipalJwt(principal, opts)
  expect(verifyPrincipalJwt(token, opts)).toEqual({ sub: 'user-1', roles: ['agent', 'support'] })
  const [h, c] = token.split('.')
  expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' })
  expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({
    iss: 'agent-core',
    aud: 'shop',
    sub: 'user-1',
    roles: ['agent', 'support'],
    iat: NOW,
    exp: NOW + 300,
  })
})

test('ttlSec overrides the default lifetime', () => {
  const token = signPrincipalJwt(principal, { ...opts, ttlSec: 60 })
  expect(verifyPrincipalJwt(token, { ...opts, nowSec: NOW + 59 })).not.toBeNull()
  expect(verifyPrincipalJwt(token, { ...opts, nowSec: NOW + 60 })).toBeNull()
})

test('the forge helper makes a valid token, so the negative cases below are meaningful', () => {
  expect(verifyPrincipalJwt(forge({ alg: 'HS256', typ: 'JWT' }, goodClaims), opts)).toEqual({ sub: 'user-1', roles: [] })
})

test('rejects alg none and other algs', () => {
  expect(verifyPrincipalJwt(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(goodClaims)}.`, opts)).toBeNull()
  expect(verifyPrincipalJwt(forge({ alg: 'none', typ: 'JWT' }, goodClaims), opts)).toBeNull()
  expect(verifyPrincipalJwt(forge({ alg: 'HS512', typ: 'JWT' }, goodClaims), opts)).toBeNull()
})

test('rejects wrong audience, wrong issuer, wrong secret', () => {
  const token = signPrincipalJwt(principal, opts)
  expect(verifyPrincipalJwt(token, { ...opts, audience: 'other' })).toBeNull()
  expect(verifyPrincipalJwt(token, { ...opts, secret: 'nope' })).toBeNull()
  expect(verifyPrincipalJwt(forge({ alg: 'HS256', typ: 'JWT' }, { ...goodClaims, iss: 'evil' }), opts)).toBeNull()
})

test('rejects expired tokens (exp <= now) and tokens issued too far in the future', () => {
  const token = signPrincipalJwt(principal, opts)
  expect(verifyPrincipalJwt(token, { ...opts, nowSec: NOW + 299 })).not.toBeNull()
  expect(verifyPrincipalJwt(token, { ...opts, nowSec: NOW + 300 })).toBeNull()
  expect(verifyPrincipalJwt(token, { ...opts, nowSec: NOW - 60 })).not.toBeNull()
  expect(verifyPrincipalJwt(token, { ...opts, nowSec: NOW - 61 })).toBeNull()
})

test('rejects tampered payload and malformed tokens without throwing', () => {
  const [h, , s] = signPrincipalJwt(principal, opts).split('.')
  const tampered = `${h}.${b64({ ...goodClaims, sub: 'admin' })}.${s}`
  expect(verifyPrincipalJwt(tampered, opts)).toBeNull()
  for (const bad of ['', 'a.b', 'a.b.c.d', 'a.b.c', `${h}.!!!.${s}`]) expect(verifyPrincipalJwt(bad, opts)).toBeNull()
  expect(verifyPrincipalJwt(forge({ alg: 'HS256', typ: 'JWT' }, 'not-an-object'), opts)).toBeNull()
  expect(verifyPrincipalJwt(forge({ alg: 'HS256', typ: 'JWT' }, { ...goodClaims, roles: 'x' }), opts)).toBeNull()
})
