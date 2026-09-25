/**
 * Critique — autocritique-code (post-implementation adversarial QA).
 *
 * When enabled, the extension watches for the working agent to fully settle
 * (agent_settled) and, once per user turn, injects an "adversarial QA &
 * auto-remediation" directive as a follow-up user message. The directive makes
 * the working agent stress its own change, execute the verification suite, fix
 * what it finds, and report an itemized changelog instead of declaring success.
 *
 * This module is intentionally pure: no runtime imports, so it can be unit
 * tested with `node --experimental-strip-types --test`. The event wiring lives
 * in index.ts.
 */

/** How many adversarial QA passes may run after a single user turn. */
export type AutocritiqueCodeRounds = 1 | 2 | 3;

export const AUTOCRITIQUE_CODE_ROUNDS: AutocritiqueCodeRounds[] = [1, 2, 3];

/** Max verification/remediation cycles the agent may run inside one QA pass. */
export type AutocritiqueCodeIterations = 1 | 2 | 3 | 4 | 5;

export const AUTOCRITIQUE_CODE_ITERATIONS: AutocritiqueCodeIterations[] = [1, 2, 3, 4, 5];

/**
 * Marker embedded in the injected directive. It is the persistent half of the
 * loop guard: any user message carrying it is an autocritique-code pass, never
 * a genuine user turn.
 */
export const AUTOCRITIQUE_CODE_MARKER = "[Autocritique-Code — Adversarial QA]";

/** Default max verification/remediation cycles inside one pass. */
export const DEFAULT_AUTOCRITIQUE_CODE_ITERATIONS: AutocritiqueCodeIterations = 1;

/** @deprecated Use DEFAULT_AUTOCRITIQUE_CODE_ITERATIONS (kept for compatibility). */
export const AUTOCRITIQUE_CODE_INTERNAL_BUDGET = DEFAULT_AUTOCRITIQUE_CODE_ITERATIONS;

export const DEFAULT_AUTOCRITIQUE_CODE_ROUNDS: AutocritiqueCodeRounds = 1;

/** Narrow arbitrary config input to a valid round count. */
export function normalizeAutocritiqueCodeRounds(value: unknown): AutocritiqueCodeRounds {
  return value === 2 || value === 3 ? value : DEFAULT_AUTOCRITIQUE_CODE_ROUNDS;
}

/** Narrow arbitrary config input to a valid verification-cycle count. */
export function normalizeAutocritiqueCodeIterations(value: unknown): AutocritiqueCodeIterations {
  const n = typeof value === "number" ? Math.trunc(value) : Number.NaN;
  return (AUTOCRITIQUE_CODE_ITERATIONS as number[]).includes(n)
    ? (n as AutocritiqueCodeIterations)
    : DEFAULT_AUTOCRITIQUE_CODE_ITERATIONS;
}

/** True when a user message is an injected autocritique-code directive. */
export function isAutocritiqueCodePrompt(text: string): boolean {
  return typeof text === "string" && text.includes(AUTOCRITIQUE_CODE_MARKER);
}

/**
 * Environment variables that mark this process as a delegated subagent, set by
 * the multi-agent extension that spawned it (trimegisto sets TRIMEGISTO_AGENT_ID
 * on every subagent process). Such a session must never inject its own
 * autocritique pass: its first prompt is the delegated task and carries no
 * marker, so the per-session budgets cannot see the parent's pass and the QA
 * would fan out recursively across sessions. This is the mechanical half of the
 * loop guard; the prompt text is only defense in depth.
 */
export const SUBAGENT_ENV_MARKERS = ["TRIMEGISTO_AGENT_ID", "PI_CRITIQUE_SUBAGENT"] as const;

