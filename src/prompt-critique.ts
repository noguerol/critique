/**
 * Critique — automatic user-prompt critique and questions.
 *
 * This module judges user instructions before the working model receives them.
 * It is intentionally lightweight: a cheap heuristic avoids trivial prompts,
 * then a tool-free model call decides whether there is anything worth showing.
 *
 * It also provides the "questions" feature: when user input is ambiguous,
 * a clarifying widget offers three options (two suggestions + free text).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Message, type Model, uuidv7 } from "@earendil-works/pi-ai";

export type AutoPromptCritiqueLevel = "inconsistencies" | "critical" | "corrosive";
export type AutoPromptCritiqueModelSource = "working" | "critique";
export type QuestionsFrequency = "essential" | "normal" | "verbose";

export const AUTO_PROMPT_CRITIQUE_LEVELS: AutoPromptCritiqueLevel[] = [
  "inconsistencies",
  "critical",
  "corrosive",
];

export const AUTO_PROMPT_CRITIQUE_MODEL_SOURCES: AutoPromptCritiqueModelSource[] = [
  "working",
  "critique",
];

export const AUTO_PROMPT_CRITIQUE_TIMEOUT_MS = 30_000;

const MAX_PROMPT_CHARS = 8_000;
const MAX_CRITIQUE_CHARS = 180;
const MAX_SOLUTION_CHARS = 240;

export interface AutoPromptCritiqueAdvice {
  critique: string;
  solution: string;
}

export interface QuestionOption {
  label: string;
  description: string;
  value: string;
}

export interface QuestionResult {
  /** "a", "b", or "c" */
  choice: string;
  /** Free-text answer when choice is "c". */
  customAnswer: string;
}

const LEVEL_GUIDANCE: Record<AutoPromptCritiqueLevel, string> = {
  inconsistencies:
    "Low sensitivity. True contradiction/gap/ambiguity likely to make model misunderstand. Otherwise skip.",
  critical:
    "Moderate sensitivity. Flag meaningful ambiguity, missing criteria, risky assumption, weak priority/scope.",
  corrosive:
    "High sensitivity. Hunt weak logic/inconsistency/vagueness/overreach. Skip only clearly logical+complete prompts.",
};

const QUESTIONS_FREQUENCY_LABELS: Record<QuestionsFrequency, string> = {
  essential: "Essential only",
  normal: "Normal",
  verbose: "Many questions",
};

export function autoPromptCritiqueLevelLabel(level: AutoPromptCritiqueLevel): string {
  switch (level) {
    case "inconsistencies":
      return "Inconsistencies only";
    case "critical":
      return "Critical";
    case "corrosive":
      return "Corrosive";
  }
}

export function autoPromptCritiqueModelSourceLabel(source: AutoPromptCritiqueModelSource): string {
  return source === "working" ? "Working model" : "Critique model";
}

export function questionsFrequencyLabel(freq: QuestionsFrequency): string {
  return QUESTIONS_FREQUENCY_LABELS[freq];
}

/**
 * Fast local gate for the Questions feature: skip inputs that are too small or
 * too formulaic to warrant a question. Mirrors the prompt-critique gate so
 * questions never fire on trivial or clearly-formed instructions, even at the
 * most sensitive frequency.
 */
export function isAmbiguityCandidate(
  text: string,
  level: QuestionsFrequency,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("[Questions answer]")) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const charCount = trimmed.length;

  // Three frequency levels, progressively more willing to ask on short input.
  const thresholds = {
    essential: { minChars: 160, minWords: 22 },
    normal: { minChars: 110, minWords: 15 },
    verbose: { minChars: 60, minWords: 10 },
  };
  const t = thresholds[level];
  if (charCount < t.minChars || wordCount < t.minWords) return false;

  return true;
}

/**
 * Detect whether the user's input is genuinely ambiguous — i.e. it contains a
 * concrete signal that the model would plausibly guess wrong, so a question can
 * change the outcome. Returns a suggested interpretation pair when one is found,
 * or null when the input is clear. Only ambiguous *signals* count; length alone
 * never does.
 */
