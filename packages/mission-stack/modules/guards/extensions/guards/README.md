# guards

One extension, one `tool_call` hook, many guards. Consolidates the former
`push-guard` + `commit-guard` extensions and adds a `terraform` guard. Each
guard is a self-contained module sharing one quote-aware shell parser
(`shell.ts`). Adding a future guard = new module + one dispatch block in
`index.ts`.

All guards enforce policy at the tool-call layer (fires before a bash tool
runs, can block) — real gates, not advisory markdown.

## Guards

| Guard | Triggers on | Action |
|-------|-------------|--------|
| **push** (`push.ts`) | `git push` landing on a protected branch (main/master, `--all`/`--mirror`, deletes) | Confirm in UI, **block** in headless |
| **commit** (`commit.ts`) | `git commit` whose subject > max length, has an em-dash, or carries AI attribution | **Always block** (rewrite the message) |
| **terraform** (`terraform.ts`) | `terraform apply` / `terraform destroy` | Confirm in UI, **block** in headless |

### terraform: refresh-only is allowed

`terraform apply -refresh-only [-auto-approve]` only reconciles **local** state
to live cloud reality; it never mutates infrastructure. (ADR-4 / CON-2) uses it as the official replacement for the deprecated
`terraform refresh`. So an `apply` is gated **only when `-refresh-only` is
absent**. `plan`, `init`, `import`, `show`, `state`, `validate`, `fmt` are never
gated.

## Subagent models

Delegation uses `npm:pi-subagents`, not a custom guard. Configure role models
and `subagents.modelScope` in `~/.pi/agent/settings.json`. Enable both `enforce`
and `strict` to reject out-of-scope models, including inherited defaults.
Changing the allowed models requires a settings edit; mentioning a model in a
prompt does not bypass the scope.

## Config (env)

| Var | Effect |
|-----|--------|
| `GUARDS_DISABLED=1` | Master switch — disable ALL guards |
| `PUSH_GUARD_DISABLED=1` | Disable push guard |
| `PUSH_GUARD_PROTECTED=main,master,prod` | Protected branch names (default `main,master`) |
| `COMMIT_GUARD_DISABLED=1` | Disable commit guard |
| `COMMIT_GUARD_MAX=50` | Max commit subject length (default 50) |
| `TF_GUARD_DISABLED=1` | Disable terraform guard |

## Tests

```bash
node --experimental-strip-types test.ts
```

## Files

- `index.ts` — register glue: one hook, dispatches to each guard.
- `shell.ts` — shared quote-aware `splitSegments` / `tokenize` / `refBasename` / `extractCd`.
- `push.ts` — push guard logic + verdict.
- `commit.ts` — commit subject parsing + rules.
- `terraform.ts` — terraform apply/destroy detection (allows refresh-only).
- `test.ts` — SDK-free unit tests for all three guards.
