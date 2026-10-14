import type { ContextFill, StepCache } from '../types'

export const WARN_PERCENT = 70
export const CRITICAL_PERCENT = 90

export type Level = 0 | 70 | 90

export const contextLevel = (percent: number | undefined): Level => {
  if (percent === undefined) return 0
  if (percent >= CRITICAL_PERCENT) return 90
  if (percent >= WARN_PERCENT) return 70
  return 0
}

/**
 * How full the context is for the hints: tokens over the auto-compact mark when
 * there is one (the point that matters), else the engine's percent of the window.
 */
export const gaugePercent = (fill: ContextFill | null): number | undefined => {
  if (fill === null) return undefined
  if (fill.compactAt !== undefined && fill.compactAt > 0 && fill.tokens !== undefined) {
    return (fill.tokens / fill.compactAt) * 100
  }
  return fill.percent
}

export const meterBar = (percent: number, cells = 10): string => {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * cells)
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

export const formatTokens = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')}M`
}

export const formatDuration = (ms: number, round: 'floor' | 'ceil'): string => {
  const minutes = Math[round](ms / 60_000)
  if (minutes < 1) return '<1 Min'
  if (minutes < 60) return `${minutes} Min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} Std` : `${hours} Std ${rest} Min`
}

export type CacheState = 'cold' | 'warm' | 'expiring'

export type CacheStatus = {
  state: CacheState
  remainingMs: number
  idleMs: number
}

/**
 * Warm while the last API response is younger than the cache's lifetime; every
 * response that reads the cache renews it, so the clock restarts per response.
 * `expiring`: the last fifth of the lifetime (at least one minute).
 */
export const cacheStatus = (
  now: number,
  lastResponseAt: number | null,
  ttlMs: number,
): CacheStatus => {
  if (lastResponseAt === null) return { state: 'cold', remainingMs: 0, idleMs: 0 }

  const idleMs = Math.max(0, now - lastResponseAt)
  const remainingMs = ttlMs - idleMs

  if (remainingMs <= 0) return { state: 'cold', remainingMs: 0, idleMs }

  const isEnding = remainingMs <= Math.max(60_000, ttlMs * 0.2)
  return { state: isEnding ? 'expiring' : 'warm', remainingMs, idleMs }
}

/** The API's default cache lifetime: a cache gone sooner than this is not the lifetime's doing. */
export const SHORT_TTL_MS = 5 * 60_000

/** Share of a request's input that the cache served, as a whole percentage. */
export const cacheRatio = (step: StepCache): number =>
  Math.round((step.read / Math.max(1, step.read + step.created + step.uncached)) * 100)

/** A request that wrote much and read little: the cache was not there. */
export const isColdStep = (step: StepCache): boolean =>
  step.created >= 1000 && step.read < 0.5 * (step.read + step.created + step.uncached)

/**
 * The cache was cold after a pause the assumed lifetime says it should have
 * survived, yet longer than the shortest lifetime there is: the lifetime may
 * really be shorter. Other causes (model switch, /compact, changed tools) look
 * the same, so this is a suspicion, never a measurement.
 */
export const suspectsShortTtl = (step: StepCache, ttlMs: number): boolean =>
  step.gapMs !== null && step.gapMs >= SHORT_TTL_MS && step.gapMs < ttlMs && isColdStep(step)
