<div align="center">

![Critique banner](docs/banner.png)

</div>

# Critique — Adversarial Code Review for pi

**Critique reviews the last work step with a separate model and feeds the review back to the working model as advisory feedback.** Two thinking machines face off — the working model produced a work step, and an independent reviewer picks it apart for correctness, robustness, maintainability and efficiency. The verdict comes back as structured Markdown: `APPROVED`, `APPROVED_WITH_SUGGESTIONS`, or `CHANGES_RECOMMENDED` — and the working model stays the final judge. The feedback is **non-mandatory**: it applies, partially applies, or rejects each point as it sees fit.

---

## Features

- **Independent reviewer** — a separate model judges the work step from the serialized context, with no tools of its own (can't modify the codebase, can't see your secrets)
- **Auto-detects the work step** — splits the session branch into *episodes* at user-message boundaries; the last episode containing tool calls or assistant output is the work step
- **Token-budgeted context** — the user prompt, assistant messages, tool calls and tool results are truncated to a self-contained block so the reviewer sees what it needs without overflow
- **Multi-step review** — review the last `N` episodes in one shot (`/critique 3`) to catch interactions across steps
- **Focus note** — `/critique check the error handling` biases the review without limiting it; the reviewer still scans for everything
- **Structured output** — fixed `Verdict / Issues / Suggestions / Summary` schema so the feedback is always actionable and machine-parseable
- **Independent model picker** — `/critique config` lets you choose the reviewer; the default is a *different* model than the working one, ensuring a genuinely independent perspective
- **Advisory injection** — on by default; toggle off (or use `/critique view`) to keep the review as read-only
- **Cancelable loader** — in TUI mode, the review runs behind a loader that you can abort with `Esc`
- **No provider surprises** — empty reviews are flagged, provider errors are surfaced as errors instead of silently producing nothing
- **Persistent config** — `~/.pi/agent/critique.json` stores the model choice and auto-inject toggle across all projects

## Install