export function detectAmbiguity(
  text: string,
  hasImages: boolean,
  level: QuestionsFrequency,
): { interpretationA: string; interpretationB: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.includes("[Questions answer]")) return null;

  // Skip trivial/acknowledgement inputs.
  const bareReplies = new Set([
    "ok",
    "okay",
    "yes",
    "no",
    "y",
    "n",
    "thanks",
    "thank you",
    "gracias",
    "vale",
    "sí",
    "si",
    "sigue",
    "continua",
    "continúa",
    "continue",
    "stop",
    "para",
    "no hagas eso",
  ]);
  if (bareReplies.has(trimmed.toLowerCase())) return null;

  const words = trimmed.split(/\s+/).filter(Boolean);

  // Heuristic ambiguity signals. A question is only worth asking when one of
  // these appears, because then the model has to guess the referent/scope and
  // could reasonably guess wrong.
  const signals: { pattern: RegExp; interpretationA: string; interpretationB: string }[] = [
    // Vague imperative with a pronoun object and no explicit target in the same
    // message ("fix it", "improve this", "refactor that", "make it better").
    { pattern: /\b(fix|improve|change|adjust|modify|refactor|clean|rework|optimize|redesign|update|rewrite|solve)\b[^.]*\b(it|this|that|them|those|one)\b/, interpretationA: "Apply the standard/obvious fix to the most recent item", interpretationB: "Improve overall quality, not just the flagged item" },
    // Scope-ambiguous request ("handle this", "do that", "address it").
    { pattern: /\b(handle|deal with|address|take care of|manage)\b[^.]*\b(it|this|that|them|those)\b/, interpretationA: "Focus on the primary/most obvious aspect", interpretationB: "Cover all aspects comprehensively" },
    // Cross-message pronoun ("it", "this", "that", "them") with no local referent
    // in the same message — the referent must come from prior context.
    { pattern: /\b(it|this|that|them|those|these|anything|something)\b/, interpretationA: "The most recently mentioned item/task", interpretationB: "The overall goal or full scope" },
    // Missing concrete criteria ("something", "some", "a few", "several") where the
    // model must guess quantity/type.
    { pattern: /\b(some|several|a few|many|lots of|various|multiple)\b[^.]*\b(items|things|parts|files|features|tests|steps|points)\b/, interpretationA: "Use a small, obvious default set", interpretationB: "Cover the full range" },
  ];

  for (const signal of signals) {
    if (signal.pattern.test(trimmed)) {
      return { interpretationA: signal.interpretationA, interpretationB: signal.interpretationB };
    }
  }

  return null;
}

/** Fast local gate: avoid paying a model call for acknowledgements and tiny commands. */
export function isPromptCritiqueCandidate(
  text: string,
  hasImages = false,
  level: AutoPromptCritiqueLevel = "critical",
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
  if (
    trimmed.includes("[Critique accepted by the user]") ||
    trimmed.includes("[Critique solution accepted by the user]") ||
    trimmed.includes("[User reply to Critique]") ||
    trimmed.includes("[Questions answer]")
  ) {
    return false;
  }

  const normalized = trimmed
    .toLowerCase()
    .replace(/[.!?¡¿,;:()\[\]{}"'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const bareReplies = new Set([
    "ok",
    "okay",
    "yes",
    "no",
    "y",
    "n",
    "thanks",
    "thank you",
    "gracias",
    "vale",
    "sí",
    "si",
    "sigue",
    "continua",
    "continúa",
    "continue",
    "stop",
    "para",
    "no hagas eso",
  ]);
  if (bareReplies.has(normalized)) return false;

  const words = normalized.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const charCount = trimmed.length;

  if (level === "corrosive") {
    if (hasImages && charCount >= 35 && wordCount >= 5) return true;
    if (trimmed.includes("\n") && charCount >= 70 && wordCount >= 8) return true;
    return charCount >= 35 && wordCount >= 6;
  }

  if (level === "inconsistencies") {
    if (hasImages && charCount >= 90 && wordCount >= 12) return true;
    if (trimmed.includes("\n") && charCount >= 160 && wordCount >= 16) return true;
    return charCount >= 90 && wordCount >= 14;
  }

  if (hasImages && charCount >= 60 && wordCount >= 8) return true;
  if (trimmed.includes("\n") && charCount >= 120 && wordCount >= 12) return true;
  return charCount >= 55 && wordCount >= 9;
}

export const AUTO_PROMPT_CRITIQUE_SYSTEM_PROMPT = [
  "Critique user instructions before an AI coding agent runs.",
  "Skip: ack, tiny cmd, simple correction, too-small prompt.",
  "Sensitivity comes from level-guidance. Respect it strictly.",
  "If true, include critique + solution. Solution = concrete prompt adjustment, not task answer. User language. Each 1 sentence.",
  "Critique ≤20w/160c. Solution ≤30w/220c. Only top issue + fix. No preamble/bullets/list/hedging.",
  "JSON only:",
  '{"shouldCritique":true|false,"critique":"text|","solution":"text|"}',
].join("\n");

