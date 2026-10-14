import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

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
} from '../hooks/meter'

const MIN = 60_000
const PLUGIN = 'context-cache-meter'

const fill = (percent: number | undefined) => ({
  context: {
    window: 1_000_000,
    ...(percent === undefined ? {} : { tokens: percent * 10_000, percent }),
  },
  rateLimits: [],
  changed: ['context' as const],
})

// What the API reports for a request the cache served / did not serve.
const WARM = {
  model: 'm',
  input_tokens: 10,
  output_tokens: 50,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 500,
}
const COLD = { ...WARM, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000 }

// How often the engine was asked to compact.
let compactions = 0

// The usage the engine's next `turn.step` answers with; a test sets it.
let reply: typeof WARM | null = WARM

// One request of the main thread (or of a subagent) through the whole chain.
const step = async ($: Engine, index = 0, agentId?: string) => {
  const stream = $.turn.step({
    turnId: 't1',
    index,
    model: 'm',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  })
  for await (const _chunk of stream) {
    // The chunks are not the test's concern.
  }
  return stream.result
}

// What the engine answers beneath the plugin; the toasts it was asked for are kept.
const engine = (on: On, compactAt?: number) => {
  reply = WARM
  compactions = 0
  const toasts: string[] = []
  // With `compactAt` the session reports auto-compaction at that many tokens;
  // without, a breakdown cannot be read, as in a session that has none yet.
  on('session.usage', (_$, e) => {
    if (compactAt === undefined || e.breakdown === undefined) {
      throw new Error('no breakdown')
    }
    return {
      value: {
        startedAt: 0,
        context: {
          window: 1_000_000,
          breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: compactAt },
        },
        rateLimits: [],
      },
    } as never
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    compactions += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [], toolResults: [] }] } as never
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: reply,
    }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

  return toasts
}

const BAND = {
  plugin: PLUGIN,
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
}

describe('helpers', () => {
  test('thresholds sit at 70 and 90 percent', () => {
    expect(contextLevel(undefined)).toBe(0)
    expect(contextLevel(69.9)).toBe(0)
    expect(contextLevel(70)).toBe(70)
    expect(contextLevel(89.9)).toBe(70)
    expect(contextLevel(90)).toBe(90)
  })

  test('bar and token formats', () => {
    expect(meterBar(0)).toBe('░░░░░░░░░░')
    expect(meterBar(62)).toBe('██████░░░░')
    expect(meterBar(100)).toBe('██████████')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(620_400)).toBe('620k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1,5M')
    expect(formatDuration(30_000, 'ceil')).toBe('1 Min')
    expect(formatDuration(30_000, 'floor')).toBe('<1 Min')
    expect(formatDuration(90 * MIN, 'floor')).toBe('1 Std 30 Min')
  })

  test('cache is warm, expiring, then cold; no response means cold', () => {
    const ttl = 60 * MIN
    expect(cacheStatus(0, null, ttl).state).toBe('cold')
    expect(cacheStatus(10 * MIN, 0, ttl).state).toBe('warm')
    expect(cacheStatus(50 * MIN, 0, ttl).state).toBe('expiring')
    expect(cacheStatus(61 * MIN, 0, ttl).state).toBe('cold')
    expect(cacheStatus(4 * MIN, 0, 5 * MIN).state).toBe('expiring')
  })
})

describe('thresholds', () => {
  test('each threshold toasts once on the way up and re-arms after a drop', async ($, on) => {
    mock.clock(on)
    const toasts = engine(on)

    await $.session.measure(fill(40))
    expect(toasts).toHaveLength(0)

    await $.session.measure(fill(71))
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('/compact bald')

    await $.session.measure(fill(80))
    expect(toasts).toHaveLength(1)

    await $.session.measure(fill(91))
    expect(toasts).toHaveLength(2)
    expect(toasts[1]).toContain('jetzt /compact')

    await $.session.measure(fill(undefined))
    await $.session.measure(fill(72))
    expect(toasts).toHaveLength(3)
  })
})

