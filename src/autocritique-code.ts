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

/**
 * Marker embedded in the injected directive. It is the persistent half of the
 * loop guard: any user message carrying it is an autocritique-code pass, never
 * a genuine user turn.
 */
export const AUTOCRITIQUE_CODE_MARKER = "[Autocritique-Code — Adversarial QA]";

/** Max verification/remediation cycles the agent should attempt inside one pass. */
export const AUTOCRITIQUE_CODE_INTERNAL_BUDGET = 3;

export const DEFAULT_AUTOCRITIQUE_CODE_ROUNDS: AutocritiqueCodeRounds = 1;

/** Narrow arbitrary config input to a valid round count. */
export function normalizeAutocritiqueCodeRounds(value: unknown): AutocritiqueCodeRounds {
  return value === 2 || value === 3 ? value : DEFAULT_AUTOCRITIQUE_CODE_ROUNDS;
}

/** True when a user message is an injected autocritique-code directive. */
export function isAutocritiqueCodePrompt(text: string): boolean {
  return typeof text === "string" && text.includes(AUTOCRITIQUE_CODE_MARKER);
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
    directive: buildAutocritiqueCodeDirective(round, input.maxRounds),
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
 */
export function buildAutocritiqueCodeDirective(round: number, totalRounds: number): string {
  const { round: safeRound, total } = clampRound(round, totalRounds);
  const isFinal = safeRound >= total;

  const closing = isFinal
    ? `This is the final adversarial pass (${safeRound} of ${total}). Conclude at the end of it and report, even if something remains open.`
    : `This is adversarial pass ${safeRound} of ${total}; ${total - safeRound} further pass(es) will follow after you settle, so fix everything you can now.`;

  return [
    AUTOCRITIQUE_CODE_MARKER,
    "",
    "Do not present the work as complete yet. You have just finished an implementation; before claiming success, run one adversarial QA pass on it and fix what you find. This stays inside the task you were given — it is not a new feature request and not a rewrite.",
    "",
    "Assume the change contains hidden regressions, unhandled edge cases, and architectural oversights. Then:",
    "",
    "1. Stress the work from three angles",
    "   - Adversarial / edge cases: null and empty inputs, boundary values, empty collections, oversized payloads, error paths, races, concurrency, retries.",
    "   - UX / DX: error ergonomics, silent failures, workflow friction, configuration clarity.",
    "   - Contract / type integrity: type boundaries, API and schema compliance, state-mutation safety.",
    "2. Verify by execution, not inspection alone. Run the test suites, linters, type checks and the real execution paths you touched, and read the actual output. If coverage for the risky paths is missing or insufficient, write the missing tests and run them.",
    "3. Remediate instead of reporting. For every real issue: fix it, refactor cleanly when warranted, re-run the verification suite, and confirm there is no regression. Keep fixes minimal and inside the original scope.",
    `4. Iterate at most ${AUTOCRITIQUE_CODE_INTERNAL_BUDGET} verification/remediation cycles inside this pass. Stop as soon as the executed checks pass and you cannot construct a failing case for the changed behaviour. Do not chase cosmetic nitpicks and do not expand scope; if something genuinely needs a product decision, record it as residual risk instead of inventing new requirements.`,
    "",
    "If a parallel subagent tool is available, delegate adversarial exploration of the change to it; otherwise perform the pass yourself. Either way, you are responsible for the fixes.",
    "",
    closing,
    "",
    "Finish with a concise, itemized changelog:",
    "- Fixed: bugs/regressions broken, each with the check that now proves it.",
    "- Tests: added or updated, and what they cover.",
    "- Improved: net architectural or UX improvements.",
    "- Residual risk: what remains open and why.",
    "",
    "Never claim the work is done without evidence from an executed check.",
  ].join("\n");
}
