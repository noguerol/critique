/**
 * Tests for autocritique-code pure logic and the work-step helpers it relies
 * on. Run with: npm test
 *   node --experimental-strip-types --test test/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTOCRITIQUE_CODE_INTERNAL_BUDGET,
  AUTOCRITIQUE_CODE_ITERATIONS,
  AUTOCRITIQUE_CODE_MARKER,
  DEFAULT_AUTOCRITIQUE_CODE_ITERATIONS,
  buildAutocritiqueCodeDirective,
  countTrailingAutocritiqueCodeRounds,
  decideAutocritiqueCode,
  isAutocritiqueCodePrompt,
  normalizeAutocritiqueCodeIterations,
  normalizeAutocritiqueCodeRounds,
  planAutocritiqueCode,
  type AutocritiqueCodeDecisionInput,
  type AutocritiqueCodePlanInput,
} from "../src/autocritique-code.ts";

import { extractLatestStep, extractWorkSteps, formatWorkSteps, listUserPrompts } from "../src/work-step.ts";

// --- marker / detection ---------------------------------------------------

test("isAutocritiqueCodePrompt detects the injected directive", () => {
  const directive = buildAutocritiqueCodeDirective(1, 1);
  assert.equal(isAutocritiqueCodePrompt(directive), true);
  assert.equal(isAutocritiqueCodePrompt("fix the bug in src/index.ts"), false);
  assert.equal(isAutocritiqueCodePrompt(""), false);
  assert.equal(isAutocritiqueCodePrompt("mentioning [Autocritique-Code] inline"), false);
});

test("marker is a stable part of the directive", () => {
  assert.ok(buildAutocritiqueCodeDirective(1, 1).startsWith(AUTOCRITIQUE_CODE_MARKER));
});

// --- round counting -------------------------------------------------------

test("countTrailingAutocritiqueCodeRounds counts only trailing passes", () => {
  const d = buildAutocritiqueCodeDirective(1, 3);
  assert.equal(countTrailingAutocritiqueCodeRounds([]), 0);
  assert.equal(countTrailingAutocritiqueCodeRounds(["do the work"]), 0);
  assert.equal(countTrailingAutocritiqueCodeRounds(["do the work", d]), 1);
  assert.equal(countTrailingAutocritiqueCodeRounds(["do the work", d, d]), 2);
  // A genuine turn after a pass resets the count.
  assert.equal(countTrailingAutocritiqueCodeRounds([d, "new request"]), 0);
  assert.equal(countTrailingAutocritiqueCodeRounds([d, "new request", d]), 1);
});

test("countTrailingAutocritiqueCodeRounds tolerates empty/garbage entries", () => {
  const d = buildAutocritiqueCodeDirective(1, 1);
  assert.equal(countTrailingAutocritiqueCodeRounds([d, "   ", d]), 2);
  assert.equal(
    countTrailingAutocritiqueCodeRounds([undefined as unknown as string, d]),
    1,
  );
});

// --- config normalization -------------------------------------------------

test("normalizeAutocritiqueCodeRounds accepts only 1|2|3 and defaults to 1", () => {
  assert.equal(normalizeAutocritiqueCodeRounds(1), 1);
  assert.equal(normalizeAutocritiqueCodeRounds(2), 2);
  assert.equal(normalizeAutocritiqueCodeRounds(3), 3);
  assert.equal(normalizeAutocritiqueCodeRounds(0), 1);
  assert.equal(normalizeAutocritiqueCodeRounds(99), 1);
  assert.equal(normalizeAutocritiqueCodeRounds("3"), 1);
  assert.equal(normalizeAutocritiqueCodeRounds(undefined), 1);
  assert.equal(normalizeAutocritiqueCodeRounds(null), 1);
});

test("normalizeAutocritiqueCodeIterations defaults to 1 and accepts 1..5", () => {
  assert.equal(DEFAULT_AUTOCRITIQUE_CODE_ITERATIONS, 1);
  assert.equal(AUTOCRITIQUE_CODE_INTERNAL_BUDGET, DEFAULT_AUTOCRITIQUE_CODE_ITERATIONS);
  assert.deepEqual(AUTOCRITIQUE_CODE_ITERATIONS, [1, 2, 3, 4, 5]);
  for (const iterations of AUTOCRITIQUE_CODE_ITERATIONS) {
    assert.equal(normalizeAutocritiqueCodeIterations(iterations), iterations);
  }
  assert.equal(normalizeAutocritiqueCodeIterations(0), 1);
  assert.equal(normalizeAutocritiqueCodeIterations(6), 1);
  assert.equal(normalizeAutocritiqueCodeIterations(2.9), 2);
  assert.equal(normalizeAutocritiqueCodeIterations("3"), 1);
  assert.equal(normalizeAutocritiqueCodeIterations(undefined), 1);
  assert.equal(normalizeAutocritiqueCodeIterations(null), 1);
});

// --- decision gate (the loop guard) --------------------------------------

function decisionInput(
  overrides: Partial<AutocritiqueCodeDecisionInput> = {},
): AutocritiqueCodeDecisionInput {
  return {
    enabled: true,
    hasUI: true,
    idle: true,
    roundsUsed: 0,
    maxRounds: 1,
    lastStepHasToolCalls: true,
    ...overrides,
  };
}

test("decideAutocritiqueCode runs only on a genuine, worked turn with budget left", () => {
  assert.deepEqual(decideAutocritiqueCode(decisionInput()), { run: true });
});

test("decideAutocritiqueCode skips with an explicit reason", () => {
  assert.deepEqual(decideAutocritiqueCode(decisionInput({ enabled: false })), {
    run: false,
    reason: "disabled",
  });
  assert.deepEqual(decideAutocritiqueCode(decisionInput({ hasUI: false })), {
    run: false,
    reason: "no-ui",
  });
  assert.deepEqual(decideAutocritiqueCode(decisionInput({ idle: false })), {
    run: false,
    reason: "not-idle",
  });
  assert.deepEqual(decideAutocritiqueCode(decisionInput({ lastStepHasToolCalls: false })), {
    run: false,
    reason: "no-work",
  });
  assert.deepEqual(
    decideAutocritiqueCode(decisionInput({ roundsUsed: 1, maxRounds: 1 })),
    { run: false, reason: "rounds-exhausted" },
  );
});

test("round budget grows with autocritiqueCodeRounds", () => {
  assert.equal(decideAutocritiqueCode(decisionInput({ roundsUsed: 1, maxRounds: 3 })).run, true);
  assert.equal(decideAutocritiqueCode(decisionInput({ roundsUsed: 3, maxRounds: 3 })).run, false);
});

// --- directive content ----------------------------------------------------

test("directive is scope-bounded and evidence-based", () => {
  const directive = buildAutocritiqueCodeDirective(1, 1);
  assert.match(directive, /verification\/remediation cycles?/i);
  assert.match(directive, /one cycle means: stress and verify by execution, fix what you find, then re-run the checks/i);
  assert.match(
    buildAutocritiqueCodeDirective(1, 1),
    /Iterate at most 1 verification\/remediation cycle inside/i,
  );
  assert.match(directive, /stay(s)? inside the task/i);
  assert.match(directive, /same model you are running as/i);
  assert.match(directive, /[Nn]ever use the model configured for \/critique/);
  assert.match(directive, /Never claim the work is done without evidence/i);
  assert.match(directive, /- Fixed:/);
  assert.match(directive, /- Tests:/);
  assert.match(directive, /- Improved:/);
  assert.match(directive, /- Residual risk:/);
});

test("directive defaults to inline (no subagent delegation) to prevent recursion", () => {
  // The default must forbid delegation so a delegated QA cannot spawn a
  // recursive loop with multi-agent extensions (e.g. trimegisto).
  const directive = buildAutocritiqueCodeDirective(1, 1);
  assert.match(directive, /Do NOT delegate this QA pass/i);
  assert.match(directive, /run the adversarial exploration inline/i);
  assert.match(directive, /self-reinforcing loop/i);
  assert.doesNotMatch(directive, /delegate the adversarial exploration to a subagent/i);
});

test("directive allows subagent delegation when recurse=true", () => {
  // Opt-in restores the original behaviour so users who want delegation can
  // still get it, with the explicit caveat that this may recurse with
  // multi-agent extensions.
  const directive = buildAutocritiqueCodeDirective(1, 1, 1, true);
  assert.match(directive, /delegate the adversarial exploration to a subagent/i);
  assert.match(directive, /same model you are running as/i);
  assert.doesNotMatch(directive, /Do NOT delegate this QA pass/i);
  assert.doesNotMatch(directive, /self-reinforcing loop/i);
});

test("buildAutocritiqueCodeDirective treats an undefined recurse as inline (default)", () => {
  // Explicit and implicit defaults must match: callers that don't pass the
  // parameter must get the no-recursion directive.
  const explicit = buildAutocritiqueCodeDirective(1, 1, 1, false);
  const implicit = buildAutocritiqueCodeDirective(1, 1, 1);
  assert.equal(explicit, implicit);
  assert.match(explicit, /Do NOT delegate this QA pass/i);
});

test("final directive requires an achieved summary, next steps and autonomous continuation", () => {
  const directive = buildAutocritiqueCodeDirective(1, 1);
  assert.match(directive, /Close with a report addressed to the user/i);
  assert.match(directive, /- Achieved:/);
  assert.match(directive, /which of those points this pass corrected, hardened or confirmed/i);
  assert.match(directive, /- Next steps:/);
  assert.match(directive, /continue autonomously with the first next step/i);
  assert.match(directive, /do not stop and do not wait for my confirmation/i);
  assert.match(directive, /next pending task instead of a brand-new step/i);
  assert.match(directive, /so the original task is never interrupted/i);
  assert.doesNotMatch(directive, /do not start it/i);
  assert.doesNotMatch(directive, /Want me to continue/i);
  assert.doesNotMatch(directive, /Do not present next steps yet/i);
});

test("intermediate directive defers the next-steps report to the final pass", () => {
  const directive = buildAutocritiqueCodeDirective(1, 2);
  assert.match(directive, /- Achieved:/);
  assert.doesNotMatch(directive, /- Next steps:/);
  assert.match(directive, /do not present next steps yet/i);
  // The autonomous continuation belongs only to the final pass: an intermediate
  // pass must not promise or start it (a dangling reference would let the agent
  // continue prematurely, before the remaining QA passes have run).
  assert.doesNotMatch(directive, /continue autonomously with the first next step/i);
  assert.doesNotMatch(directive, /next pending task instead of a brand-new step/i);
  // The deferral must be its own paragraph, not a Markdown lazy continuation of
  // the "- Residual risk:" bullet.
  assert.match(
    directive,
    /- Residual risk:[^\n]*\n\nFurther adversarial pass\(es\) will follow/,
  );
});

test("directive reflects the configured verification-cycle budget", () => {
  assert.match(buildAutocritiqueCodeDirective(1, 1, 1), /Iterate at most 1 verification\/remediation cycle inside/i);
  assert.match(buildAutocritiqueCodeDirective(1, 1, 3), /Iterate at most 3 verification\/remediation cycles inside/i);
  // Out-of-range input falls back to the default of 1.
  assert.match(buildAutocritiqueCodeDirective(1, 1, 9), /Iterate at most 1 verification\/remediation cycle inside/i);
});

test("directive announces intermediate and final passes distinctly", () => {
  const first = buildAutocritiqueCodeDirective(1, 3);
  assert.match(first, /pass 1 of 3/);
  assert.match(first, /further pass\(es\) will follow/i);
  assert.doesNotMatch(first, /final adversarial pass/i);

  const last = buildAutocritiqueCodeDirective(3, 3);
  assert.match(last, /final adversarial pass \(3 of 3\)/);
  assert.match(last, /Conclude at the end/i);
});

test("directive clamps invalid round/total inputs", () => {
  assert.match(buildAutocritiqueCodeDirective(0, 1), /\(1 of 1\)/);
  assert.match(buildAutocritiqueCodeDirective(-5, 1), /\(1 of 1\)/);
  assert.match(buildAutocritiqueCodeDirective(9, 1), /\(1 of 1\)/);
  assert.match(buildAutocritiqueCodeDirective(5, 3), /final adversarial pass \(3 of 3\)/);
});

// --- orchestration / anti-loop plan ---------------------------------------

function planInput(overrides: Partial<AutocritiqueCodePlanInput> = {}): AutocritiqueCodePlanInput {
  return {
    enabled: true,
    hasUI: true,
    idle: true,
    maxRounds: 1,
    userPrompts: ["implement the feature"],
    lastStepHasToolCalls: true,
    injections: 0,
    ...overrides,
  };
}

test("planAutocritiqueCode injects round 1 and advances the counter", () => {
  const plan = planAutocritiqueCode(planInput());
  assert.equal(plan.inject, true);
  assert.equal(plan.round, 1);
  assert.equal(plan.injections, 1);
  assert.ok(plan.directive && isAutocritiqueCodePrompt(plan.directive));
});

test("planAutocritiqueCode does not re-trigger on its own pass (single round)", () => {
  const first = planAutocritiqueCode(planInput());
  assert.ok(first.directive);
  // Next settle: the directive is now the latest user prompt and the counter is 1.
  const second = planAutocritiqueCode(
    planInput({ userPrompts: ["implement the feature", first.directive], injections: first.injections }),
  );
  assert.equal(second.inject, false);
  assert.equal(second.directive, undefined);
  assert.equal(second.injections, 1);
});

test("planAutocritiqueCode in-memory counter prevents loops even if the marker is lost", () => {
  const plan = planAutocritiqueCode(
    planInput({ userPrompts: ["implement the feature"], injections: 1 }),
  );
  assert.equal(plan.inject, false);
});

test("planAutocritiqueCode honours multiple rounds and stops at the cap", () => {
  const d = buildAutocritiqueCodeDirective(1, 3);
  const round1 = planAutocritiqueCode(planInput({ maxRounds: 3 }));
  assert.equal(round1.round, 1);

  const round2 = planAutocritiqueCode(
    planInput({ maxRounds: 3, userPrompts: ["go", d], injections: round1.injections }),
  );
  assert.equal(round2.inject, true);
  assert.equal(round2.round, 2);
  assert.match(round2.directive ?? "", /pass 2 of 3/);

  const round3 = planAutocritiqueCode(
    planInput({ maxRounds: 3, userPrompts: ["go", d, d], injections: round2.injections }),
  );
  assert.equal(round3.round, 3);
  assert.match(round3.directive ?? "", /final adversarial pass \(3 of 3\)/);

  const capped = planAutocritiqueCode(
    planInput({ maxRounds: 3, userPrompts: ["go", d, d, d], injections: round3.injections }),
  );
  assert.equal(capped.inject, false);
});

test("planAutocritiqueCode forwards the configured iterations to the directive", () => {
  const plan = planAutocritiqueCode(planInput({ iterations: 3 }));
  assert.match(plan.directive ?? "", /Iterate at most 3 verification\/remediation cycles inside/i);

  const fallback = planAutocritiqueCode(planInput({ iterations: 99 as unknown as 3 }));
  assert.match(fallback.directive ?? "", /Iterate at most 1 verification\/remediation cycle inside/i);
});

test("planAutocritiqueCode forwards recurse=false (default) to the directive", () => {
  const plan = planAutocritiqueCode(planInput());
  assert.ok(plan.directive);
  assert.match(plan.directive, /Do NOT delegate this QA pass/i);
  assert.doesNotMatch(plan.directive, /delegate the adversarial exploration to a subagent/i);
});

test("planAutocritiqueCode forwards recurse=true to the directive", () => {
  const plan = planAutocritiqueCode(planInput({ recurse: true }));
  assert.ok(plan.directive);
  assert.match(plan.directive, /delegate the adversarial exploration to a subagent/i);
  assert.doesNotMatch(plan.directive, /Do NOT delegate this QA pass/i);
});

test("planAutocritiqueCode restarts on a genuine user turn", () => {
  const d = buildAutocritiqueCodeDirective(1, 1);
  const plan = planAutocritiqueCode(
    planInput({ userPrompts: ["old work", d, "new request"], injections: 0 }),
  );
  assert.equal(plan.inject, true);
  assert.equal(plan.round, 1);
});

test("planAutocritiqueCode targets the newest directive round, not a stale one", () => {
  const stale = buildAutocritiqueCodeDirective(1, 3);
  const plan = planAutocritiqueCode(
    planInput({ maxRounds: 3, userPrompts: ["go", stale, "new request", stale, stale] }),
  );
  assert.equal(plan.inject, true);
  assert.equal(plan.round, 3);
});

// --- work-step helpers used by the hook -----------------------------------

function branchFrom(entries: Array<{ role: string; content: unknown }>) {
  return entries.map((message) => ({ type: "message", message })) as unknown as Parameters<
    typeof listUserPrompts
  >[0];
}

test("listUserPrompts returns every user prompt, oldest first", () => {
  const branch = branchFrom([
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "working" }] },
    { role: "user", content: "second" },
  ]);
  assert.deepEqual(listUserPrompts(branch), ["first", "second"]);
});

test("extractLatestStep returns the newest episode even when it has no work", () => {
  const branch = branchFrom([
    { role: "user", content: "implement" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "edit", arguments: { path: "a.ts" } }],
    },
    { role: "user", content: "aborted turn" },
  ]);

  const latest = extractLatestStep(branch);
  assert.ok(latest);
  assert.equal(latest.userPrompt, "aborted turn");
  assert.equal(latest.toolCalls.length, 0);

  // The regression this guards against: extractWorkSteps falls back to the
  // older worked episode, which would report tool work for an empty turn.
  assert.equal(extractWorkSteps(branch, 1)[0]?.userPrompt, "implement");
});

test("extractLatestStep treats a text-only answer as no tool work", () => {
  const branch = branchFrom([
    { role: "user", content: "implement" },
    { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: {} }] },
    { role: "user", content: "explain it" },
    { role: "assistant", content: [{ type: "text", text: "It does X." }] },
  ]);
  const latest = extractLatestStep(branch);
  assert.equal(latest?.userPrompt, "explain it");
  assert.equal(latest?.toolCalls.length, 0);
});

test("extractLatestStep returns null when there is no user turn", () => {
  assert.equal(extractLatestStep(branchFrom([])), null);
  assert.equal(
    extractLatestStep(branchFrom([{ role: "assistant", content: [{ type: "text", text: "hi" }] }])),
    null,
  );
});

test("extractWorkSteps still isolates episodes after the autocritique insertion", () => {
  const original = branchFrom([
    { role: "user", content: "implement the thing" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "edit", arguments: { path: "a.ts" } }],
    },
    { role: "user", content: buildAutocritiqueCodeDirective(1, 1) },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "2", name: "bash", arguments: { command: "npm test" } }],
    },
  ]);

  const steps = extractWorkSteps(original, 2);
  assert.equal(steps.length, 2);
  // Steps are newest-first: the QA pass is the newest episode.
  assert.equal(steps[0].toolCalls[0]?.name, "bash");
  assert.ok(isAutocritiqueCodePrompt(steps[0].userPrompt));
  // The genuine turn remains an independent episode before it.
  assert.equal(steps[1].userPrompt, "implement the thing");
  assert.equal(steps[1].toolCalls[0]?.name, "edit");

  const formatted = formatWorkSteps(steps);
  assert.match(formatted, /npm test/);
  assert.match(formatted, /implement the thing/);
});
