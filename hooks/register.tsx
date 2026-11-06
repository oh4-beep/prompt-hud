import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { History, Limit, Task, Usage } from '../types'
import { estimate, remembered, stepsAfter, withSteps } from './task'
import type { PlanCall } from './task'

const PLAN_TOOLS = [
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'mcp__ccd_turn__update_plan',
] as const

const TICK_MS = 1_000
const IDLE_TICK_MS = 60_000
const MINUTE_MS = 60_000
const METER_CELLS = 8
const COLUMNS_FOR_METERS = 96
const HISTORY_KEY = 'history'

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

const usage = atom({ plugin: 'prompt-hud', key: 'usage' } as const, null)
const task = atom({ plugin: 'prompt-hud', key: 'task' } as const, null)
const history = atom({ plugin: 'prompt-hud', key: 'history' } as const, {
  turnMs: [],
  stepMs: [],
})
const clock = atom({ plugin: 'prompt-hud', key: 'now' } as const, 0)

const toUsage = ({
  context,
  rateLimits,
  cost,
}: Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>): Usage => ({
  contextPercent: context.percent,
  limits: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({
    kind,
    percentUsed,
    resetsAt,
  })),
  costUsd: cost?.usd,
})

const severity = (percent: number): Color => {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'

  return 'success'
}

const meter = (percent: number) => {
  const filled = Math.round((Math.min(percent, 100) / 100) * METER_CELLS)

  return '▰'.repeat(filled) + '▱'.repeat(METER_CELLS - filled)
}

const span = (ms: number) => {
  const minutes = Math.floor(ms / MINUTE_MS)

  if (minutes < 1) return `${Math.floor(ms / 1000)}s`
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours}h${minutes % 60}m`

  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

const timeLeft = (remainingMs: number) => {
  if (remainingMs <= 0) return 'finishing up'
  if (remainingMs < MINUTE_MS) return '<1m left'

  return `~${span(Math.ceil(remainingMs / MINUTE_MS) * MINUTE_MS)} left`
}

const resetsIn = ({ resetsAt }: Limit, now: number) => {
  const remainingMs = resetsAt === undefined ? NaN : Date.parse(resetsAt) - now

  return remainingMs > 0 ? ` ↻${span(remainingMs)}` : ''
}

const createdTaskId = (result: unknown) =>
  (result as { result?: { task?: { id?: string } } }).result?.task?.id ?? ''

async function loadHistory($: EngineInterface): Promise<History> {
  const stored = (await $.store.get(HISTORY_KEY)) as Partial<History> | undefined

  return { turnMs: stored?.turnMs ?? [], stepMs: stored?.stepMs ?? [] }
}

async function refresh($: EngineInterface) {
  const figures = toUsage(await $.session.usage())

  await update($, usage, () => figures)
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const isIdle = (await read($, task)) === null

  // Idle, nothing moves but the reset countdowns, and those read in minutes.
  if (isIdle && now - (await read($, clock)) < IDLE_TICK_MS) return

  await update($, clock, () => now)
  if (!isIdle) await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const stored = await loadHistory($)
    const now = await $.clock.now()

    await update($, history, () => stored)
    await update($, clock, () => now)
    await refresh($)
    $.clock.every(TICK_MS, () => void tick($))

    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e))

    return next(e)
  })

  // A cleared conversation has no fill until its first reply reports one.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, usage, value => value && { ...value, contextPercent: undefined })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      const started: Task = {
        startedAt: now,
        steps: [],
        stepStartedAt: now,
        finishedStepMs: [],
      }

      await update($, task, () => started)
      await update($, clock, () => now)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const finished = await read($, task)

      await update($, task, () => null)

      // An interrupted turn says nothing about how long a task takes.
      if (finished !== null && e.reason === 'answer') {
        const kept = remembered(await loadHistory($), finished, e.durationMs)

        await $.store.set(HISTORY_KEY, kept)
        await update($, history, () => kept)
      }
    }

    return next(e)
  })

  on('tool.call', { tool: PLAN_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    const current = await read($, task)

    if (e.agentId !== undefined || current === null) return result

    const now = await $.clock.now()
    const steps =
      e.tool === 'TaskCreate'
        ? [...current.steps, { id: createdTaskId(result), status: 'pending' as const }]
        : stepsAfter(current.steps, e.tool, e as PlanCall)

    await update($, task, value => (value === null ? value : withSteps(value, steps, now)))

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const figures = await read($, usage)
    const running = await read($, task)
    const past = await read($, history)
    const now = await read($, clock)
    const hasMeters = e.props.bodyColumns >= COLUMNS_FOR_METERS

    const gauge = (label: string, percent: number, tail = '') => (
      <Text>
        <Text dimColor>{label} </Text>
        {hasMeters && <Text color={severity(percent)}>{meter(percent)} </Text>}
        <Text color={severity(percent)}>{Math.round(percent)}%</Text>
        <Text dimColor>{tail}</Text>
      </Text>
    )

    const pending = (label: string, text: string) => (
      <Text>
        <Text dimColor>
          {label} {text}
        </Text>
      </Text>
    )

    const limits = figures?.limits ?? []
    const costUsd = figures?.costUsd ?? 0

    const limitRows =
      limits.length > 0
        ? limits.map(limit =>
            gauge(
              LIMIT_LABELS[limit.kind] ?? limit.kind,
              limit.percentUsed,
              resetsIn(limit, now),
            ),
          )
        : [
            costUsd > 0
              ? pending('spent', `$${costUsd.toFixed(2)}`)
              : pending('limits', 'after first reply'),
          ]

    const taskRow = () => {
      if (!e.props.isWorking) return pending('task', 'idle')
      if (running === null) return pending('task', 'running')

      const { elapsedMs, remainingMs, done, total } = estimate(running, past, now)
      const left = remainingMs === undefined ? `${span(elapsedMs)} so far` : timeLeft(remainingMs)

      return (
        <Text>
          <Text dimColor>task </Text>
          <Text color="claude">{left}</Text>
          {total > 0 && (
            <Text dimColor>
              {' '}
              · {done}/{total} steps
            </Text>
          )}
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box flexWrap="wrap" columnGap={3}>
          {limitRows}
          {figures?.contextPercent === undefined
            ? pending('ctx', '—')
            : gauge('ctx', figures.contextPercent)}
          {taskRow()}
        </Box>
      </Box>
    )
  })
}
