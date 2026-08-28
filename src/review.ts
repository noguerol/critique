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
  "You are an independent code reviewer. Another agent just performed work in a project session, and your job is to judge whether that work is correct and whether it can be improved.",
  "You have no tools: base your review exclusively on the work step provided below.",
  "",
  "Review for:",
  "1. Correctness — does the work satisfy the user's request? Are there bugs, errors, or gaps?",
  "2. Robustness — edge cases, error handling, security, and failure modes.",
  "3. Maintainability — naming, structure, duplication, readability, and consistency.",
  "4. Efficiency — wasted work, repeated computation, or unnecessarily large changes.",
  "",
  "Be specific and concrete. Reference the actual tool calls and results (files, lines, commands) from the work step. Do not invent issues: if the work is correct, say so and keep suggestions minimal.",
  "If the work step was truncated, note it and review only what is visible.",
  "",
  "Reply using EXACTLY this Markdown structure:",
  "",
  "## Verdict",
  "APPROVED | APPROVED_WITH_SUGGESTIONS | CHANGES_RECOMMENDED",
  "",
  "## Issues",
  "- [severity: critical|major|minor] description",
  "",
  "## Suggestions",
  "- concrete, actionable suggestion",
  "",
  "## Summary",
  "2-4 sentence overall assessment.",
].join("\n");

export function buildReviewPrompt(workText: string, focusNote: string): string {
  const sections: string[] = [];
  sections.push("Review the most recent work performed in this project session.");
  sections.push("");
  sections.push("<work-step>");
  sections.push(workText);
  sections.push("</work-step>");
  if (focusNote) {
    sections.push("");
    sections.push("<focus-note>");
    sections.push(focusNote);
    sections.push("</focus-note>");
    sections.push("Pay special attention to the focus note above, but do not limit your review to it.");
  }
  return sections.join("\n");
}

/**
 * Run the critique model. Returns the review text, or null when aborted.
 */
export async function runCritique(
  ctx: ExtensionContext,
  model: Model,
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
    "[Critique — advisory review of your last work step]",
    "",
    `A separate reviewer model (\`${critiqueModel}\`) reviewed the work you just performed. This feedback is **advisory, not mandatory**: you are the final judge. Apply only the points that genuinely improve the work, and if you disagree with any of them, briefly explain why and continue.`,
    "",
    "--- Review ---",
    "",
    review,
  ].join("\n");
}