export function buildAutoPromptCritiquePrompt(
  prompt: string,
  level: AutoPromptCritiqueLevel,
  cwd: string,
  hasImages: boolean,
): string {
  return [
    `<critique-level>${autoPromptCritiqueLevelLabel(level)}</critique-level>`,
    `<level-guidance>${LEVEL_GUIDANCE[level]}</level-guidance>`,
    `<project-cwd>${cwd}</project-cwd>`,
    `<has-attached-images>${hasImages ? "yes" : "no"}</has-attached-images>`,
    "",
    "Instruction:",
    "<user-instruction>",
    prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}… [truncated]` : prompt,
    "</user-instruction>",
  ].join("\n");
}

function parseCritiqueJson(
  text: string,
): { shouldCritique: boolean; critique: string; solution: string } | null {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.match(/\{[\s\S]*\}/)?.[0]].filter(
    (candidate): candidate is string => !!candidate,
  );

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        shouldCritique?: unknown;
        critique?: unknown;
        solution?: unknown;
      };
      return {
        shouldCritique: parsed.shouldCritique === true,
        critique: typeof parsed.critique === "string" ? parsed.critique.trim() : "",
        solution: typeof parsed.solution === "string" ? parsed.solution.trim() : "",
      };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function compactOneSentence(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").replace(/^[-*•]\s*/, "").trim();
  const firstSentence = oneLine.split(/(?<=[.!?。！？])\s+/u)[0]?.trim() ?? oneLine;
  if (firstSentence.length <= max) return firstSentence;

  const clipped = firstSentence.slice(0, max - 1);
  const boundary = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf(";"), clipped.lastIndexOf(","));
  return `${(boundary > Math.floor(max * 0.45) ? clipped.slice(0, boundary) : clipped).trim()}…`;
}

/**
 * Ask a model whether the user's prompt should be challenged. Returns null when
 * there is no useful critique, or when the call is aborted.
 */
export async function runAutoPromptCritique(
  ctx: ExtensionContext,
  model: Model<any>,
  prompt: string,
  level: AutoPromptCritiqueLevel,
  hasImages: boolean,
  signal?: AbortSignal,
): Promise<AutoPromptCritiqueAdvice | null> {
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: buildAutoPromptCritiquePrompt(prompt, level, ctx.cwd, hasImages),
      },
    ],
    timestamp: Date.now(),
  };

  const response = await ctx.modelRegistry.complete(
    model,
    { systemPrompt: AUTO_PROMPT_CRITIQUE_SYSTEM_PROMPT, messages: [userMessage] },
    { signal, cacheRetention: "none", sessionId: uuidv7() },
  );

  if (response.stopReason === "aborted") return null;
  if (response.stopReason === "error") {
    throw new Error(
      `Automatic prompt critique model ${model.provider}/${model.id} failed: ${response.errorMessage ?? "unknown error"}`,
    );
  }

  const raw = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const parsed = parseCritiqueJson(raw);
  if (!parsed?.shouldCritique || !parsed.critique || !parsed.solution) return null;

  return {
    critique: compactOneSentence(parsed.critique, MAX_CRITIQUE_CHARS),
    solution: compactOneSentence(parsed.solution, MAX_SOLUTION_CHARS),
  };
}

export function buildAcceptedPromptCritiqueMessage(originalPrompt: string, solution: string): string {
  return [
    originalPrompt,
    "",
    "[Critique solution accepted by the user]",
    "Apply this pre-flight adjustment before acting:",
    solution,
  ].join("\n");
}

export function buildPromptCritiqueReplyMessage(
  originalPrompt: string,
  critique: string,
  solution: string,
  reply: string,
): string {
  return [
    originalPrompt,
    "",
    "[User reply to Critique]",
    "Critique shown:",
    critique,
    "",
    "Suggested fix:",
    solution,
    "",
    "User reply/clarification:",
    reply.trim(),
  ].join("\n");
}

export function buildQuestionsMessage(
  originalPrompt: string,
  interpretationA: string,
  interpretationB: string,
  choice: string,
  customAnswer: string,
): string {
  const base = [
    originalPrompt,
    "",
    "[Questions answer]",
    `What the user meant:`,
  ];

  if (choice === "a") {
    base.push(`Interpretation A: ${interpretationA}`);
  } else if (choice === "b") {
    base.push(`Interpretation B: ${interpretationB}`);
  } else if (choice === "c") {
    base.push(`User's own interpretation: ${customAnswer.trim()}`);
  }

  return base.join("\n");
}
