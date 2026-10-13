// Redaction runs before anything reaches $.state or the screen.

export const SENSITIVE_KEY = /pass(word|wd|code)?|secret|token|auth|cookie|session|api[-_]?key|credential|otp|\bpin\b|ssn|cvv|card|signature|\bsig\b|\bcode\b|e-?mail|phone/i

// Input keys whose value is typed into the page: always masked, whatever the
// field, because a target's description cannot be trusted to say "password".
export const TYPED_KEY = /^(text|value|values|fields|elements|keys)$/

const REDACTED = '[redacted]'

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/\b(sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/((?:set-)?cookie|authorization|x-api-key)\s*[:=]\s*[^\n]+/gi, `$1: ${REDACTED}`],
]

export const mask = (value: unknown) => {
  if (value === undefined || value === null) return '‹empty›'
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return `‹${s.length} chars›`
}

export const redactUrl = (raw: string): string => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return redactQueryish(raw)
  }
  if (url.username || url.password) {
    url.username = url.username ? 'redacted' : ''
    url.password = ''
  }
  const keys = new Set<string>()
  url.searchParams.forEach((_v, k) => keys.add(k))
  for (const k of keys) if (SENSITIVE_KEY.test(k)) url.searchParams.set(k, 'redacted')
  if (url.hash && /=/.test(url.hash)) url.hash = redactQueryish(url.hash)
  return url.toString()
}

// key=value pairs in a string that is not a parseable URL (or a fragment).
const redactQueryish = (s: string) =>
  s.replace(/([?&#;\s]|^)([^=&#\s]+)=([^&#\s]*)/g, (m, pre: string, k: string) =>
    SENSITIVE_KEY.test(k) ? `${pre}${k}=redacted` : m,
  )

export const redactText = (s: string): string => {
  let out = s
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to)
  // Form tools echo what they set: `Set email value to "…"` (Claude in Chrome).
  out = out.replace(/(\bvalue to )"([^"\n]*)"/g, (_m, pre: string, v: string) => `${pre}${mask(v)}`)
  out = out.replace(/\bhttps?:\/\/[^\s"'<>)\]]+/g, u => redactUrl(u))
  out = out.replace(/"([^"]+)"\s*:\s*"([^"]*)"/g, (m, k: string) => (SENSITIVE_KEY.test(k) ? `"${k}": "${REDACTED}"` : m))
  return out
}

// One line, at most `max` characters, the overflow counted.
export const preview = (s: string, max = 200) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}… (+${flat.length - max} chars)`
}

const RESERVED = new Set(['tool', 'tool_use_id', 'consent'])

// A short, sanitized `key=value` list of a tool's arguments.
export const summarizeInput = (input: Record<string, unknown>, max = 300) => {
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (RESERVED.has(k) || v === undefined) continue
    let shown: string
    if (SENSITIVE_KEY.test(k) || TYPED_KEY.test(k)) shown = mask(v)
    else if (typeof v === 'string') shown = JSON.stringify(preview(redactText(v), 80))
    else if (typeof v === 'number' || typeof v === 'boolean') shown = String(v)
    else shown = preview(redactText(JSON.stringify(v) ?? ''), 80)
    parts.push(`${k}=${shown}`)
  }
  return preview(parts.join(' '), max)
}
