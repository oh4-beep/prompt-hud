import type { History, Step, StepStatus, Task } from '../types'

const MIN_SAMPLES = 3
const HISTORY_LIMIT = 50

export type Eta = {
  elapsedMs: number
  remainingMs?: number
  done: number
  total: number
}

// The arguments of every tool that keeps a task list, read loosely: the shapes
// are the tools', and a field this build's tool lacks only leaves a step as it was.
export type PlanCall = {
  todos?: { status: StepStatus }[]
  items?: { status: StepStatus }[]
  advance?: boolean
  done?: number[]
  start?: number
  taskId?: string
  status?: StepStatus | 'deleted'
}

const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b)

  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const mean = (samples: number[]) =>
  samples.reduce((sum, ms) => sum + ms, 0) / samples.length

const countDone = (steps: Step[]) =>
  steps.filter(step => step.status === 'completed').length

const toSteps = (items: { status: StepStatus }[]): Step[] =>
  items.map(({ status }, index) => ({ id: String(index), status }))

const withStatus = (step: Step, status: StepStatus): Step => ({ ...step, status })

function advance(steps: Step[]) {
  const current = steps.findIndex(step => step.status === 'in_progress')
  const following = steps.findIndex(
    (step, index) => index > current && step.status === 'pending',
  )

  return steps.map((step, index) => {
    if (index === current) return withStatus(step, 'completed')
    if (index === following) return withStatus(step, 'in_progress')

    return step
  })
}

export function stepsAfter(steps: Step[], tool: string, call: PlanCall): Step[] {
  if (tool === 'TodoWrite') return toSteps(call.todos ?? [])

  if (tool === 'TaskUpdate') {
    if (call.status === 'deleted') {
      return steps.filter(step => step.id !== call.taskId)
    }

    const { status } = call

    return status === undefined
      ? steps
      : steps.map(step => (step.id === call.taskId ? withStatus(step, status) : step))
  }

  if (call.items) return toSteps(call.items)
  if (call.advance) return advance(steps)

  return steps.map((step, index) => {
    if (call.done?.includes(index + 1)) return withStatus(step, 'completed')
    if (call.start === index + 1) return withStatus(step, 'in_progress')

    return step
  })
}

export function withSteps(task: Task, steps: Step[], now: number): Task {
  const finished = countDone(steps) - countDone(task.steps)
  const isFirstList = task.steps.length === 0
  const hasFinished = !isFirstList && finished > 0
  const share = (now - task.stepStartedAt) / finished

  return {
    ...task,
    steps,
    stepStartedAt: isFirstList || hasFinished ? now : task.stepStartedAt,
    finishedStepMs: hasFinished
      ? [...task.finishedStepMs, ...Array<number>(finished).fill(share)]
      : task.finishedStepMs,
  }
}

export function estimate(task: Task, history: History, now: number): Eta {
  const elapsedMs = Math.max(0, now - task.startedAt)
  const total = task.steps.length
  const done = countDone(task.steps)
  const eta = { elapsedMs, done, total }

  // One past step stands beside this task's own, so a first step that took
  // seconds does not promise that the rest will too.
  const paceSamples = [
    ...task.finishedStepMs,
    ...(history.stepMs.length >= MIN_SAMPLES ? [median(history.stepMs)] : []),
  ]

  if (total > 0 && paceSamples.length > 0) {
    const pace = mean(paceSamples)
    const onThisStep = Math.max(0, now - task.stepStartedAt)
    const remainingMs = (total - done) * pace - Math.min(onThisStep, pace)

    return { ...eta, remainingMs }
  }

  // With no list to go on: how much longer did the turns that got this far run?
  const longer = history.turnMs.filter(ms => ms > elapsedMs)

  return longer.length >= MIN_SAMPLES
    ? { ...eta, remainingMs: median(longer) - elapsedMs }
    : eta
}

export const remembered = (history: History, task: Task, turnMs: number): History => ({
  turnMs: [...history.turnMs, turnMs].slice(-HISTORY_LIMIT),
  stepMs: [...history.stepMs, ...task.finishedStepMs].slice(-HISTORY_LIMIT),
})
