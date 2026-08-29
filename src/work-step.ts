/**
 * Critique — work-step extraction.
 *
 * A "work step" is an episode: everything the agent did in response to the
 * latest user request — all assistant messages, tool calls, and tool results
 * up to the next user message. The last work step is the last episode that
 * contains actual work (tool calls or assistant output).
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface WorkStepToolCall {
  id: string;
  name: string;
  args: string;
}

export interface WorkStepToolResult {
  callId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export interface WorkStep {
  userPrompt: string;
  assistantText: string;
  toolCalls: WorkStepToolCall[];
  toolResults: WorkStepToolResult[];
  modelLabel: string | undefined;
  /** True when the episode contains tool calls or assistant text. */
  hasWork: boolean;
}

const MAX_USER_PROMPT = 12_000;
const MAX_ASSISTANT_TEXT = 8_000;
const MAX_TOOL_ARGS = 4_000;
const MAX_TOOL_RESULT = 8_000;
const MAX_TOTAL = 60_000;

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated]`;
}

/** Permissive view of an AgentMessage so extraction survives schema drift. */
interface LooseMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  provider?: string;
  model?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => !!block && typeof block === "object");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  return contentBlocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function toolCallsOf(content: unknown): WorkStepToolCall[] {
  return contentBlocks(content)
    .filter((block) => block.type === "toolCall" && typeof block.name === "string")
    .map((block) => ({
      id: block.id ?? "",
      name: block.name as string,
      args: JSON.stringify(block.arguments ?? {}),
    }));
}

function messageOf(entry: SessionEntry): LooseMessage {
  return (entry as { message: unknown }).message as LooseMessage;
}

function isUserEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && messageOf(entry).role === "user";
}

/**
 * Extract the most recent work steps from a session branch (root → leaf).
 * Returns up to `count` steps, newest last. Episodes without work (e.g. a
 * bare "/critique" prompt) are skipped.
 */
export function extractWorkSteps(branch: SessionEntry[], count: number): WorkStep[] {
  // Split the branch into episodes at user-message boundaries.
  const boundaries: number[] = [];
  for (let i = 0; i < branch.length; i++) {
    if (isUserEntry(branch[i])) boundaries.push(i);
  }
  boundaries.push(branch.length);

  const steps: WorkStep[] = [];
  for (let k = boundaries.length - 2; k >= 0 && steps.length < count; k--) {
    const start = boundaries[k];
    const end = boundaries[k + 1];
    const step = buildStep(branch, start, end);
    if (step.hasWork) steps.push(step);
  }
  return steps;
}

function buildStep(branch: SessionEntry[], start: number, end: number): WorkStep {
  const userPrompt = contentText(messageOf(branch[start]).content);
  const toolCalls: WorkStepToolCall[] = [];
  const toolResults: WorkStepToolResult[] = [];
  const textParts: string[] = [];
  let modelLabel: string | undefined;

  for (let i = start + 1; i < end; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const message = messageOf(entry);

    if (message.role === "assistant") {
      toolCalls.push(...toolCallsOf(message.content));
      const text = contentText(message.content);
      if (text) textParts.push(text);
      if (message.provider && message.model) {
        modelLabel = `${message.provider}/${message.model}`;
      } else if (message.model) {
        modelLabel = message.model;
      }
    } else if (message.role === "toolResult") {
      const content = contentText(message.content);
      if (message.toolCallId && (content.length > 0 || message.isError)) {
        toolResults.push({
          callId: message.toolCallId,
          toolName: message.toolName ?? "tool",
          content,
          isError: !!message.isError,
        });
      }
    }
  }

  const hasWork = toolCalls.length > 0 || textParts.length > 0;
  return {
    userPrompt,
    assistantText: textParts.join("\n\n"),
    toolCalls,
    toolResults,
    modelLabel,
    hasWork,
  };
}

/** Render work steps as a self-contained text block for the reviewer model. */
export function formatWorkSteps(steps: WorkStep[]): string {
  const sections = steps.map((step, index) => {
    const position = steps.length - index;
    const lines: string[] = [];
    lines.push(`### Step ${position}${step.modelLabel ? ` (${step.modelLabel})` : ""}`);

    if (step.userPrompt) {
      lines.push(`\n**User:**\n${truncateText(step.userPrompt, MAX_USER_PROMPT)}`);
    }
    if (step.assistantText) {
      lines.push(`\n**Assistant:**\n${truncateText(step.assistantText, MAX_ASSISTANT_TEXT)}`);
    }
    if (step.toolCalls.length > 0) {
      lines.push(`\n**Calls:**`);
      for (const call of step.toolCalls) {
        lines.push(`- \`${call.name}(${truncateText(call.args, MAX_TOOL_ARGS)})\``);
      }
    }
    if (step.toolResults.length > 0) {
      lines.push(`\n**Results:**`);
      for (const result of step.toolResults) {
        const flag = result.isError ? " (ERROR)" : "";
        lines.push(`- \`${result.toolName}\`${flag}:`);
        const body = truncateText(result.content, MAX_TOOL_RESULT);
        for (const line of body.split("\n")) {
          lines.push(`  ${line}`);
        }
      }
    }
    return lines.join("\n");
  });

  let output = sections.join("\n\n---\n\n");
  if (output.length > MAX_TOTAL) {
    output = `${output.slice(0, MAX_TOTAL)}… [work step truncated]`;
  }
  return output;
}
