export type SecretMatcher = {
  /** Replaces every secret with `[REDACTED:<kind>]`. `redactions` maps each kind to its count; it is empty when nothing matched. */
  redact(text: string): { text: string; redactions: Record<string, number> }
}

/** Known values shorter than this are ignored: they would hit ordinary text. */
const MIN_KNOWN_LENGTH = 8
const MARKER = String.raw`(?!\[REDACTED:)` // a value that an earlier rule replaced is not replaced again

type Pattern = {
  kind: string
  /** Group 1 and group 3 (when present) stay; group 2 is replaced. Without groups the whole match is replaced. */
  re: RegExp
  /** A bare (unquoted) value after a quoted key is a JSON value: the marker gets quotes so the JSON still parses. */
  jsonValue?: boolean
}

// A URL user or password holds no space, quote or JSON/markup delimiter, so a match never crosses a field.
const URL_PART = String.raw`\s"'` + '`' + String.raw`,;<>{}`
// A key name may carry a suffix (`DB_PASSWORD_PROD`). A prefix needs no rule: the text before the match stays as it is.
// The bare word `token` is not a key.
const SECRET_KEYS = String.raw`(?:password|passwd|passphrase|pwd|secret|client[_-]?secret|api[_-]?key|apikey|x-api-key|access[_-]?key|private[_-]?key|(?:access|auth|refresh|session|id|api|bearer)[_-]?token)[A-Za-z0-9_-]{0,30}`

// Linear time: every quantifier is bounded or applies to one character class, and nothing after it can force a retry.
// Order matters: a specific token is replaced before a generic rule (`sk-ant-` before `sk-`, a JWT before `Bearer`).
const PATTERNS: Pattern[] = [
  // The body stops at the next BEGIN, so many headers without an END cost no more than one.
  { kind: 'private_key', re: /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----(?:[^-]|-(?!----(?:BEGIN|END) )){0,20000}?-----END [A-Z ]{0,30}PRIVATE KEY-----/g },
  // A key cut off before its END line: the header and the base64 body that follows, with its line breaks raw or JSON-escaped.
  { kind: 'private_key', re: /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----(?:[A-Za-z0-9+/=\s]|\\[nrt]){0,20000}/g },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'github_token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'anthropic_key', re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_key', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe_key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'google_api_key', re: /\bAIza[A-Za-z0-9_-]{35,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g },
  { kind: 'agent_core_key', re: /\bak_v1\.[a-z0-9_-]{1,64}\.[A-Za-z0-9_-]{40,}/g },
  { kind: 'bearer_token', re: /(\bBearer )([A-Za-z0-9._~+/=-]{16,})/gi },
  { kind: 'bearer_token', re: /(\bBasic )([A-Za-z0-9+/]{16,}={0,2})/gi },
  {
    kind: 'url_password',
    re: new RegExp(String.raw`(\b[a-z][a-z0-9+.-]{1,20}://[^${URL_PART}:/@]{1,100}:)${MARKER}([^${URL_PART}/@]{1,200})(@)`, 'gi'),
  },
  {
    kind: 'assigned_secret',
    jsonValue: true,
    // The value stops at whitespace, a quote or a closing delimiter, so the JSON around it stays whole.
    re: new RegExp(String.raw`(${SECRET_KEYS}["']?\s{0,3}[:=]\s{0,3}["']?)${MARKER}([^\s"',;}\])]{8,})`, 'gi'),
  },
]

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const marker = (kind: string): string => `[REDACTED:${kind}]`

/**
 * Builds the matcher for one run. `knownValues` are exact secrets the service holds (a connection secret, a key);
 * they are replaced first, then the patterns. Values under 8 characters are ignored.
 */
export function createSecretMatcher(knownValues: string[]): SecretMatcher {
  const known = knownValues.filter((v) => v.length >= MIN_KNOWN_LENGTH)
  // A secret echoed inside JSON appears escaped, so that form matches too.
  const forms = [...new Set(known.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]))].sort((a, b) => b.length - a.length)
  const knownRe = forms.length === 0 ? null : new RegExp(forms.map(escapeRegExp).join('|'), 'g')
  return {
    redact(text) {
      const redactions: Record<string, number> = {}
      const bump = (kind: string): void => {
        redactions[kind] = (redactions[kind] ?? 0) + 1
      }
      let out = text
      if (knownRe !== null) {
        out = out.replace(knownRe, () => {
          bump('known_secret')
          return marker('known_secret')
        })
      }
      for (const { kind, re, jsonValue } of PATTERNS) {
        out = out.replace(re, (...args: unknown[]) => {
          bump(kind)
          // With capture groups the replacer gets (match, g1, g2[, g3], offset, ...); without, (match, offset, ...).
          const pre = args[1]
          if (typeof pre !== 'string') return marker(kind)
          const post = typeof args[3] === 'string' ? args[3] : ''
          const quote = jsonValue === true && /["']\s{0,3}[:=]\s{0,3}$/.test(pre) ? '"' : ''
          return `${pre}${quote}${marker(kind)}${quote}${post}`
        })
      }
      return { text: out, redactions }
    },
  }
}
