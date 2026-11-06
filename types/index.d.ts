export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  contextPercent?: number
  limits: Limit[]
  costUsd?: number
}

export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type Step = { id: string; status: StepStatus }

// The turn in progress; null between turns.
export type Task = {
  startedAt: number
  steps: Step[]
  stepStartedAt: number
  finishedStepMs: number[]
}

// What past tasks took, kept across sessions. All in milliseconds.
export type History = { turnMs: number[]; stepMs: number[] }

declare module 'claude-code' {
  interface PluginState {
    'prompt-hud': {
      usage: Usage | null
      task: Task | null
      history: History
      now: number
    }
  }
}
