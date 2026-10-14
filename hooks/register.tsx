import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { ContextFill, StepCache } from '../types'
import {
  cacheRatio,
  cacheStatus,
  contextLevel,
  formatDuration,
  formatTokens,
  gaugePercent,
  isColdStep,
  meterBar,
  suspectsShortTtl,
} from './meter'

const TICK_MS = 30_000
const CONFIRM_MS = 8_000
const DEFAULT_TTL_MINUTES = 60

const lastResponseAt = atom({ plugin: 'context-cache-meter', key: 'lastResponseAt' } as const, null)
const turnStart = atom({ plugin: 'context-cache-meter', key: 'turnStart' } as const, null)
const coldStep = atom({ plugin: 'context-cache-meter', key: 'coldStep' } as const, null)
const ttlWarned = atom({ plugin: 'context-cache-meter', key: 'ttlWarned' } as const, false)
const context = atom({ plugin: 'context-cache-meter', key: 'context' } as const, null)
const notified = atom({ plugin: 'context-cache-meter', key: 'notified' } as const, 0)
const compactArmed = atom({ plugin: 'context-cache-meter', key: 'compactArmed' } as const, false)
const isCompacting = atom({ plugin: 'context-cache-meter', key: 'isCompacting' } as const, false)
const tick = atom({ plugin: 'context-cache-meter', key: 'tick' } as const, 0)

// The token count at which auto-compaction runs, or undefined when it is off or
// cannot be read (a fresh session has no breakdown yet): the hints fall back to
// the model's window then. The summary breakdown is estimated locally, free.
async function autoCompactMark($: EngineInterface): Promise<number | undefined> {
  try {
    const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    return breakdown?.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined
  } catch {
    return undefined
  }
}

// The fill moved: keep it for the band and announce a threshold once on the
// way up. A drop (compact, /clear) re-arms the thresholds below it.
async function takeFill($: EngineInterface, reading: ContextFill) {
  // Named fields only: a reading with a breakdown must not land in the state.
  const fill: ContextFill = {
    tokens: reading.tokens,
    window: reading.window,
    percent: reading.percent,
    compactAt: await autoCompactMark($),
  }
  await update($, context, () => fill)

  const gauge = gaugePercent(fill)
  const level = contextLevel(gauge)
  const announced = await read($, notified)

  if (level === announced) return

  await update($, notified, () => level)

  if (level > announced) {
    const percent = Math.round(gauge ?? 0)
    const reference = fill.compactAt === undefined ? '' : ' bis Auto-Compact'
    if (level === 90) {
      $.ui.toast(`Kontext bei ${percent} %${reference} – jetzt /compact ausführen`, {
        timeoutMs: 10_000,
      })
    } else {
      $.ui.toast(`Kontext bei ${percent} %${reference} – /compact bald einplanen`, {
        timeoutMs: 8_000,
      })
    }
  }
}

// One main-thread request answered: renew the cache clock and note how the
// cache served it. The first request of a turn is what shows a cold start; the
// turn's later requests read what it just wrote and would hide it.
async function recordStep(
  $: EngineInterface,
  step: { index: number; usage: TurnUsage | null; sentAt: number },
  ttlMs: number,
) {
  // No response arrived (interrupted, failed): the cache saw nothing.
  if (step.usage === null) return

  const previous = await read($, lastResponseAt)
  const finished = await $.clock.now()
  await update($, lastResponseAt, () => finished)

  const entry: StepCache = {
    index: step.index,
    read: step.usage.cache_read_input_tokens,
    created: step.usage.cache_creation_input_tokens,
    uncached: step.usage.input_tokens,
    gapMs: previous === null ? null : Math.max(0, step.sentAt - previous),
  }

  if (entry.index === 0) await update($, turnStart, () => entry)

  // Cold with no earlier response is just a session's first request: expected.
  if (entry.gapMs !== null && isColdStep(entry)) {
    await update($, coldStep, () => entry)
  } else if (entry.index === 0) {
    await update($, coldStep, () => null)
  }

  if (suspectsShortTtl(entry, ttlMs) && !(await read($, ttlWarned))) {
    await update($, ttlWarned, () => true)
    $.ui.toast(
      `Cache nach ${formatDuration(entry.gapMs ?? 0, 'floor')} schon kalt – evtl. gilt nur 5 Min (Einstellung cacheTtlMinutes)`,
      { timeoutMs: 12_000 },
    )
  }
}

// The compact button: a first press arms it, a second within a few seconds
// compacts. A compaction cannot be undone, so one stray click must not do it.
async function pressCompact($: EngineInterface) {
  if (await read($, isCompacting)) return

  if (!(await read($, compactArmed))) {
    await update($, compactArmed, () => true)
    $.clock.after(CONFIRM_MS, () => {
      void update($, compactArmed, () => false)
    })
    return
  }

  await update($, compactArmed, () => false)
  await update($, isCompacting, () => true)

  try {
    const result = await $.session.compact()
    if ('skip' in result) {
      $.ui.toast(`Kompaktieren übersprungen: ${result.skip}`, { timeoutMs: 8_000 })
    }
  } catch {
    $.ui.toast('Kompaktieren fehlgeschlagen', { timeoutMs: 8_000 })
  } finally {
    await update($, isCompacting, () => false)
  }
}

