/**
 * Critique — reviewer prompt and model call.
 *
 * The critique model runs with no tools: it judges the work step purely from
 * the serialized context. Its output is structured Markdown that is then
 * injected back into the working model as advisory feedback.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Message, type Model, uuidv7 } from "@earendil-works/pi-ai";

const MAX_REVIEW_CHARS = 16_000;

export const REVIEWER_SYSTEM_PROMPT = [
  "Independent code reviewer. No tools; judge only given work step.",
  "Check: correctness, robustness/security, maintainability, efficiency.",
  "Concrete refs: files/lines/cmds/tool results. No invented issues. If OK, say OK. If truncated, note limits.",
  "Markdown exactly:",
  "## Verdict",
  "APPROVED | APPROVED_WITH_SUGGESTIONS | CHANGES_RECOMMENDED",
  "## Issues",
  "- [severity: critical|major|minor] description",
  "## Suggestions",
  "- action",
  "## Summary",
  "2-4 sentences.",
].join("\n");

export function buildReviewPrompt(workText: string, focusNote: string): string {
  const sections: string[] = [];
  sections.push("Review latest project work.");
  sections.push("");
  sections.push("<work-step>");
  sections.push(workText);
  sections.push("</work-step>");
  if (focusNote) {
    sections.push("");
    sections.push("<focus-note>");
    sections.push(focusNote);
    sections.push("</focus-note>");
    sections.push("Prioritize focus; still review all.");
  }
  return sections.join("\n");
}

/**
 * Run the critique model. Returns the review text, or null when aborted.
 */
export async function runCritique(
  ctx: ExtensionContext,
  model: Model<any>,
  workText: string,
  focusNote: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: buildReviewPrompt(workText, focusNote) }],
    timestamp: Date.now(),
  };

  const response = await ctx.modelRegistry.complete(
    model,
    { systemPrompt: REVIEWER_SYSTEM_PROMPT, messages: [userMessage] },
    { signal, cacheRetention: "none", sessionId: uuidv7() },
  );

  if (response.stopReason === "aborted") return null;
  if (response.stopReason === "error") {
    throw new Error(`Critique model ${model.provider}/${model.id} failed: ${response.errorMessage ?? "unknown error"}`);
  }

  const review = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  // Cap the review so the injected message stays reasonable.
  return review.length > MAX_REVIEW_CHARS
    ? `${review.slice(0, MAX_REVIEW_CHARS)}… [review truncated]`
    : review;
}

/**
 * Message injected back into the main agent. Shaped as advisory feedback:
 * the working model is the final judge and may accept, partially accept, or
 * reject the critique — the feedback is not a mandatory instruction.
 */
export function buildInjectedMessage(critiqueModel: string, review: string): string {
  return [
    "[Critique — advisory]",
    "",
    `Reviewer: \`${critiqueModel}\`. Advice only: apply useful points; briefly reject bad ones.`,
    "",
    "---",
    "",
    review,
  ].join("\n");
}
