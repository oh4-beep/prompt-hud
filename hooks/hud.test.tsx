import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-11-06T12:00:00Z')
const MINUTE = 60_000
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'

const USAGE = {
  startedAt: NOW,
  context: { tokens: 68_000, window: 200_000, percent: 34 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-11-06T14:13:00Z' },
    { kind: 'seven_day', percentUsed: 93, resetsAt: '2026-11-09T16:00:00Z' },
  ],
  cost: { usd: 0.5 },
}

const BAND = {
  plugin: 'prompt-hud',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

type Engine = Parameters<TestBody>[0]
type Hooks = Parameters<TestBody>[1]

// Nothing sits beneath the plugin in a test: these stand for the engine.
function engine(on: Hooks, usage: unknown = USAGE) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('session.usage', () => ({ value: usage }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { task: { id: 'created' } } }) as never)
}

const start = ($: Engine, turnId = 't1') =>
  $.turn.start({ text: 'go', turnId })

const end = (
  $: Engine,
  reason: 'answer' | 'aborted',
  durationMs: number,
) =>
  $.turn.complete({
    answer: 'done',
    durationMs,
    isAborted: reason === 'aborted',
    turnId: 't1',
    reason,
  } as never)

const items = (...statuses: string[]) =>
  statuses.map(status => ({ content: 'step', status }))

const startSession = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

async function barText($: Engine, surface: 'terminal' | 'desktop', isWorking = false) {
  const ui = await $.ui.mount({
    ...BAND,
    surface,
    props: { ...BAND.props, isWorking },
  })
  const rows = await ui.find({ type: 'Box' })
  await ui.unmount()

  return rows?.text ?? ''
}

test('idle, the bar shows limits, resets and context on both surfaces', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)

  for (const surface of SURFACES) {
    const text = await barText($, surface)

    expect(text).toContain('5h')
    expect(text).toContain('42%')
    expect(text).toContain('↻2h13m')
    expect(text).toContain('7d')
    expect(text).toContain('93%')
    expect(text).toContain('↻3d4h')
    expect(text).toContain('ctx')
    expect(text).toContain('34%')
    expect(text).toContain('task idle')
  }
})

test('a narrow bar drops the meters and keeps the figures', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)

  const wide = await barText($, 'terminal')
  expect(wide).toContain('▰')

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, bodyColumns: 60 },
  })
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  await ui.unmount()

  expect(text).not.toContain('▰')
  expect(text).toContain('42%')
})

test('off a subscription the bar shows what the session cost', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on, { ...USAGE, rateLimits: [], cost: { usd: 1.234 } })
  await startSession($)

  expect(await barText($, 'desktop')).toContain('spent $1.23')
})

test('before any reply the bar says the limits are still to come', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on, { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] })
  await startSession($)

  const text = await barText($, 'terminal')

  expect(text).toContain('limits after first reply')
  expect(text).toContain('ctx —')
})

test('with no history and no list it counts up rather than guess', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)
  await start($)
  await clock.advance(90_000)

  expect(await barText($, 'desktop', true)).toContain('1m so far')
})

test('a task list gives the pace, from the steps already finished', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)
  await start($)

  await $.tool.call({ tool: PLAN_TOOL, items: items('in_progress', 'pending', 'pending', 'pending') } as never)
  await clock.advance(2 * MINUTE)
  await $.tool.call({ tool: PLAN_TOOL, advance: true } as never)
  await clock.advance(1_000)

  const text = await barText($, 'terminal', true)

  // One step took 2m; three remain, 1s of the next already spent.
  expect(text).toContain('~6m left')
  expect(text).toContain('1/4 steps')
})

test('TodoWrite and the Task tools drive the same list', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)
  await start($)

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'a', status: 'completed', activeForm: 'a' },
      { content: 'b', status: 'pending', activeForm: 'b' },
    ],
  } as never)
  await clock.advance(1_000)
  expect(await barText($, 'desktop', true)).toContain('1/2 steps')

  await end($, 'aborted', 1_000)
  await start($, 't2')
  await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'created', status: 'completed' } as never)
  await clock.advance(1_000)
  expect(await barText($, 'desktop', true)).toContain('1/1 steps')
})

test('a subagent keeping its own list leaves the bar alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)
  await start($)

  await $.tool.call({
    tool: PLAN_TOOL,
    items: items('completed', 'pending'),
    agentId: 'a1',
  } as never)
  await clock.advance(1_000)

  expect(await barText($, 'terminal', true)).not.toContain('steps')
})

test('finished tasks teach it; interrupted ones do not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)

  for (const turnId of ['a', 'b', 'c']) {
    await start($, turnId)
    await end($, 'answer', 10 * MINUTE)
  }

  await start($, 'interrupted')
  await end($, 'aborted', 1_000)

  await start($, 'd')
  await clock.advance(4 * MINUTE)

  expect(await barText($, 'desktop', true)).toContain('~6m left')
})

test('history survives into the next session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { history: { turnMs: [MINUTE, 3 * MINUTE, 5 * MINUTE], stepMs: [] } })
  engine(on)
  await startSession($)
  await start($)
  await clock.advance(30_000)

  expect(await barText($, 'terminal', true)).toContain('~3m left')
})

test('past the turns it has seen, it stops promising', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { history: { turnMs: [MINUTE, MINUTE, MINUTE], stepMs: [] } })
  engine(on)
  await startSession($)
  await start($)
  await clock.advance(5 * MINUTE)

  const text = await barText($, 'desktop', true)

  expect(text).toContain('5m so far')
  expect(text).not.toContain('left')
})

test('the bar shares the band with what is already there', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)

  for (const surface of SURFACES) {
    const text = await barText($, surface)

    expect(text).toContain('engine band')
    expect(text).toContain('task idle')
  }
})

test('a cleared conversation stops showing the old context figure', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)
  await $.session.end({
    reason: 'clear',
    sessionId: 'old',
    resume: { sessionId: 'old' },
  } as never)

  const text = await barText($, 'desktop')

  expect(text).toContain('ctx —')
  expect(text).toContain('42%')
})

test('the bar steps aside for a survey', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on)
  await startSession($)

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, hasSurvey: true },
  })

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine band')
  await ui.unmount()
})