export const register: Register = (on, options) => {
  const ttlMinutes = Number(options.cacheTtlMinutes)
  const ttlMs = (ttlMinutes > 0 ? ttlMinutes : DEFAULT_TTL_MINUTES) * 60_000

  let timer: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      void update($, tick, n => n + 1)
    })

    try {
      const usage = await $.session.usage()
      await takeFill($, usage.context)
    } catch {
      // No reading yet (fresh session): the first measurement fills it in.
    }

    return next(e)
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    timer = null

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await takeFill($, e.context)
    }

    return next(e)
  })

  // Every request of the main thread, not the turn's sum: the sum would show a
  // turn that started cold and then read its own writes as a cache success.
  on('turn.step', async function* ($, e, next) {
    // A subagent's requests have a cache of their own.
    if (e.agentId !== undefined) return yield* next(e)

    const sentAt = await $.clock.now()
    const response = yield* next(e)

    try {
      await recordStep($, { index: e.index, usage: response.usage, sentAt }, ttlMs)
    } catch {
      // The band is a convenience; a failed note must not disturb the turn.
    }

    return response
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick)
    const last = await read($, lastResponseAt)
    const start = await read($, turnStart)
    const cold = await read($, coldStep)
    const fill = await read($, context)
    const armed = await read($, compactArmed)
    const compacting = await read($, isCompacting)

    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const cache = cacheStatus(now, last, ttlMs)
    const percent = gaugePercent(fill)
    const level = contextLevel(percent)
    const isWide = e.props.bodyColumns >= 115
    const compactAt = fill?.compactAt

    const contextColor = level === 90 ? 'error' : level === 70 ? 'warning' : 'success'
    const cacheColor =
      e.props.isWorking || cache.state === 'warm'
        ? 'success'
        : cache.state === 'expiring'
          ? 'warning'
          : 'suggestion'

    const rewrite =
      fill?.tokens === undefined ? '' : `, ~${formatTokens(fill.tokens)} neu`
    const cacheLabel = e.props.isWorking
      ? '● aktiv'
      : cache.state === 'cold'
        ? last === null
          ? `○ kalt${rewrite}`
          : `○ kalt (seit ${formatDuration(cache.idleMs - ttlMs, 'floor')})${rewrite}`
        : `● warm, noch ${formatDuration(cache.remainingMs, 'ceil')}${cache.state === 'expiring' ? ' ⚠' : ''}`

    const startNote =
      start === null
        ? null
        : `Zugstart ${cacheRatio(start)} % aus Cache${
            start.gapMs === null ? '' : ` (nach ${formatDuration(start.gapMs, 'floor')} Pause)`
          }`

    const reference = compactAt === undefined ? '' : ' bis Auto-Compact'
    const hint =
      level === 90
        ? `▲ Kontext bei ${Math.round(percent ?? 0)} %${reference} – jetzt /compact ausführen (oder /clear bei Themenwechsel).`
        : level === 70
          ? `▲ Kontext bei ${Math.round(percent ?? 0)} %${reference} – /compact bald einplanen, am besten an einem Aufgabenende.`
          : null

    const coldNote =
      cold === null
        ? null
        : `○ Kalter Cache im letzten Zug${cold.index > 0 ? ` (ab Schritt ${cold.index + 1})` : ''}: ~${formatTokens(cold.created)} Tokens neu geschrieben${
            cold.gapMs === null ? '' : `, nach ${formatDuration(cold.gapMs, 'floor')} Pause`
          }.`
    const isTtlSuspected = cold !== null && suspectsShortTtl(cold, ttlMs)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Kontext </Text>
          {percent === undefined ? (
            <Text dimColor>–</Text>
          ) : (
            <Text color={contextColor}>
              {meterBar(percent)} {Math.round(percent)} %{reference}
            </Text>
          )}
          {fill?.tokens !== undefined && (
            <Text dimColor>
              {' '}
              ({formatTokens(fill.tokens)}/{formatTokens(compactAt ?? fill.window)})
            </Text>
          )}
          <Text dimColor>{'  ·  '}</Text>
          <Text bold>Cache </Text>
          <Text color={cacheColor}>{cacheLabel}</Text>
          {isWide && startNote !== null && <Text dimColor>{`  ·  ${startNote}`}</Text>}
        </Text>
        {hint !== null && (
          <Text bold color={contextColor}>
            {hint}
          </Text>
        )}
        {level === 90 && compacting && <Text dimColor>kompaktiere …</Text>}
        {level === 90 && !compacting && !e.props.isWorking && (
          <Box>
            <Button
              key="compact"
              label={armed ? 'Sicher? Nochmal drücken zum Kompaktieren' : 'Jetzt kompaktieren'}
              onPress={() => pressCompact($)}
            />
          </Box>
        )}
        {coldNote !== null && (
          <Text>
            <Text color="suggestion">{coldNote}</Text>
            {isTtlSuspected && (
              <Text color="warning">
                {' '}
                Schon nach {formatDuration(cold?.gapMs ?? 0, 'floor')} kalt – evtl. gilt nur 5 Min
                Lebensdauer (Einstellung cacheTtlMinutes).
              </Text>
            )}
          </Text>
        )}
      </Box>
    )
  })
}
