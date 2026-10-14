/**
 * What one main-thread model request did to the prompt cache, as the API
 * reported it. `gapMs`: how long the cache had sat unused, from the previous
 * response's end to this request's start; null when no earlier response is known.
 */
export type StepCache = {
  index: number
  read: number
  created: number
  uncached: number
  gapMs: number | null
}

/**
 * `compactAt`: the token count at which auto-compaction runs, absent when it is
 * off (or not readable); the hints measure against it, else against `window`.
 */
export type ContextFill = {
  tokens?: number
  window: number
  percent?: number
  compactAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-cache-meter': {
      /** ms since the epoch of the last main-thread response that reached the API. */
      lastResponseAt: number | null
      /** The first request of the latest turn: how the turn started against the cache. */
      turnStart: StepCache | null
      /** The latest request that found the cache cold after a known pause; cleared when a turn starts warm. */
      coldStep: StepCache | null
      /** Whether the "cache died earlier than the lifetime assumes" toast was shown this session. */
      ttlWarned: boolean
      /** The context fill as `session.measure` last reported it, with the auto-compact mark. */
      context: ContextFill | null
      /** Highest threshold (0, 70 or 90) already announced for the current fill. */
      notified: number
      /** The compact button was pressed once and waits for the confirming press. */
      compactArmed: boolean
      /** A compaction started from the button is running. */
      isCompacting: boolean
      /** Counts the clock's ticks so the band redraws and the countdown moves. */
      tick: number
    }
  }
}
