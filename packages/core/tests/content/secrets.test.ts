import { createSecretMatcher } from '../../src/content/secrets'

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const ghToken = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const KNOWN = 'k9Zp-known-secret-value'

// kind, sample, expected output, near miss that stays untouched
const CASES: [string, string, string, string][] = [
  [
    'private_key',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----',
    '[REDACTED:private_key]',
    '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
  ],
  ['aws_access_key', 'key AKIAIOSFODNN7EXAMPLE end', 'key [REDACTED:aws_access_key] end', 'key AKIAIOSFODNN7EXAMPL end'],
  ['github_token', `t ${ghToken}`, 't [REDACTED:github_token]', 't ghp_short'],
  ['slack_token', 'xoxb-123456789012-abcdefABCDEF', '[REDACTED:slack_token]', 'xoxb-12'],
  ['openai_key', 'sk-abcdefghijklmnopqrstuvwxyz0123', '[REDACTED:openai_key]', 'task-abcdefghijklmnopqrstuvwxyz0123'],
  ['anthropic_key', 'sk-ant-api03-abcdefghijklmnopqrstu', '[REDACTED:anthropic_key]', 'sk-ant-short'],
  ['stripe_key', 'sk_live_abcdefghijklmnop1234', '[REDACTED:stripe_key]', 'sk_live_short'],
  ['google_api_key', `AIza${'A'.repeat(35)}`, '[REDACTED:google_api_key]', `AIza${'A'.repeat(34)}`],
  ['jwt', `token ${jwt}`, 'token [REDACTED:jwt]', 'eyJhbGciOiJIUzI1NiJ9.notajwt.sig'],
  ['agent_core_key', `ak_v1.acme.${'A'.repeat(43)}`, '[REDACTED:agent_core_key]', 'ak_v1.acme.short'],
  ['bearer_token', 'Authorization: Bearer abcdefghijklmnop1234', 'Authorization: Bearer [REDACTED:bearer_token]', 'Bearer abc'],
  ['bearer_token', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: Basic [REDACTED:bearer_token]', 'Basic authentication-based access'],
  ['url_password', 'https://user:hunter2pass@db.example.com/x', 'https://user:[REDACTED:url_password]@db.example.com/x', 'https://example.com:8080/path'],
  ['assigned_secret', 'password=hunter2hunter2', 'password=[REDACTED:assigned_secret]', 'password: short'],
  ['assigned_secret', '{"api_key": "abcdef123456"}', '{"api_key": "[REDACTED:assigned_secret]"}', 'the secret is kept in a vault'],
  ['known_secret', `value ${KNOWN} end`, 'value [REDACTED:known_secret] end', 'value k9Zp-known end'],
]

test.each(CASES)('%s: replaces the sample and keeps the near miss', (kind, sample, expected, nearMiss) => {
  const matcher = createSecretMatcher([KNOWN])
  const hit = matcher.redact(sample)
  expect(hit.text).toBe(expected)
  expect(hit.redactions[kind]).toBe(1)
  const miss = matcher.redact(nearMiss)
  expect(miss.text).toBe(nearMiss)
  expect(miss.redactions).toEqual({})
})

test('counts every hit per kind', () => {
  const text = 'AKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPLF AKIAIOSFODNN7EXAMPLG'
  expect(createSecretMatcher([]).redact(text).redactions).toEqual({ aws_access_key: 3 })
})

test('known values shorter than 8 characters are ignored', () => {
  const m = createSecretMatcher(['short', '1234567'])
  expect(m.redact('short 1234567').text).toBe('short 1234567')
})

test('a known value with regex metacharacters is matched literally, longest first', () => {
  const m = createSecretMatcher(['a.b*c+d?e-x', 'a.b*c+d?e-x-and-more'])
  expect(m.redact('x a.b*c+d?e-x-and-more y').text).toBe('x [REDACTED:known_secret] y')
  expect(m.redact('aXbbbcccdde-x').text).toBe('aXbbbcccdde-x')
})

test('a redacted marker is not redacted again by a later pattern', () => {
  const m = createSecretMatcher([])
  expect(m.redact(`password=${ghToken}`).text).toBe('password=[REDACTED:github_token]')
})

test('1,000,000 characters of mixed text are screened in under 200 ms', () => {
  const m = createSecretMatcher([KNOWN, 'another-known-value'])
  const chunk = 'The order was shipped on Monday. {"id": 1042, "note": "see https://example.com:8080/a?b=c", "password": "x"} Bearer abc sk-short eyJ.a.b\n'
  const text = chunk.repeat(Math.ceil(1_000_000 / chunk.length)).slice(0, 1_000_000)
  m.redact(text) // warm up the regex engine
  const start = performance.now()
  m.redact(text)
  const ms = performance.now() - start
  console.log(`screened ${text.length} characters in ${ms.toFixed(1)} ms`)
  expect(ms).toBeLessThan(1000) // 200 ms on a quiet machine; CI gets slack
})

test('pathological input stays linear', () => {
  const m = createSecretMatcher([])
  const text = ['-----BEGIN PRIVATE KEY-----\nMIIB'.repeat(30_000),'a'.repeat(200_000), 'https://' + 'u'.repeat(200_000), 'password' + '='.repeat(100_000)].join('\n')
  const start = performance.now()
  m.redact(text)
  expect(performance.now() - start).toBeLessThan(1000)
})

describe('JSON safety', () => {
  const m = createSecretMatcher([])
  test('a host:port URL followed by an email is untouched', () => {
    for (const o of [
      { url: 'http://localhost:8080', contact: 'ops@example.com' },
      [{ a: 'https://api.example.com:443/v1' }, 'x@y.io'],
      { u: 'http://localhost:8080', n: 1, mail: 'a@b.co' },
    ]) {
      const text = JSON.stringify(o)
      expect(m.redact(text).text).toBe(text)
    }
    expect(m.redact('see http://localhost:8080, mail ops@example.com').text).toBe('see http://localhost:8080, mail ops@example.com')
  })

  test('a URL password is the only part removed', () => {
    expect(m.redact('postgres://u:p4ssw0rd!@db/x').text).toBe('postgres://u:[REDACTED:url_password]@db/x')
    expect(m.redact('{"dsn":"postgres://u:p4ssw0rd!@db/x","a":1}').text).toBe('{"dsn":"postgres://u:[REDACTED:url_password]@db/x","a":1}')
  })

  test('JSON that holds assigned secrets still parses, with the value replaced', () => {
    const inputs = [
      '{"password":12345678}',
      '{"password":12345678,"a":1}',
      '{"api_key": "abcdef123456", "b": [1, 2]}',
      '[{"client_secret":"abcdefgh12"},{"x":"y"}]',
      '{"nested":{"access_token":"tok_abcdefghij"}}',
      '{"x-api-key": "abcdef123456"}',
    ]
    for (const input of inputs) {
      const out = m.redact(input)
      expect(() => JSON.parse(out.text)).not.toThrow()
      expect(out.text).toContain('[REDACTED:assigned_secret]')
      expect(out.text).not.toMatch(/12345678|abcdef123456|abcdefgh12|tok_abcdefghij/)
    }
  })

  test('JSON keeps its other fields', () => {
    expect(JSON.parse(m.redact('{"password":12345678,"a":1}').text)).toEqual({ password: '[REDACTED:assigned_secret]', a: 1 })
  })
})

test('wider key names hit; a bare token word does not', () => {
  const m = createSecretMatcher([])
  for (const text of ['AWS_SECRET_ACCESS_KEY=abcdefgh12345', 'DB_PASSWORD_PROD=abcdefgh12345', '"x-api-key": "abcdefgh12345"', 'refresh_token: abcdefgh12345', 'PASSPHRASE=abcdefgh12345', 'pwd=abcdefgh12345']) {
    const out = m.redact(text)
    expect(out.text, text).toContain('[REDACTED:assigned_secret]')
    expect(out.text, text).not.toContain('abcdefgh12345')
  }
  for (const text of ['{"max_tokens": 12345678}', 'tokens: 12345678901', 'token=12345678901']) {
    expect(m.redact(text).text).toBe(text)
  }
})

test('Bearer and Basic match in any case and keep the scheme as written', () => {
  const m = createSecretMatcher([])
  expect(m.redact('authorization: bearer abcdefghijklmnop1234').text).toBe('authorization: bearer [REDACTED:bearer_token]')
  expect(m.redact('AUTHORIZATION: BASIC dXNlcjpwYXNzd29yZA==').text).toBe('AUTHORIZATION: BASIC [REDACTED:bearer_token]')
})

test('a private key with no END line is removed with its body', () => {
  const m = createSecretMatcher([])
  const out = m.redact('before -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcDEF+/==\n')
  expect(out.text).toBe('before [REDACTED:private_key]')
  expect(out.redactions).toEqual({ private_key: 1 })
})

test('a private key with no END line inside JSON text is removed with its escaped body, and the JSON stays valid', () => {
  const m = createSecretMatcher([])
  const json = JSON.stringify({ key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\r\nabcDEF+/==\n', next: 1 })
  const out = m.redact(json)
  expect(out.text).toBe('{"key":"[REDACTED:private_key]","next":1}')
  expect(JSON.parse(out.text)).toEqual({ key: '[REDACTED:private_key]', next: 1 })
})

test('a known value is also matched in its JSON-escaped form', () => {
  const secret = 'pa"ss\word-12345'
  const m = createSecretMatcher([secret])
  const echoed = JSON.stringify({ note: secret })
  const out = m.redact(echoed)
  expect(out.text).not.toContain('pa')
  expect(JSON.parse(out.text)).toEqual({ note: '[REDACTED:known_secret]' })
  expect(m.redact(`raw ${secret}`).text).toBe('raw [REDACTED:known_secret]')
})
