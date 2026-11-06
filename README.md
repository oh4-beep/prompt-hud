# prompt-hud

A live bar directly above the Claude Code prompt, in the terminal and in the Code tab of the Claude desktop app.

```
5h ▰▰▰▱▱▱▱▱ 42% ↻2h13m   7d ▰▰▰▰▰▰▰▱ 93% ↻3d4h   ctx ▰▰▰▱▱▱▱▱ 34%   task ~6m left · 1/4 steps
```

- **Usage limits:** your 5-hour and 7-day usage, with the time until each resets. If you pay by API instead of a subscription, it shows what the session has cost.
- **Context:** how full the context window is, updated during a task as well as after it.
- **Time left:** an estimate of how long the current task has to go.

Figures turn yellow at 70% and red at 90%. On narrow windows the meters drop away and the numbers stay. Click `[-]` to collapse the bar.

## How the estimate works

Claude Code does not report how long a task will take, so the bar works it out:

1. With a task list, it uses how fast the finished steps went.
2. With no list, it looks at how long your past tasks ran once they had got this far.
3. With nothing to go on, it counts up (`1m so far`) rather than guess. Without a task list, that lasts until it has seen at least 3 finished tasks.

Past task times are stored only on your computer.

## Install

At the prompt of a terminal session:

```
/plugin install prompt-hud --marketplace oh4-beep/prompt-hud
```

Answer `y` to add the marketplace, then press Enter to pick a scope.

From a shell:

```
claude plugin install prompt-hud --marketplace oh4-beep/prompt-hud
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `oh4-beep/prompt-hud`, then Add plugin.
