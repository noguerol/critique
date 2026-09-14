<div align="center">

![Critique banner](https://raw.githubusercontent.com/noguerol/critique/main/docs/banner.jpeg)

</div>

# Critique — Adversarial Review for pi

**Critique questions the last work step with a separate model and can challenge user instructions before the model starts.** It is not limited to code: it can review implementation work, writing, plans, research, data analysis, ops, or any other project work. Optionally, Critique also runs a fast pre-flight check on sufficiently rich user prompts and shows a short `Critique` widget when the instruction deserves pushback. The feedback is **non-mandatory**: the user and the working model remain the final judges.

Additionally, the **Questions** feature detects ambiguous user input and offers clarifying suggestions before the model acts on it.

The **autocritique-code** feature is a post-implementation QA pass: when the agent settles after doing real work, it injects a bounded adversarial directive that forces the agent to stress its own change, verify by execution, fix what it finds, and close with a report of what was achieved plus the project's next steps instead of declaring success.

---

## Features

- **Independent reviewer** — a separate model questions the work step from serialized context, with no tools of its own (can't modify files or see hidden state)
- **Auto-detects the work step** — splits the session branch into *episodes* at user-message boundaries; the last episode containing tool calls or assistant output is the work step
- **Token-budgeted context** — the user prompt, assistant messages, tool calls and tool results are truncated to a self-contained block so the reviewer sees what it needs without overflow
- **Multi-step review** — review the last `N` episodes in one shot (`/critique 3`) to catch cross-step issues
- **Focus note** — `/critique check the assumptions` biases the review without limiting it; the reviewer still scans for everything
- **Structured output** — fixed `Verdict / Issues / Suggestions / Summary` schema for actionable, parseable feedback
- **Settings menu** — `/critique config` opens an editable menu so you can change one setting at a time without rerunning a full wizard
- **Advisory injection** — on by default; toggle off (or use `/critique view`) to keep the review as read-only
- **Cancelable loader** — in TUI mode, the review runs behind a loader that you can abort with `Esc`
- **No provider surprises** — empty reviews are flagged, provider errors are surfaced as errors instead of silently producing nothing
- **Automatic prompt critique** — optional pre-flight challenge for user instructions before the model starts; trivial inputs (`ok`, tiny commands, quick corrections) are ignored
- **Three prompt-critique levels** — `Inconsistencies only` (low sensitivity), `Critical` (moderate), or `Corrosive` (high)
- **Prompt-critique model source** — use either the active working model or the configured critique model
- **Interactive Critique widget** — ultra-short one-sentence advice in the user's interaction language with `Accept`, `Discard`, or `Reply`; auto-discards after 30 seconds
- **Persistent config** — `~/.pi/agent/critique.json` stores model choice, auto-inject, and automatic prompt-critique settings across all projects
- **Questions feature** — optional clarifying widget, judged by a model, that detects genuinely ambiguous user input and offers three options: two concrete interpretations restated from your wording and a free-text answer; auto-discards after 30 seconds
- **Questions frequency** — three sensitivity levels: `Essential only` (minimal), `Normal` (moderate), or `Many questions` (high sensitivity)
- **autocritique-code** — optional post-implementation adversarial QA: after the working agent settles, if the last turn performed real work (at least one tool call), it injects a scope-bounded directive to stress edge cases, verify by execution, remediate and report a changelog; the pass runs on the active model (inline in the planner's session by default, optionally via an independent subagent when `autocritiqueCodeRecurse` is enabled), never on the critique model
- **Bounded QA passes** — `1`–`3` sequential passes per user turn, each capped at `1`–`5` verification/remediation cycles (default: one cycle); a persistent in-session marker plus an in-memory counter make self-retriggering impossible, the QA runs inline by default so multi-agent extensions such as trimegisto cannot trigger cross-session recursion, and a genuine user turn resets the budget
- **Closing QA report** — the final pass must close with a summary of everything the task achieved (and therefore what the QA corrected), the project's next steps, and an explicit invitation to continue with the first one

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

**Requirements:** a working pi installation with at least one configured model. For independent reviews, configure a second model as reviewer.

## Quick Start

```
/critique config        # (optional) open the settings menu
...                     # let the main model do some work
/critique               # review the last work step and feed the feedback back
```

The main model then sees the review appended to its next turn and decides what to apply. With auto-inject off (or `/critique view`), the review is only displayed to you.

To focus the review:

```
/critique check the assumptions behind the plan
/critique 3                             # review the last 3 work steps
/critique 2 look at the evidence gaps   # combine count + focus
```

## Commands

| Command | Description |
|---------|-------------|
| `/critique` | Review/question the last work step and inject feedback into the working model |
| `/critique <focus>` | Review the last work step with an additional focus note |
| `/critique N` | Review the last `N` work steps (max 5) |
| `/critique N <focus>` | Combine count and focus |
| `/critique view` | Show the review only, without injecting it |
| `/critique view <focus>` | View-only, with a focus note |
| `/critique view N` | View-only, last `N` steps |
| `/critique config` | Open the editable settings menu for model, auto-inject, prompt critique, questions, and autocritique-code |
| `/critique autocritique-code` | Toggle the post-implementation adversarial QA on/off |
| `/critique autocritique-code on` \| `off` | Enable/disable it explicitly |
| `/critique autocritique-code 1` \| `2` \| `3` | Enable it and set the number of QA passes per user turn (aliases: `autocritique`, `acode`) |
| `/critique autocritique-code rounds N` | Enable it and set the number of QA passes per user turn (`N` = `1`–`3`) |
| `/critique autocritique-code iterations N` | Enable it and set the max verification/remediation cycles inside each pass (`N` = `1`–`5`; aliases: `iter`, `cycle`) |
| `/critique autocritique-code recurse on` \| `off` | Toggle whether the QA pass may be delegated to a subagent (default: `off` — prevents a self-reinforcing recursion loop when multi-agent extensions such as trimegisto are active) |

**Argument parsing:**

- A leading integer (`1`–`5`) sets the number of work steps to review.
- `config` or `view` after the slash sets the mode.
- Anything else is treated as a focus note and prepended to the reviewer prompt.

## How It Works

### 1. Extract the work step

The session branch is split into *episodes* at user-message boundaries. The last episode containing tool calls or assistant output is the work step: the user request that triggered it, every tool call (with arguments), and every tool result (diffs, command output, data, errors). Content is truncated to a token budget so the reviewer sees focused, self-contained context:

| Field | Max chars |
|-------|-----------|
| User prompt | 12,000 |
| Assistant text | 8,000 |
| Tool args | 4,000 each |
| Tool result | 8,000 each |
| Total | 60,000 |

Truncated content is marked with `… [truncated]` so the reviewer can tell what it did and didn't see.

### 2. Ask the reviewer

The critique model is called directly through `ctx.modelRegistry.complete()` with **no tools** — it only judges/questions. The reviewer is told:

- The work step inside `<work-step>` tags
- An optional `<focus-note>` if you passed one
- "Do not invent issues: if the work is sound, say so and keep suggestions minimal"

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

The reviewer is told to base its judgment *only* on the provided work step, across any domain: code, writing, planning, research, data, ops, etc.

### 3. Inject the feedback

The review is sent back to the working model as a follow-up user message:

```
[Critique — advisory]

Reviewer: `provider/model`. Advice only: apply useful points; briefly reject bad ones.

---

<the review>
```

The main model then has the freedom to apply, partially apply, or reject each point. If auto-inject is off, the review is only shown to you.

### 4. Optional automatic prompt critique

When enabled in `/critique config`, Critique listens to user input before prompt-template expansion and before the agent starts. A local heuristic skips acknowledgements, slash commands, tiny corrections, and short commands. For richer instructions, a tool-free model call decides whether there is anything worth challenging.

If critique is useful, pi shows an ultra-short `Critique` widget in the user's interaction language. The model always returns both an issue and a proposed fix:

- `Accept` includes the proposed fix as extra guidance for the model.
- `Discard` sends the original prompt unchanged.
- `Reply` lets the user answer the critique/fix before the model sees the prompt.
- No interaction within 30 seconds auto-discards the advice and sends the original prompt unchanged.

Automatic prompt critique can use either the active working model or the configured critique model. It does not require a separate model.

### 5. Optional Questions feature

When enabled in `/critique config`, Critique runs a cheap local gate (size/formula) on the input and then asks a model whether the instruction is genuinely ambiguous — i.e. the wording itself supports two materially different, concrete readings and a wrong guess would make the agent do visibly different work. Only then does it show a `Questions` widget. A question is never raised on length alone, on clearly-formed instructions, or on inputs whose referents are identifiable from the instruction, the conversation, or the workspace. Generic scope flips ("one part vs the whole request", "the item just mentioned vs the overall goal") are explicitly banned at every frequency, and if the model call fails or times out the prompt is sent unchanged — a clarifying question never blocks your input.

The widget presents three options:

- **A** — the first concrete interpretation, restated from your wording
- **B** — the alternative concrete interpretation
- **C** — the user types their own answer in a free-text editor
- **Dismiss** — send the original prompt unchanged (auto-dismisses after 30 seconds)

The selected answer is prepended to the user's prompt as a clarification, so the working model receives a more precise instruction.

#### Questions Frequency

The sensitivity of the Questions feature is controlled by the **Questions frequency** setting:

| Level | Description |
|-------|-------------|
| **Essential only** | Model-judged; ask only when a wrong guess would materially derail the work and the instruction offers two explicit, contrasting readings. Intentionally near-silent. |
| **Normal** | Model-judged; ask when the instruction offers two plausible contrasting readings and a wrong guess would change what the agent does. |
| **Many questions** | Model-judged; ask whenever a quick clarification could plausibly help, even mildly. Never on fully clear instructions. |

### 6. Optional autocritique-code (post-implementation adversarial QA)

When enabled, Critique listens to `agent_settled` — the point where pi will not auto-retry, compact or continue — and, once the agent has finished a turn that actually did work, injects one adversarial QA directive as a follow-up user message. Pure chat turns (no tool calls in the last work episode) are left untouched.

The improved directive replaces the original "loop until 100% clean" idea with something bounded and safe:

- **Scope-bounded** — it explicitly says this is not a new feature request and not a rewrite; fixes must stay inside the original task.
- **Execution over inspection** — run the test suites, linters, type checks and the real code paths, and read the output; write the missing tests when coverage is insufficient.
- **Fix, don't report** — remediate every real issue and re-run verification, with a configurable cap on verification/remediation cycles inside the pass (default: **one** cycle, so a pass verifies and fixes what it finds; raise it to `2`–`5` when you want the agent to keep iterating on itself).
- **No invented requirements** — anything that needs a product decision is recorded as residual risk instead of guessed at.
- **Evidence required** — the pass must end with an itemized report (*Achieved / Fixed / Tests / Improved / Residual risk*) backed by executed checks, and may not claim success without one.
- **Closing report with next steps** — when the QA ends, the agent must tell the user, in their language, what the task accomplished and what the QA corrected, then lay out the project's logical next steps and explicitly invite the user to continue with the first one (in multi-pass mode, this full closing report is required from the final pass).
- **Inline by default; opt-in subagent delegation** — the QA pass runs inline in the planner's session by default. This keeps the critique on the planner's final response (the one that has already reconciled its sub-agents) and prevents the self-reinforcing recursion that otherwise occurs with multi-agent extensions such as trimegisto: a delegated QA settles in its own session, fires `agent_settled`, and would otherwise trigger another autocritique pass that spawns more subagents. Set `autocritiqueCodeRecurse: true` to restore the original "delegate to a subagent when available" behaviour (the subagent must still run on the active/main model; the model configured for `/critique` is never used for this pass).

Loop safety is enforced independently of the model: the directive carries a stable marker, and the extension counts consecutive markers at the end of the session branch. A `1`–`3` pass budget caps the worst case, an in-memory counter catches any marker-detection miss, and a genuine user turn resets the budget. Each pass is additionally capped at `1`–`5` verification/remediation cycles (default: `1`). With the default of one pass and one cycle, a completed user turn gets exactly one focused QA pass.

## Model Selection

`/critique config` opens an editable settings menu. Select a setting to change only that value, toggle booleans directly, or choose `Done`/`Esc` to close. Changes are persisted as soon as each setting is edited.

The `Critique model` entry opens the critic model picker. It only offers models with configured auth, **only** from pi's native model registry — the same list you see in `/model`. The picker shows at most ten entries at a time and scrolls past that.

**Auto** (the default) prefers a *different* model than the working one, so the review is genuinely independent. If no second model is available, it falls back to the working model and warns you when it runs.

If you pin a specific model that's later removed or uninstalled, critique silently falls back to Auto.

If the critique model and the working model are the same, critique warns you — pick a different reviewer to get a genuinely independent second opinion.

## Configuration

The config is persisted as JSON at `~/.pi/agent/critique.json`:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "autoInject": true,
  "autoPromptCritique": false,
  "autoPromptCritiqueLevel": "inconsistencies",
  "autoPromptCritiqueModel": "working",
  "questions": false,
  "questionsFrequency": "normal",
  "autocritiqueCode": false,
  "autocritiqueCodeRounds": 1,
  "autocritiqueCodeIterations": 1,
  "autocritiqueCodeRecurse": false
}
```

- **`model`** — canonical `provider/modelId` of the reviewer. Empty string = Auto (different from working model).
- **`autoInject`** — when `true`, the review is injected back into the working model. When `false`, the review is only displayed.
- **`autoPromptCritique`** — when `true`, sufficiently rich user instructions are challenged before the model starts.
- **`autoPromptCritiqueLevel`** — `inconsistencies` only flags real misunderstanding risks; `critical` is moderate; `corrosive` is highly sensitive and skips only clearly logical/complete prompts.
- **`autoPromptCritiqueModel`** — `working` uses the active model; `critique` uses the configured critique model.
- **`questions`** — when `true`, ambiguous user input triggers a clarifying Questions widget before the model receives the prompt.
- **`questionsFrequency`** — sensitivity of the Questions feature: `essential` (minimal), `normal` (moderate), or `verbose` (high; "many questions").
- **`autocritiqueCode`** — when `true`, injects an adversarial QA pass after the working agent settles on a turn that did real work.
- **`autocritiqueCodeRounds`** — how many sequential QA passes may follow a single user turn: `1` (default), `2`, or `3`.
- **`autocritiqueCodeIterations`** — max verification/remediation cycles the agent may run inside each QA pass: `1` (default), `2`, `3`, `4`, or `5`. Put it at `1` for a single verify-and-fix cycle, or raise it when you want the agent to keep iterating until the executed checks hold.
- **`autocritiqueCodeRecurse`** — when `true`, the directive tells the agent to delegate the QA pass to a subagent (the original behaviour). When `false` (default), the directive forbids delegation so the QA runs inline in the planner's session, which prevents the recursive agent spawn that occurs with multi-agent extensions such as trimegisto. Switch it to `true` only when you want subagent delegation and accept that the QA may settle in a separate session whose own `agent_settled` would normally trigger another autocritique pass.

The settings menu offers any model with configured auth that's available in pi's registry; the config persists per-machine (in `getAgentDir()`), shared across all projects.

## Architecture

```
critique/
├── package.json        # pi package manifest (pi-package)
├── LICENSE             # MIT
├── README.md
├── docs/
│   ├── banner.jpeg      # wide README header
│   └── preview.jpeg     # npm pi.dev preview card
└── src/
    ├── index.ts             # /critique command surface, config UI, review UI, input + agent_settled hooks
    ├── config.ts            # persistence + model resolution: pinned, auto, fallback
    ├── autocritique-code.ts # post-implementation adversarial QA: directive builder + anti-loop policy
    ├── prompt-critique.ts   # automatic user-prompt critique prompt, gate, model call, questions detection
    ├── work-step.ts         # episode splitting + token-budgeted serialization
    └── review.ts            # reviewer prompt + model call + injected-message builder
```

Six-file extension with zero external dependencies (only pi's bundled `@earendil-works/*` + Node built-ins):

- **Episode splitter** — splits a session branch into user-message-bounded episodes, picks the last one with work
- **Token budgeter** — hard caps per field, marks truncations so the reviewer knows what it didn't see
- **Reviewer call** — tool-free `ctx.modelRegistry.complete()` with a domain-general structured prompt
- **Advisory formatter** — wraps the review in a "non-mandatory" envelope before injecting as a follow-up user message
- **Prompt critique** — optional input hook with local trivial-prompt gate, three challenge levels, and ultra-short JSON model output
- **Questions detection** — size gate + tool-free model judgment of genuine ambiguity (generic "part vs whole"-style readings explicitly banned), three frequency levels; shows a clarifying widget with A/B/C options
- **autocritique-code** — pure directive builder + anti-loop policy driven by the `agent_settled` event; counts its own markers in the session branch, applies a 1–3 pass budget and a configurable 1–5 cycle budget per pass, and skips turns without real tool work
- **UI** — lazy-loaded pickers/viewers/loaders + 30-second Critique widget + 30-second Questions widget

## Notes

- The critique model runs with **no tools** and never touches the filesystem. It judges purely from the serialized work step, whatever the domain.
- In TUI mode the review runs behind a cancelable loader (Esc aborts) and `/critique view` opens a scrollable Markdown viewer. Automatic prompt critique appears as a compact `Critique` widget with a 30-second auto-discard timeout. The Questions feature appears as a `Questions` widget with the same timeout. In RPC mode reviews are surfaced through notifications/dialogs; print mode logs manual reviews to stdout and skips automatic prompt critique and questions.
- Provider errors (bad keys, insufficient balance, rate limit) are surfaced as errors instead of silently producing empty reviews.
- Reviews are capped at 16,000 chars to keep the injected follow-up reasonable; longer reviews are truncated with `… [review truncated]`.
- autocritique-code only runs in dialog-capable modes (TUI/RPC) and only after a turn that performed at least one tool call. Each injected pass is a real user message, so it gets its own work episode and never contaminates the previous one during a later manual `/critique`. By default the QA runs inline in the planner's session and never delegates to a subagent; set `autocritiqueCodeRecurse: true` to opt back into the original "delegate when available" behaviour (note that this is incompatible with multi-agent extensions such as trimegisto, which will cause a self-reinforcing recursion loop unless the extension itself cooperates with critique's anti-loop marker).

## License

[MIT](LICENSE) © critique contributors
