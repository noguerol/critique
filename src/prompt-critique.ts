/**
 * Critique — automatic user-prompt critique and questions.
 *
 * This module judges user instructions before the working model receives them.
 * It is intentionally lightweight: a cheap heuristic avoids trivial prompts,
 * then a tool-free model call decides whether there is anything worth showing.
 *
 * It also provides the "questions" feature: after a cheap local gate, a
 * tool-free model call decides whether the user input is genuinely ambiguous
 * in a way that could make the working model guess wrong; when it is, a
 * clarifying widget offers three options (two concrete interpretations + free
 * text). Generic "part vs whole"-style questions are explicitly banned.
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
 * Fast local gate for the Questions feature. Only decides *eligibility*: skip
 * inputs too small or formulaic to ever warrant a question, so we never spend a
 * model call on them. Whether a question is genuinely useful is a semantic
 * judgment left to the model in runQuestionsSuggestion — length alone never
 * triggers a question, and clearly-formed instructions pass through untouched.
 */
export function isAmbiguityCandidate(
  text: string,
  level: QuestionsFrequency,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
  // Never re-ask about an instruction we already clarified.
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

export interface QuestionSuggestion {
  interpretationA: string;
  interpretationB: string;
}

const QUESTIONS_FREQUENCY_GUIDANCE: Record<QuestionsFrequency, string> = {
  essential:
    "Essential only: ask only when a wrong guess would materially derail the work AND the instruction itself offers two explicit, contrasting readings. Otherwise shouldAsk:false — this level is intentionally near-silent.",
  normal:
    "Ask when the instruction offers two plausible contrasting readings and a wrong guess would change what the agent does. Skip anything resolvable from context.",
  verbose:
    "Ask whenever a quick clarification could plausibly help, even mildly. Still never on fully clear instructions.",
};

/**
 * Decision prompt for the Questions feature. A question is only worth showing
 * when the instruction itself leaves two *materially different, concrete*
 * readings. Generic scope flips — "part of the request vs the whole request",
 * "the item just mentioned vs the overall goal" — are explicitly banned at
 * every frequency, as is manufacturing uncertainty when the referent is named
 * in the instruction: that is the class of silly questions this feature exists
 * to never ask.
 */
export const QUESTIONS_SYSTEM_PROMPT = [
  "Judge whether a user instruction to an AI agent needs a clarifying question.",
  "The default is shouldAsk:false — a competent agent resolves most ambiguities from the instruction and the conversation.",
  "Ask ONLY when the instruction itself contains two explicit, contrasting candidate readings (often signalled by 'o', 'or', 'vs', 'solo/solamente', 'también', 'en vez de', 'better', 'alternatively', or a deictic such as 'it/esto/hazlo' whose referent is NOT resolvable from this instruction or the recent conversation), AND acting on one would make the agent do visibly different concrete work than acting on the other.",
  "Never ask when:",
  "- the referent is identifiable from the instruction itself, even when a pronoun appears ('this file has an error ... fix it' names the object), from the recent conversation, or from the workspace;",
  "- the referent can be looked up by the agent in the workspace or conversation: files, code, repo, or the previously discussed request ('fix it', 'this file', 'el código', 'el proyecto', 'lo que hablamos') are resolvable — never ask 'which file/item do you mean';",
  "- the only distinction you could offer is generic or paraphrases the same action: 'one part vs the whole request', 'the mentioned item/task vs the overall goal', 'fix only X vs improve everything', 'the file CI flags vs the file referenced earlier';",
  "- the instruction asks the agent itself to decide or recommend;",
  "- it is an acknowledgement, tiny command, quick correction, or a detailed spec with no fork.",
  "Sensitivity comes from frequency-guidance. Respect it strictly; essential is intentionally near-silent.",
  "If asking, give two CONCISE interpretations (a and b) using contrasting words copied from the instruction, in the instruction's language, ≤12 words each.",
  "JSON only:",
  '{"shouldAsk":true|false,"a":"text","b":"text"}',
].join("\n");

export function buildQuestionsSuggestionPrompt(
  prompt: string,
  level: QuestionsFrequency,
  cwd: string,
): string {
  return [
    `<questions-frequency>${questionsFrequencyLabel(level)}</questions-frequency>`,
    `<frequency-guidance>${QUESTIONS_FREQUENCY_GUIDANCE[level]}</frequency-guidance>`,
    `<project-cwd>${cwd}</project-cwd>`,
    "",
    "Instruction:",
    "<user-instruction>",
    prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}… [truncated]` : prompt,
    "</user-instruction>",
  ].join("\n");
}

function parseQuestionsJson(text: string): {
  shouldAsk: boolean;
  a: string;
  b: string;
} | null {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.match(/\{[\s\S]*\}/)?.[0]].filter(
    (candidate): candidate is string => !!candidate,
  );

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        shouldAsk?: unknown;
        a?: unknown;
        b?: unknown;
      };
      if (parsed.shouldAsk !== true) return { shouldAsk: false, a: "", b: "" };
      const a = typeof parsed.a === "string" ? parsed.a.trim() : "";
      const b = typeof parsed.b === "string" ? parsed.b.trim() : "";
      if (!a || !b) return { shouldAsk: false, a: "", b: "" };
      const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
      if (normalize(a) === normalize(b)) return { shouldAsk: false, a: "", b: "" };
      return { shouldAsk: true, a, b };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const QUESTION_OPTION_STOP_WORDS = new Set(
  [
    "the", "a", "an", "to", "of", "in", "for", "on", "with", "and", "or", "at", "by",
    "from", "que", "de", "la", "el", "en", "del", "lo", "un", "una", "al", "y", "o",
    "se", "por", "para", "como", "es", "su", "los", "las", "this", "that", "these",
    "those", "are", "is", "was", "be", "it", "we", "you", "they", "i", "me", "te",
    "le", "nos", "ha", "he", "han", "ya", "más", "mas", "sin", "sobre", "entre",
    "cada", "todo", "toda", "todos", "todas", "cual", "cuales", "donde", "cuando", "what",
    "which", "where", "when", "there", "here", "all", "only", "solo", "sólo", "también",
  ],
);

/**
 * Guard against hallucinated/generic options: each proposed interpretation must
 * share at least one substantive word with the instruction itself, otherwise it
 * was not restated from the user's wording and should not be shown.
 */
function sharesWordingWithPrompt(option: string, prompt: string): boolean {
  const optionWords = option
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !QUESTION_OPTION_STOP_WORDS.has(word));
  if (optionWords.length === 0) return true; // Cannot judge — do not drop.
  const promptLower = prompt.toLowerCase();
  return optionWords.some((word) => promptLower.includes(word));
}

/**
 * Ask a model whether the user's input is genuinely ambiguous and, when it is,
 * obtain two concrete interpretations to offer. Returns null when there is no
 * worthwhile question, or when the call is aborted or fails — in those cases
 * the user's input always passes through untouched.
 */
export async function runQuestionsSuggestion(
  ctx: ExtensionContext,
  model: Model<any>,
  prompt: string,
  level: QuestionsFrequency,
  signal?: AbortSignal,
): Promise<QuestionSuggestion | null> {
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: buildQuestionsSuggestionPrompt(prompt, level, ctx.cwd),
      },
    ],
    timestamp: Date.now(),
  };

  const response = await ctx.modelRegistry.complete(
    model,
    { systemPrompt: QUESTIONS_SYSTEM_PROMPT, messages: [userMessage] },
    { signal, cacheRetention: "none", sessionId: uuidv7() },
  );

  if (response.stopReason === "aborted") return null;
  if (response.stopReason === "error") {
    throw new Error(
      `Questions model ${model.provider}/${model.id} failed: ${response.errorMessage ?? "unknown error"}`,
    );
  }

  const raw = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const parsed = parseQuestionsJson(raw);
  if (!parsed?.shouldAsk || !parsed.a || !parsed.b) return null;

  const interpretationA = compactOneSentence(parsed.a, 120);
  const interpretationB = compactOneSentence(parsed.b, 120);
  if (!interpretationA || !interpretationB) return null;
  if (!sharesWordingWithPrompt(interpretationA, prompt)) return null;
  if (!sharesWordingWithPrompt(interpretationB, prompt)) return null;

  return { interpretationA, interpretationB };
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
