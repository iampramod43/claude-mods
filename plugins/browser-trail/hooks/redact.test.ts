import { describe, expect, test } from 'claude-code/testing'

import { mask, preview, redactText, redactUrl, summarizeInput } from './redact'

describe('redactUrl', () => {
  test('positive: secret query params and credentials are redacted', async () => {
    const out = redactUrl('https://bob:hunter2@app.test/cb?code=abc123&state=ok&access_token=xyz&page=2')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('xyz')
    expect(out).toContain('state=ok')
    expect(out).toContain('page=2')
  })

  test('negative: an ordinary URL is unchanged', async () => {
    expect(redactUrl('http://localhost:3000/login?next=%2Fhome')).toBe('http://localhost:3000/login?next=%2Fhome')
  })

  test('edge: token in the fragment and an unparseable URL', async () => {
    expect(redactUrl('https://app.test/#access_token=sekrit&x=1')).not.toContain('sekrit')
    expect(redactUrl('/login?password=pw1&user=a')).toBe('/login?password=redacted&user=a')
  })
})

describe('redactText', () => {
  test('positive: bearer tokens, JWTs, API keys and cookies', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk'
    const out = redactText(`Authorization: Bearer abcdefghijklmnop\ntoken ${jwt}\nkey sk-abcdefghijklmnopqrst\nCookie: sid=1; x=2`)
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).not.toContain(jwt)
    expect(out).not.toContain('sk-abcdefghijklmnopqrst')
    expect(out).not.toContain('sid=1')
  })

  test('negative: plain prose is unchanged', async () => {
    expect(redactText('Clicked the Sign in button')).toBe('Clicked the Sign in button')
  })

  test('edge: JSON secret fields and URLs inside text', async () => {
    const out = redactText('{"password": "pw", "user": "a"} went to https://x.test/?api_key=k1')
    expect(out).toContain('"user": "a"')
    expect(out).not.toContain('"pw"')
    expect(out).not.toContain('k1')
  })
})

describe('summarizeInput and preview', () => {
  test('positive: typed values are always masked, whatever the field', async () => {
    const s = summarizeInput({ tool: 'x', tool_use_id: 'id', element: 'Email textbox', text: 'me@example.com' })
    expect(s).toContain('text=‹14 chars›')
    expect(s).not.toContain('me@example.com')
    expect(s).not.toContain('tool_use_id')
  })

  test('negative: non-sensitive numbers and booleans stay', async () => {
    expect(summarizeInput({ width: 800, fullPage: true })).toBe('width=800 fullPage=true')
  })

  test('edge: huge values are bounded', async () => {
    const big = 'a'.repeat(100_000)
    expect(preview(big, 50).length).toBeLessThan(80)
    expect(summarizeInput({ selector: big }).length).toBeLessThan(400)
    expect(mask(undefined)).toBe('‹empty›')
  })
})

describe('form echoes (captured from Claude in Chrome, 2026-10-13)', () => {
  test('positive: a value echoed in a batch report is masked', async () => {
    const out = redactText('[form_input] Set email value to "tester@example.test" (previous: "")\n[computer:left_click] Clicked on element ref_8')
    expect(out).not.toContain('tester@example.test')
    expect(out).toContain('Set email value to ‹19 chars›')
    expect(out).toContain('Clicked on element ref_8')
  })
})
