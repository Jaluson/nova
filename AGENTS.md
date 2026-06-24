# AGENTS.md

Coding-agent guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Do not assume. Do not hide confusion. Surface tradeoffs.**

Before implementing:
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them instead of choosing silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what is confusing, and ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- Do not add features beyond what was asked.
- Do not add abstractions for single-use code.
- Do not add flexibility or configurability that was not requested.
- Do not add error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Do not improve adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing style, even if you would do it differently.
- If you notice unrelated dead code, mention it instead of deleting it.

When your changes create orphans:
- Remove imports, variables, functions, and files made unused by your changes.
- Do not remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" -> "Verify validation works for invalid inputs"
- "Fix the bug" -> "Verify the fix resolves the issue"
- "Refactor X" -> "Ensure behavior remains the same before and after"

For multi-step tasks, state a brief plan:

```text
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria such as "make it work" require clarification.

## 5. Code Audit And Verification

**Code is not complete until it passes the project's verification pipeline.**

Verification order matters:

1. Run formatters first.
2. Run linters and static analysis.
3. Run build verification.

Before finishing any task:
- Run relevant formatters, linters, and static analysis tools.
- Read actual command output and verify results.
- Fix issues introduced by your changes only.
- Prefer automatic fixes before manual edits.

Project verification standards:
- Backend with Spring Boot: `spotless:apply` -> `checkstyle:check`

When applicable:
- Verify build success.
- Ensure no new warnings or errors are introduced.

Do not:
- Claim checks passed without running them.
- Write test cases.
- Ignore lint failures.
- Disable rules to bypass failures.
- Manually fix formatting issues handled by automated formatters.
- Refactor unrelated code to satisfy tooling.

Keep verification fixes minimal and directly tied to the task.

## 6. Rust Environment

- CARGO_HOME: `C:\Users\Jaluson\.cargo`
- RUSTUP_HOME: `C:\Users\Jaluson\.rustup`
- PATH includes: `C:\Users\Jaluson\.cargo\bin`
- rustc: 1.96.0
- cargo: 1.96.0

## 7. Other

- Script rule: no Bash. Use PowerShell.
- Configure a Cloudflare Worker script to cache JSON API responses for five minutes. use context7

---

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