/** True when the current process is a delegated subagent session. */
export function isDelegatedSubagentSession(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return SUBAGENT_ENV_MARKERS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * Count consecutive autocritique-code directives at the tail of the user
 * prompts (oldest first). Stops at the first genuine user turn, so it measures
 * "passes since the last real request" and resets naturally on the next prompt.
 */
export function countTrailingAutocritiqueCodeRounds(userPrompts: readonly string[]): number {
  let count = 0;
  for (let i = userPrompts.length - 1; i >= 0; i--) {
    const text = userPrompts[i];
    if (typeof text !== "string" || !text.trim()) continue;
    if (!isAutocritiqueCodePrompt(text)) break;
    count += 1;
  }
  return count;
}

export interface AutocritiqueCodeDecisionInput {
  /** Feature toggle from config. */
  enabled: boolean;
  /** Dialog-capable UI available (TUI/RPC). Print/json modes are skipped. */
  hasUI: boolean;
  /** Agent is not streaming anymore. */
  idle: boolean;
  /** Passes already spent after the current user turn (marker or in-memory). */
  roundsUsed: number;
  /** Configured maximum passes per user turn. */
  maxRounds: AutocritiqueCodeRounds;
  /** The most recent work episode performed at least one tool call. */
  lastStepHasToolCalls: boolean;
}

export type AutocritiqueCodeDecision =
  | { run: true }
  | { run: false; reason: string };

/**
 * Decide whether to inject a pass. Every skip reason is explicit so it can be
 * surfaced (when verbose) and asserted in tests. Note that the loop is bounded
 * by `roundsUsed` alone: an injected directive always counts as a used round
 * (persistent marker and in-memory counter), so no separate "last prompt is a
 * directive" guard is needed — and such a guard would wrongly block round 2.
 */
export function decideAutocritiqueCode(input: AutocritiqueCodeDecisionInput): AutocritiqueCodeDecision {
  if (!input.enabled) return { run: false, reason: "disabled" };
  if (!input.hasUI) return { run: false, reason: "no-ui" };
  if (!input.idle) return { run: false, reason: "not-idle" };
  if (input.roundsUsed >= input.maxRounds) return { run: false, reason: "rounds-exhausted" };
  if (!input.lastStepHasToolCalls) return { run: false, reason: "no-work" };
  return { run: true };
}

export interface AutocritiqueCodePlanInput {
  enabled: boolean;
  hasUI: boolean;
  idle: boolean;
  maxRounds: AutocritiqueCodeRounds;
  /** User-prompt texts from the session branch, oldest first. */
  userPrompts: readonly string[];
  /** The newest work episode performed at least one tool call. */
  lastStepHasToolCalls: boolean;
  /** In-memory counter, the safety net for the persistent marker count. */
  injections: number;
  /** Configured verification/remediation cycles allowed inside the pass. */
  iterations?: AutocritiqueCodeIterations;
  /**
   * When `true` (default), the directive delegates the adversarial QA to a
   * fresh subagent that starts from context 0; the main agent then reconciles
   * its findings and fixes everything real.
   *
   * Set to `false` for inline QA. That keeps the critique in the planner's
   * session and prevents the recursive spawn pattern that occurs with
   * multi-agent extensions (e.g. trimegisto): a delegated QA settles, fires
   * `agent_settled` again, and would otherwise start a new pass that spawns
   * more subagents, ad infinitum.
   */
  recurse?: boolean;
}

export interface AutocritiqueCodePlan {
  inject: boolean;
  /** Round of the pass being injected (0 when nothing is injected). */
  round: number;
  /** Text to inject, present only when `inject` is true. */
  directive?: string;
  /** Next value for the in-memory injection counter. */
  injections: number;
}

/**
 * Pure policy for one agent_settled event: combine the persistent marker count
 * with the in-memory counter, decide, and build the directive. Keeping this
 * effect-free makes the anti-loop arithmetic directly testable.
 */
export function planAutocritiqueCode(input: AutocritiqueCodePlanInput): AutocritiqueCodePlan {
  const roundsUsed = Math.max(
    countTrailingAutocritiqueCodeRounds(input.userPrompts),
    Math.max(0, Math.trunc(input.injections) || 0),
  );

  const decision = decideAutocritiqueCode({
    enabled: input.enabled,
    hasUI: input.hasUI,
    idle: input.idle,
    roundsUsed,
    maxRounds: input.maxRounds,
    lastStepHasToolCalls: input.lastStepHasToolCalls,
  });
  if (!decision.run) {
    return { inject: false, round: 0, injections: Math.max(0, Math.trunc(input.injections) || 0) };
  }

  const round = roundsUsed + 1;
  return {
    inject: true,
    round,
    directive: buildAutocritiqueCodeDirective(
      round,
      input.maxRounds,
      normalizeAutocritiqueCodeIterations(input.iterations),
      input.recurse ?? true,
    ),
    injections: round,
  };
}

function clampRound(round: number, total: number): { round: number; total: number } {
  const safeTotal = normalizeAutocritiqueCodeRounds(total);
  const safeRound = Math.min(Math.max(Math.trunc(round) || 1, 1), safeTotal);
  return { round: safeRound, total: safeTotal };
}

/**
 * Build the injected directive. It is deliberately bounded and scope-aware: the
 * original "loop until 100% clean" idea risks unbounded cost, infinite
 * self-review and architectural scope creep, so this version caps the internal
 * cycles, forbids new requirements, and requires evidence for every claim.
 *
 * `recurse` controls whether the directive tells the agent to delegate the QA
 * to a subagent. The default is `true`: the QA runs in a fresh subagent that
 * starts from context 0, then the main agent reconciles the findings and fixes
 * them. Set `recurse: false` for inline QA — the escape hatch for multi-agent
 * extensions such as trimegisto, where a delegated QA settles, fires
 * `agent_settled` again, and would otherwise start a new pass that spawns more
 * subagents, which is a self-reinforcing recursion.
 */
export function buildAutocritiqueCodeDirective(
  round: number,
  totalRounds: number,
  iterations: number = DEFAULT_AUTOCRITIQUE_CODE_ITERATIONS,
  recurse: boolean = true,
): string {
  const { round: safeRound, total } = clampRound(round, totalRounds);
  const isFinal = safeRound >= total;
  const cycles = normalizeAutocritiqueCodeIterations(iterations);

  const closing = isFinal
    ? `This is the final adversarial pass (${safeRound} of ${total}). Conclude at the end of it and report, even if something remains open, then continue with the next task as instructed in the closing report: the adversarial pass ends here, the work does not.`
    : `This is adversarial pass ${safeRound} of ${total}; ${total - safeRound} further pass(es) will follow after you settle, so fix everything you can now.`;

  const delegation = recurse
    ? "Delegate this adversarial QA to a fresh subagent that starts from context 0: it must not inherit this conversation's reasoning, assumptions or conclusions — hand it only the change under review, where to look, and the verification commands. Run it with the same model you are running as (the active/main model) whenever your delegation tool can target it (for example a sequential same-model spawn); if the tool only offers fixed per-tier models, use its most capable available tier. In every case, never use the model configured for /critique for this pass, which is reserved for deep critical reviews of any subject. Give the subagent the brief for steps 1–2 (stress and verify) with the cycle cap below; keep steps 3–4 (remediate and re-verify) for yourself. Ask it to attack the change adversarially and to return every finding with the evidence from executed checks, not opinions. The subagent runs only this QA pass: it must not delegate further and must not start an adversarial pass of its own. When it returns, reconcile its findings with your own knowledge of the change, fix everything that is real, and re-run the checks yourself — never accept or dismiss a finding without verifying it by execution."
    : "Do NOT delegate this QA pass to a subagent, parallel process, or task-delegation tool. Run the adversarial exploration inline in this conversation so it stays bounded by the rounds budget already enforced above — delegating it would let it settle in a separate session whose own `agent_settled` would trigger another autocritique pass, spawning further subagents in a self-reinforcing loop. The QA uses the same model you are running as (the active/main model); never use the model configured for /critique, which is reserved for deep critical reviews of any subject.";

  return [
    AUTOCRITIQUE_CODE_MARKER,
    "",
    "Do not present the work as complete yet. You have just finished an implementation; before claiming success, run one adversarial QA pass on it and fix what you find. The QA and its fixes stay inside the task you were given — this is not a new feature request and not a rewrite.",
    "",
    "Assume the change contains hidden regressions, unhandled edge cases, and architectural oversights. Then:",
    "",
    "1. Stress the work from three angles",
    "   - Adversarial / edge cases: null and empty inputs, boundary values, empty collections, oversized payloads, error paths, races, concurrency, retries.",
    "   - UX / DX: error ergonomics, silent failures, workflow friction, configuration clarity.",
    "   - Contract / type integrity: type boundaries, API and schema compliance, state-mutation safety.",
    "2. Verify by execution, not inspection alone. Run the test suites, linters, type checks and the real execution paths you touched, and read the actual output. If coverage for the risky paths is missing or insufficient, write the missing tests and run them.",
    "3. Remediate instead of reporting. For every real issue: fix it, refactor cleanly when warranted, re-run the verification suite, and confirm there is no regression. Keep fixes minimal and inside the original scope.",
    `4. Iterate at most ${cycles} verification/remediation cycle${cycles === 1 ? "" : "s"} inside this pass — one cycle means: stress and verify by execution, fix what you find, then re-run the checks. Stop as soon as the executed checks pass and you cannot construct a failing case for the changed behaviour. Do not chase cosmetic nitpicks and do not expand scope; if something genuinely needs a product decision, record it as residual risk instead of inventing new requirements.`,
    "",
    delegation,
    "",
    closing,
    "",
    "5. Close with a report addressed to the user, written in the language the user is using. It must be the message they see when the QA ends, and it must contain, in this order:",
    "- Achieved: a summary of everything the original task accomplished now that the QA is done — what works, what changed and why — and, since the QA exists to protect exactly that result, which of those points this pass corrected, hardened or confirmed.",
    "- Fixed: bugs/regressions broken, each with the check that now proves it.",
    "- Tests: added or updated, and what they cover.",
    "- Improved: net architectural or UX improvements.",
    "- Residual risk: what remains open and why.",
    ...(isFinal
      ? [
          "- Next steps: the project's logical next steps, in dependency order.",
          "",
          "Then do not stop and do not wait for my confirmation: continue autonomously with the first next step. If there is an active long-term plan (for example a plan_*.md checklist managed by the plan tool), continue with its next pending task instead of a brand-new step. Announce in one line what you are starting next, then start it in the same turn so the original task is never interrupted. Stop only for a genuine blocker that needs a product decision, an irreversible or destructive action, or missing credentials — and say so explicitly when that happens.",
        ]
      : [
          "",
          "Further adversarial pass(es) will follow this one, so do not present next steps yet: the full closing report — including the next steps and the autonomous continuation — belongs to the final pass.",
        ]),
    "",
    "Never claim the work is done without evidence from an executed check.",
  ].join("\n");
}
