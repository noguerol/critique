/**
 * Critique — automatic user-prompt critique.
 *
 * This module judges user instructions before the working model receives them.
 * It is intentionally lightweight: a cheap heuristic avoids trivial prompts,
 * then a tool-free model call decides whether there is anything worth showing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Message, type Model, uuidv7 } from "@earendil-works/pi-ai";

export type AutoPromptCritiqueLevel = "inconsistencies" | "critical" | "corrosive";
export type AutoPromptCritiqueModelSource = "working" | "critique";

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

const LEVEL_GUIDANCE: Record<AutoPromptCritiqueLevel, string> = {
  inconsistencies: "Only clear contradiction/gap/dangerous ambiguity. Skip merely broad/imperfect prompts.",
  critical: "Challenge assumptions, criteria, scope, priority, risk.",
  corrosive: "Blunt/adversarial. Expose weak logic, trade-offs, overreach, vagueness, self-defeat.",
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

/** Fast local gate: avoid paying a model call for acknowledgements and tiny commands. */
export function isPromptCritiqueCandidate(text: string, hasImages = false): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
  if (trimmed.includes("[Critique accepted by the user]") || trimmed.includes("[User reply to Critique]")) {
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

  if (hasImages && charCount >= 60 && wordCount >= 8) return true;
  if (trimmed.includes("\n") && charCount >= 120 && wordCount >= 12) return true;
  return charCount >= 55 && wordCount >= 9;
}

export const AUTO_PROMPT_CRITIQUE_SYSTEM_PROMPT = [
  "Critique user instructions before an AI coding agent runs.",
  "Skip: ack, tiny cmd, simple correction, too-small prompt.",
  "Show only if advice materially improves prompt / lowers risk / exposes flaw.",
  "User language. 1 sentence. ≤20 words. ≤160 chars.",
  "Only top issue. No preamble/bullets/list/hedging.",
  "JSON only:",
  '{"shouldCritique":true|false,"critique":"text|"}',
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

function parseCritiqueJson(text: string): { shouldCritique: boolean; critique: string } | null {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.match(/\{[\s\S]*\}/)?.[0]].filter(
    (candidate): candidate is string => !!candidate,
  );

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { shouldCritique?: unknown; critique?: unknown };
      const critique = typeof parsed.critique === "string" ? parsed.critique.trim() : "";
      return { shouldCritique: parsed.shouldCritique === true, critique };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function compactCritique(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").replace(/^[-*•]\s*/, "").trim();
  const firstSentence = oneLine.split(/(?<=[.!?。！？])\s+/u)[0]?.trim() ?? oneLine;
  if (firstSentence.length <= MAX_CRITIQUE_CHARS) return firstSentence;

  const clipped = firstSentence.slice(0, MAX_CRITIQUE_CHARS - 1);
  const boundary = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf(";"), clipped.lastIndexOf(","));
  return `${(boundary > 80 ? clipped.slice(0, boundary) : clipped).trim()}…`;
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
): Promise<string | null> {
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
  if (!parsed?.shouldCritique || !parsed.critique) return null;

  return compactCritique(parsed.critique);
}

export function buildAcceptedPromptCritiqueMessage(originalPrompt: string, critique: string): string {
  return [
    originalPrompt,
    "",
    "[Critique accepted by the user]",
    "Before acting, account for this short critique of the instruction:",
    critique,
  ].join("\n");
}

export function buildPromptCritiqueReplyMessage(
  originalPrompt: string,
  critique: string,
  reply: string,
): string {
  return [
    originalPrompt,
    "",
    "[User reply to Critique]",
    "A short critique was shown before this instruction:",
    critique,
    "",
    "The user's reply/clarification:",
    reply.trim(),
  ].join("\n");
}