describe('band', () => {
  test('shows context fill, warm cache with countdown, then cold', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on)

    await $.session.measure(fill(62))
    await step($)

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /62 %/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /warm, noch 1 Std/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Zugstart 99 % aus Cache/ })).toBeDefined()

    await clock.advance(61 * MIN)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /kalt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~620k neu/ })).toBeDefined()
    await ui.unmount()
  })

  test('hint line appears at 70 and 90 percent', async ($, on) => {
    mock.clock(on)
    engine(on)

    await $.session.measure(fill(75))
    const warn = await $.ui.mount(BAND)
    expect(await warn.find({ type: 'Text', text: /bald einplanen/ })).toBeDefined()
    await warn.unmount()

    await $.session.measure(fill(93))
    const critical = await $.ui.mount(BAND)
    expect(await critical.find({ type: 'Text', text: /jetzt \/compact ausführen/ })).toBeDefined()
    await critical.unmount()
  })

  test('yields to a survey', async ($, on) => {
    mock.clock(on)
    engine(on)
    await $.session.measure(fill(80))

    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Text', text: /Kontext/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('cache lifetime option', () => {
  test('a 5 minute lifetime goes cold after 5 minutes and says since when', { options: { cacheTtlMinutes: 5 } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on)
    await step($)

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /warm, noch 5 Min/ })).toBeDefined()

    await clock.advance(4.5 * MIN)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /warm, noch 1 Min/ })).toBeDefined()

    await clock.advance(3 * MIN)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /kalt \(seit 2 Min\)/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('auto-compact mark', () => {
  const tokens = (n: number) => ({
    context: { window: 1_000_000, tokens: n, percent: n / 10_000 },
    rateLimits: [],
    changed: ['context' as const],
  })

  test('gauge measures against the mark, else the window', () => {
    expect(gaugePercent(null)).toBeUndefined()
    expect(gaugePercent({ window: 1_000_000, tokens: 100_000, percent: 10 })).toBe(10)
    expect(
      gaugePercent({ window: 1_000_000, tokens: 100_000, percent: 10, compactAt: 200_000 }),
    ).toBe(50)
    expect(gaugePercent({ window: 1_000_000, compactAt: 200_000 })).toBeUndefined()
  })

  test('hints fire at 70 and 90 percent of the mark, not of the window', async ($, on) => {
    mock.clock(on)
    const toasts = engine(on, 500_000)

    // 40 % of the window, but 80 % of the way to auto-compaction.
    await $.session.measure(tokens(400_000))
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('80 % bis Auto-Compact')
    expect(toasts[0]).toContain('/compact bald')

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /80 % bis Auto-Compact/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /400k\/500k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /bald einplanen/ })).toBeDefined()
    await ui.unmount()

    await $.session.measure(tokens(460_000))
    expect(toasts).toHaveLength(2)
    expect(toasts[1]).toContain('92 % bis Auto-Compact')
    expect(toasts[1]).toContain('jetzt /compact')
  })

  test('without a readable mark the window is the reference', async ($, on) => {
    mock.clock(on)
    const toasts = engine(on)

    await $.session.measure(tokens(400_000))
    expect(toasts).toHaveLength(0)

    await $.session.measure(tokens(710_000))
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).not.toContain('Auto-Compact')
  })
})

