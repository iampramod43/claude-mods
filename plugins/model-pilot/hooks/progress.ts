// Progress: from subtask states and planner weights only.
//   completed            → its whole weight
//   running + reported   → weight × the agent's last report_progress percent (estimated)
//   running, no report   → 0, shown as "running", never a guessed fraction
//   failed / cancelled   → 0 (shown, never counted as done)
// Elapsed time is never used as progress.

import type { Subtask } from '../types'

export type Overall = {
  total: number
  doneWeight: number
  partialWeight: number
  failedWeight: number
  runningWeight: number
  // 0..1 of total weight; undefined when there are no subtasks.
  fraction?: number
  isEstimated: boolean
  counts: Record<Subtask['state'], number>
}

export const overall = (subs: Subtask[]): Overall => {
  const counts = { queued: 0, ready: 0, running: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0 }
  let total = 0
  let doneWeight = 0
  let partialWeight = 0
  let failedWeight = 0
  let runningWeight = 0
  for (const s of subs) {
    counts[s.state]++
    total += s.weight
    if (s.state === 'completed') doneWeight += s.weight
    else if (s.state === 'failed' || s.state === 'cancelled') failedWeight += s.weight
    else if (s.state === 'running') {
      runningWeight += s.weight
      if (s.progress) partialWeight += (s.weight * Math.max(0, Math.min(99, s.progress.pct))) / 100
    }
  }
  return {
    total,
    doneWeight,
    partialWeight,
    failedWeight,
    runningWeight,
    fraction: total > 0 ? (doneWeight + partialWeight) / total : undefined,
    isEstimated: partialWeight > 0,
    counts,
  }
}

// What a subtask's bar shows, 0..100, and whether it is a real figure.
export const barTarget = (s: Subtask): number | undefined => {
  if (s.state === 'completed') return 100
  if (s.state === 'running' || s.state === 'failed' || s.state === 'cancelled') return s.progress ? Math.min(99, s.progress.pct) : undefined
  return 0
}

export const ANIM_MS = 600

const ease = (x: number) => 1 - (1 - x) ** 3

// The bar's drawn value: easing from where it was to where it is, over
// ANIM_MS after a real change, when animation is on.
export const barValue = (s: Subtask, now: number, isAnimated: boolean) => {
  const target = barTarget(s)
  if (target === undefined) return undefined
  if (!isAnimated || !s.anim.at) return target
  const k = Math.min(1, Math.max(0, (now - s.anim.at) / ANIM_MS))
  return s.anim.from + (target - s.anim.from) * ease(k)
}

// Called on every real change of state or progress: the bar animates from
// what it showed a moment ago.
export const retarget = (s: Subtask, next: Partial<Subtask>, now: number): Subtask => {
  const shown = barValue(s, now, true) ?? 0
  const merged = { ...s, ...next }
  return barTarget(merged) === barTarget(s) ? merged : { ...merged, anim: { from: shown, at: now } }
}

export const isAnimating = (subs: Subtask[], now: number) => subs.some(s => s.anim.at && now - s.anim.at < ANIM_MS)