Critique is a [pi package](https://pi.dev/packages): one extension (`src/index.ts`) declared in `package.json`.

```bash
# From GitHub
pi install git:github.com/noguerol/critique

# Pin a tag/commit
pi install git:github.com/noguerol/critique@v1.0.0

# From npm
pi install npm:pi-critique-model

# Local checkout (development)
pi install /path/to/critique

# Try it for one run only
pi -e git:github.com/noguerol/critique
```

```bash
pi list                      # show installed packages
pi remove npm:pi-critique-model
```

> **Security:** pi packages run with full system access — extensions execute arbitrary code. Install only packages you trust and review the source.

**Requirements:** a working pi installation with at least two models configured (one is the *working* model, the other becomes the *reviewer*). Models can be from the same provider as long as they have different IDs.

## Quick Start

```
/critique config        # (optional) pick a reviewer model — defaults to "different from the working one"
...                     # let the main model do some work
/critique               # review the last work step and feed the feedback back
```

The main model then sees the review appended to its next turn and decides what to apply. With auto-inject off (or `/critique view`), the review is only displayed to you — useful when you're just exploring whether to apply changes.

To focus the review:

```
/critique check the error handling on the retry logic
/critique 3                             # review the last 3 work steps
/critique 2 look at the test coverage   # combine count + focus
```

## Commands

| Command | Description |
|---------|-------------|
| `/critique` | Review the last work step and inject the feedback back into the working model |
| `/critique <focus>` | Review the last work step with an additional focus note |
| `/critique N` | Review the last `N` work steps (max 5) |
| `/critique N <focus>` | Combine count and focus |
| `/critique view` | Show the review only, without injecting it |
| `/critique view <focus>` | View-only, with a focus note |
| `/critique view N` | View-only, last `N` steps |
| `/critique config` | Pick the critique model from pi's native active models and toggle auto-inject |

**Argument parsing:**

- A leading integer (`1`–`5`) sets the number of work steps to review.
- `config` or `view` after the slash sets the mode.
- Anything else is treated as a focus note and prepended to the reviewer prompt.

## How It Works

### 1. Extract the work step

The session branch is split into *episodes* at user-message boundaries. The last episode containing tool calls or assistant output is the work step: the user request that triggered it, every tool call (with arguments), and every tool result (diffs, command output, errors). Content is truncated to a token budget so the reviewer sees a focused, self-contained context:

| Field | Max chars |
|-------|-----------|
| User prompt | 12,000 |
| Assistant text | 8,000 |
| Tool args | 4,000 each |
| Tool result | 8,000 each |
| Total | 60,000 |

Truncated content is marked with `… [truncated]` so the reviewer can tell what it did and didn't see.

### 2. Ask the reviewer

The critique model is called directly through `ctx.modelRegistry.complete()` with **no tools** — it only judges. The reviewer is told:

- The work step inside `<work-step>` tags
- An optional `<focus-note>` if you passed one
- "Do not invent issues: if the work is correct, say so and keep suggestions minimal"

It replies in a fixed Markdown structure:

```
## Verdict
APPROVED | APPROVED_WITH_SUGGESTIONS | CHANGES_RECOMMENDED

## Issues
- [severity: critical|major|minor] description

## Suggestions
- concrete, actionable suggestion

## Summary
2-4 sentence overall assessment.
```

The reviewer is also told explicitly to base its judgment *only* on the provided work step, so a reviewer on a smaller/cheaper model still gives useful feedback.

### 3. Inject the feedback

The review is sent back to the working model as a follow-up user message:

```
[Critique — advisory review of your last work step]

A separate reviewer model (`provider/model`) reviewed the work you just
performed. This feedback is **advisory, not mandatory**: you are the final
judge. Apply only the points that genuinely improve the work, and if you
disagree with any of them, briefly explain why and continue.

--- Review ---
<the review>
```

The main model then has the freedom to apply, partially apply, or reject each point. If auto-inject is off, the review is only shown to you.

## Model Selection

`/critique config` opens the critic model picker. It only offers models with configured auth, **only** from pi's native model registry — the same list you see in `/model`. The picker shows at most ten entries at a time and scrolls past that.

**Auto** (the default) prefers a *different* model than the working one, so the review is genuinely independent. If no second model is available, it falls back to the working model and warns you when it runs.

If you pin a specific model that's later removed or uninstalled, critique silently falls back to Auto.

If the critique model and the working model are the same, critique warns you — pick a different reviewer to get a genuinely independent second opinion.

## Configuration

The config is persisted as JSON at `~/.pi/agent/critique.json`:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "autoInject": true
}
```

- **`model`** — canonical `provider/modelId` of the reviewer. Empty string = Auto (different from working model).
- **`autoInject`** — when `true`, the review is injected back into the working model. When `false`, the review is only displayed.

The picker offers any model with configured auth that's available in pi's registry; the config persists per-machine (in `getAgentDir()`), shared across all projects.

## Architecture

```
critique/
├── package.json        # pi package manifest (pi-package)
├── LICENSE             # MIT
├── README.md
├── docs/
│   ├── banner.png      # wide README header
│   └── preview.png     # npm pi.dev preview card
├── screenshot.png      # full-res master
└── src/
    ├── index.ts        # /critique command surface, model picker, review UI (≈300 lines)
    ├── config.ts       # persistence + model resolution: pinned, auto, fallback (≈90 lines)
    ├── work-step.ts    # episode splitting + token-budgeted serialization (≈200 lines)
    └── review.ts       # reviewer prompt + model call + injected-message builder (≈115 lines)
```

Four-file extension with zero external dependencies (only pi's bundled `@earendil-works/*` + Node built-ins):

- **Episode splitter** — splits a session branch into user-message-bounded episodes, picks the last one with work
- **Token budgeter** — hard caps per field, marks truncations so the reviewer knows what it didn't see
- **Reviewer call** — tool-free `ctx.modelRegistry.complete()` with a structured system prompt
- **Advisory formatter** — wraps the review in a "non-mandatory" envelope before injecting as a follow-up user message
- **UI** — paginated TUI model picker (SelectList) + Markdown review viewer + cancelable BorderedLoader

## Notes

- The critique model runs with **no tools** and never touches the filesystem. It judges purely from the serialized work step (which includes the diffs and outputs of `edit`/`write`/`bash` calls).
- In TUI mode the review runs behind a cancelable loader (Esc aborts) and `/critique view` opens a scrollable Markdown viewer. In RPC mode reviews are surfaced through notifications; print mode logs them to stdout.
- Provider errors (bad keys, insufficient balance, rate limit) are surfaced as errors instead of silently producing empty reviews.
- Reviews are capped at 16,000 chars to keep the injected follow-up reasonable; longer reviews are truncated with `… [review truncated]`.

## License

[MIT](LICENSE) © critique contributors