describe('cache per request', () => {
  const READ = { index: 0, read: 90_000, created: 500, uncached: 10, gapMs: 0 }
  const WROTE = { index: 0, read: 0, created: 80_000, uncached: 10, gapMs: 12 * MIN }

  test('step helpers', () => {
    expect(cacheRatio(READ)).toBe(99)
    expect(cacheRatio(WROTE)).toBe(0)
    expect(isColdStep(READ)).toBe(false)
    expect(isColdStep(WROTE)).toBe(true)
    expect(isColdStep({ ...WROTE, created: 400 })).toBe(false)
    // Suspicious only between the shortest lifetime and the assumed one.
    expect(suspectsShortTtl(WROTE, 60 * MIN)).toBe(true)
    expect(suspectsShortTtl({ ...WROTE, gapMs: 2 * MIN }, 60 * MIN)).toBe(false)
    expect(suspectsShortTtl({ ...WROTE, gapMs: 70 * MIN }, 60 * MIN)).toBe(false)
    expect(suspectsShortTtl({ ...WROTE, gapMs: null }, 60 * MIN)).toBe(false)
    expect(suspectsShortTtl(READ, 60 * MIN)).toBe(false)
  })

  test('cold after a pause the lifetime should survive: noted, toasted once', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const toasts = engine(on)
    await step($)

    await clock.advance(12 * MIN)
    reply = COLD
    await step($)

    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('nach 12 Min schon kalt')

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /Kalter Cache im letzten Zug/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /80k Tokens neu geschrieben, nach 12 Min Pause/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Schon nach 12 Min kalt/ })).toBeDefined()

    await clock.advance(12 * MIN)
    await step($)
    expect(toasts).toHaveLength(1)
    await ui.unmount()
  })

  test('cold after a short pause is noted without suspecting the lifetime', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const toasts = engine(on)
    await step($)

    await clock.advance(2 * MIN)
    reply = COLD
    await step($)

    expect(toasts).toHaveLength(0)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /Kalter Cache im letzten Zug/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Schon nach/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a session\'s first request is cold by nature and not noted', async ($, on) => {
    mock.clock(on)
    const toasts = engine(on)
    reply = COLD
    await step($)

    expect(toasts).toHaveLength(0)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /Kalter Cache im letzten Zug/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Zugstart 0 % aus Cache/ })).toBeDefined()
    await ui.unmount()
  })

  test('a turn that starts cold keeps saying so after its later requests read the cache', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on)
    await step($)

    await clock.advance(12 * MIN)
    reply = COLD
    await step($, 0)
    reply = WARM
    await step($, 1)

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /Zugstart 0 % aus Cache \(nach 12 Min Pause\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Kalter Cache im letzten Zug/ })).toBeDefined()

    // The next turn starts warm: the note goes.
    await step($, 0)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /Kalter Cache im letzten Zug/ })).toBeUndefined()
    await ui.unmount()
  })

  test('subagent requests and failed requests do not touch the cache clock', async ($, on) => {
    mock.clock(on)
    engine(on)

    await step($, 0, 'agent-1')
    reply = null
    await step($)

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /○ kalt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Zugstart/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the last fifth of the lifetime carries a warning sign', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on)
    await step($)

    await clock.advance(50 * MIN)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /warm, noch 10 Min ⚠/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('compact button', () => {
  test('appears at 90 percent only, and not while a turn runs', async ($, on) => {
    mock.clock(on)
    engine(on)

    await $.session.measure(fill(75))
    const warn = await $.ui.mount(BAND)
    expect(await warn.find({ key: 'compact' })).toBeUndefined()
    await warn.unmount()

    await $.session.measure(fill(93))
    const critical = await $.ui.mount(BAND)
    expect(await critical.find({ key: 'compact' })).toBeDefined()
    await critical.unmount()

    const busy = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true } })
    expect(await busy.find({ key: 'compact' })).toBeUndefined()
    await busy.unmount()
  })

  test('needs a second press to compact', async ($, on) => {
    mock.clock(on)
    engine(on)
    await $.session.measure(fill(93))

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Button', text: /Jetzt kompaktieren/ })).toBeDefined()

    await ui.press({ key: 'compact' })
    expect(compactions).toBe(0)
    await ui.redraw()
    expect(await ui.find({ type: 'Button', text: /Nochmal drücken/ })).toBeDefined()

    await ui.press({ key: 'compact' })
    expect(compactions).toBe(1)
    await ui.unmount()
  })

  test('the confirmation lapses after a few seconds', async ($, on) => {
    const clock = mock.clock(on)
    engine(on)
    await $.session.measure(fill(93))

    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'compact' })

    await clock.advance(9_000)
    await ui.redraw()
    expect(await ui.find({ type: 'Button', text: /Jetzt kompaktieren/ })).toBeDefined()

    await ui.press({ key: 'compact' })
    expect(compactions).toBe(0)
    await ui.unmount()
  })
})
