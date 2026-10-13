import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'

import {
  addHistory,
  addSample,
  addTokens,
  bar,
  bucketSpend,
  count,
  duration,
  empty,
  emptyTally,
  estimateUsd,
  heat,
  hoursToCap,
  newAlerts,
  parseBudget,
  ratePerHour,
  segments,
  sessionRate,
  shortModel,
  sparkline,
  until,
  usd,
} from './burn'

const PANE = 'burn-meter'
const burn = atom({ plugin: 'burn-meter', key: 'burn' } as const, empty(0))
const tick = atom({ plugin: 'burn-meter', key: 'tick' } as const, 0)

const MODEL_COLORS = ['magenta', 'cyan', 'yellow', 'green', 'blue']

const percentColor = (p: number) => (p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { startedAt } = await $.session.usage()
    await update($, burn, b => (b.startedAt === startedAt ? { ...empty(startedAt), ...b } : empty(startedAt)))
    await $.command.register({
      name: 'burn-meter',
      description: 'Show session cost and burn rate; `budget <usd>` or `budget off` sets a cap',
      argumentHint: '[budget <usd>|off]',
    })
    // Keeps elapsed time and reset countdowns moving between turns.
    $.clock.every(30_000, () => void update($, tick, n => n + 1))
    void $.ui.open({ id: PANE, title: 'Burn meter' })

    return next(e)
  })

  on('command.run', { command: 'burn-meter' }, async ($, e) => {
    const budget = parseBudget(e.args)
    if (budget === 'off') {
      await update($, burn, b => ({ ...b, budget: undefined, alerted: [] }))
      return { text: 'Budget cleared.' }
    }
    if (typeof budget === 'number' && budget > 0) {
      await update($, burn, b => ({ ...b, budget, alerted: newAlerts(b.usd, budget, []) }))
      return { text: `Budget set to ${usd(budget)}.` }
    }
    if (e.args.trim()) return { text: 'Usage: /burn-meter [budget <usd>|off]' }
    await $.ui.open({ id: PANE, title: 'Burn meter' })

    return { text: 'Burn meter opened.' }
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    let crossed: number[] = []
    const b = await update($, burn, b => {
      const spent = e.cost?.usd ?? b.usd
      crossed = newAlerts(spent, b.budget, b.alerted)
      return {
        ...b,
        usd: spent,
        samples: e.cost ? addSample(b.samples, { t: now, usd: spent }) : b.samples,
        history: e.cost ? addHistory(b.history, { t: now, usd: spent }) : b.history,
        contextPercent: e.context.percent ?? b.contextPercent,
        limits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
        alerted: [...b.alerted, ...crossed],
      }
    })
    const top = crossed.at(-1)
    if (top !== undefined && b.budget) {
      $.ui.toast(
        top >= 100
          ? `🔥 Budget reached: ${usd(b.usd)} of ${usd(b.budget)}`
          : `🔥 ${top}% of budget used: ${usd(b.usd)} of ${usd(b.budget)}`,
        { timeoutMs: 8000 },
      )
    }
    const rate = ratePerHour(b, now)
    const pct = b.budget ? ` · ${Math.round((b.usd / b.budget) * 100)}%` : ''
    $.ui.status(`${heat(rate).flames} ${usd(b.usd)} · ${usd(rate)}/h${pct}`)

    return next(e)
  })

  // Every turn, subagents included, so the token totals match what was billed.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const u = done.usage
    if (u) {
      const t = {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      }
      await update($, burn, b => {
        const prev = b.models[u.model] ?? emptyTally()
        return {
          ...b,
          turns: b.turns + (e.agentId ? 0 : 1),
          tokens: addTokens(b.tokens, t),
          models: { ...b.models, [u.model]: { ...addTokens(prev, t), turns: prev.turns + 1 } },
        }
      })
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, burn)
    await read($, tick)
    const now = await $.clock.now()
    const inner = Math.max(20, e.props.bodyColumns - 4)
    const barWidth = Math.max(8, Math.min(30, inner - 20))
    const rate = ratePerHour(b, now)
    const hot = heat(rate)

    const card = (key: string, title: string, color: string, ...children: RenderChildren[]) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Text bold color={color}>
          {title}
        </Text>
        {children}
      </Box>
    )

    const headline = card(
      'headline',
      `${hot.flames} Burn meter`,
      hot.color,
      <Text>
        <Text bold>{usd(b.usd)}</Text>
        <Text dimColor>
          {' '}
          over {duration(now - b.startedAt)} · {b.turns} turns
        </Text>
      </Text>,
      <Text>
        <Text bold color={hot.color}>
          {usd(rate)}/h
        </Text>
        <Text dimColor> now · {usd(sessionRate(b, now))}/h avg</Text>
      </Text>,
      <Text>
        {b.history.length < 2 ? (
          <Text dimColor>collecting spend history…</Text>
        ) : (
          <Text>
            <Text color={hot.color}>{sparkline(bucketSpend(b.history, now, Math.min(30, inner - 10)))}</Text>
            <Text dimColor> last 1h</Text>
          </Text>
        )}
      </Text>,
    )

    const budgetCard = (() => {
      if (!b.budget) return null
      const p = (b.usd / b.budget) * 100
      const eta = hoursToCap(b.usd, b.budget, rate)
      const note =
        p >= 100 ? 'over budget' : eta === undefined ? 'not burning' : `cap in ~${duration(eta * 3_600_000)} at this rate`

      return card(
        'budget',
        'Budget',
        percentColor(p),
        <Text>
          {usd(b.usd)} <Text dimColor>of</Text> {usd(b.budget)}
        </Text>,
        <Text>
          <Text color={percentColor(p)}>{bar(p, barWidth)}</Text> {Math.round(p)}%
        </Text>,
        <Text dimColor>{note}</Text>,
      )
    })()

    const tokens = card(
      'tokens',
      'Tokens',
      'cyan',
      <Text>
        <Text dimColor>in </Text>
        {count(b.tokens.input)}
        <Text dimColor> · out </Text>
        {count(b.tokens.output)}
      </Text>,
      <Text>
        <Text dimColor>cache </Text>
        {count(b.tokens.cacheRead)}
        <Text dimColor> read · </Text>
        {count(b.tokens.cacheWrite)}
        <Text dimColor> write</Text>
      </Text>,
    )

    const rows = Object.entries(b.models)
      .map(([model, m]) => ({ model, m, est: estimateUsd(model, m) }))
      .sort((x, y) => (y.est ?? 0) - (x.est ?? 0) || y.m.output - x.m.output)
    const hasPrices = rows.some(r => r.est !== undefined)
    const weights = rows.map(r => (hasPrices ? (r.est ?? 0) : r.m.output))
    const totalWeight = weights.reduce((a, c) => a + c, 0)
    const cells = segments(weights, Math.max(10, inner - 2))
    const nameWidth = Math.max(8, ...rows.map(r => shortModel(r.model).length))
    const colorOf = (i: number) => MODEL_COLORS[i % MODEL_COLORS.length]

    const models = card(
      'models',
      'By model',
      'magenta',
      rows.length === 0 ? (
        <Text dimColor>No turns yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Text>
            {rows.map((_, i) => (
              <Text color={colorOf(i)}>{'█'.repeat(cells[i] ?? 0)}</Text>
            ))}
          </Text>
          <Text dimColor>share of {hasPrices ? 'estimated spend' : 'output tokens'}</Text>
          <Text> </Text>
          {rows.map((r, i) => (
            <Box flexDirection="column">
              <Text>
                <Text color={colorOf(i)}>█ </Text>
                <Text bold>{shortModel(r.model).padEnd(nameWidth)}</Text>
                <Text dimColor> {String(r.m.turns).padStart(3)}t </Text>
                {r.est === undefined ? <Text dimColor> no price</Text> : <Text> ≈{usd(r.est).padStart(7)}</Text>}
                <Text dimColor>
                  {totalWeight > 0 ? ` ${Math.round(((weights[i] ?? 0) / totalWeight) * 100)}%`.padStart(5) : ''}
                </Text>
              </Text>
              <Text dimColor>
                {'  '}in {count(r.m.input)} · out {count(r.m.output)} · cache {count(r.m.cacheRead)}/
                {count(r.m.cacheWrite)}
              </Text>
            </Box>
          ))}
        </Box>
      ),
    )

    const limits = card(
      'limits',
      'Limits',
      'blue',
      b.contextPercent !== undefined && (
        <Text>
          <Text dimColor>{'context'.padEnd(10)} </Text>
          <Text color={percentColor(b.contextPercent)}>{bar(b.contextPercent, barWidth)}</Text>{' '}
          {`${b.contextPercent}%`.padStart(4)}
        </Text>
      ),
      b.limits.map(l => {
        const resets = until(l.resetsAt, now)
        return (
          <Text>
            <Text dimColor>{l.kind.padEnd(10)} </Text>
            <Text color={percentColor(l.percentUsed)}>{bar(l.percentUsed, barWidth)}</Text>{' '}
            {`${l.percentUsed}%`.padStart(4)}
            {resets && <Text dimColor> resets {resets}</Text>}
          </Text>
        )
      }),
      b.contextPercent === undefined && b.limits.length === 0 && <Text dimColor>No readings yet.</Text>,
    )

    return (
      <Box flexDirection="column">
        {headline}
        {budgetCard ?? <Text dimColor>  Tip: /burn-meter budget 10 sets a cap</Text>}
        {tokens}
        {models}
        {limits}
      </Box>
    )
  })
}
