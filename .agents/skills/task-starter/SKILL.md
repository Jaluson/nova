---
name: task-starter
description: Start a task by confirming the user's intent, decomposing work into serial and parallel steps, waiting for user approval, executing the approved plan, and summarizing results. Use when a user asks Codex to begin or manage a multi-step task workflow with explicit confirmation before execution.
---

# Task Starter

## Workflow

Use this workflow before executing a user task.

1. Understand the user's intent.
   - Do not guess.
   - Confirm the user's requirement completely before planning.
   - If any requirement is unclear, ask concise clarifying questions and wait.

2. Decompose the task.
   - Split work into serial tasks that must happen in order.
   - Split independent work into parallel tasks.
   - Show the decomposition to the user.
   - Wait for the user's confirmation before execution.

3. Execute the task.
   - Follow the confirmed plan.
   - Run serial tasks in order.
   - Run independent parallel tasks concurrently when appropriate.
   - Use multiple agents to accelerate parallel work when the environment supports it and the task benefits from independent execution.

4. Summarize the result.
   - State what was completed.
   - State what was verified.
   - State any blockers, unresolved questions, or follow-up work.

## Response Shape

Before execution, use:

```text
Understanding:
[confirmed user intent]

Task Breakdown:
Serial Tasks:
1. ...
2. ...

Parallel Tasks:
- ...
- ...

Please confirm whether to execute this plan.
```

After execution, use:

```text
Result:
- Completed: ...
- Verified: ...
- Unfinished/Risks: ...
```
