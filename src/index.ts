/**
 * Critique — a pi extension that questions the last work step with a separate
 * model and feeds the review back to the working model as advisory feedback.
 *
 * Commands:
 *   /critique                Question the last work step and inject feedback
 *   /critique <focus>        ... focusing the review on <focus>
 *   /critique N              ... reviewing the last N work steps (max 5)
 *   /critique view [N]       Show the review only, without injecting it
 *   /critique config         Configure review and automatic prompt critique
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, SelectItem } from "@earendil-works/pi-tui";

import {
  loadConfig,
  modelLabel,
  pickableModels,
  resolveAutoPromptCritiqueModel,
  resolveCritiqueModel,
  saveConfig,
} from "./config.ts";

import {
  isPromptCritiqueCandidate,
  runAutoPromptCritique,
  runQuestionsSuggestion,
  isAmbiguityCandidate,
  buildAcceptedPromptCritiqueMessage,
  buildPromptCritiqueReplyMessage,
  buildQuestionsMessage,
  questionsFrequencyLabel,
  type QuestionSuggestion,
  type QuestionsFrequency,
} from "./prompt-critique.ts";

import {
  AUTOCRITIQUE_CODE_ITERATIONS,
  AUTOCRITIQUE_CODE_ROUNDS,
  normalizeAutocritiqueCodeIterations,
  normalizeAutocritiqueCodeRounds,
  planAutocritiqueCode,
} from "./autocritique-code.ts";

type Mode = "config" | "review" | "view";

interface ParsedArgs {
  mode: Mode;
  count: number;
  focus: string;
}

function parseArgs(raw: string): ParsedArgs {
  const trimmed = raw.trim();
  let mode: Mode = "review";
  let rest = trimmed;

  const first = rest.split(/\s+/)[0];
  if (first === "config") return { mode: "config", count: 1, focus: "" };
  if (first === "view") {
    mode = "view";
    rest = rest.slice("view".length).trim();
  }

  let count = 1;
  const countMatch = rest.match(/^(\d+)(?:\s+(.*))?$/);
  if (countMatch) {
    count = Math.min(5, Math.max(1, parseInt(countMatch[1], 10)));
    rest = (countMatch[2] ?? "").trim();
  }

  return { mode, count, focus: rest };
}

/** Run the review task with a cancelable loader in TUI mode. */
async function runWithLoader(
  ctx: ExtensionCommandContext,
  task: (signal: AbortSignal | undefined) => Promise<string | null>,
): Promise<string | null> {
  if (ctx.mode !== "tui") {
    try {
      return await task(undefined);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return null;
    }
  }
  return ctx.ui.custom<string | null>(async (tui, theme, _kb, done) => {
    const { BorderedLoader } = await import("@earendil-works/pi-coding-agent");
    const loader = new BorderedLoader(tui, theme, "Critiquing…");
    loader.onAbort = () => done(null);
    task(loader.signal)
      .then((result) => done(result))
      .catch((error) => {
        console.error("[critique] review failed:", error);
        done(null);
      });
    return loader;
  });
}

type AutoPromptCritiqueLevel = ReturnType<typeof loadConfig>["autoPromptCritiqueLevel"];
type AutoPromptCritiqueModelSource = ReturnType<typeof loadConfig>["autoPromptCritiqueModel"];
type AutocritiqueCodeRounds = ReturnType<typeof loadConfig>["autocritiqueCodeRounds"];
type PromptCritiqueAction = "accept" | "discard" | "reply";
type QuestionAction = "a" | "b" | "c" | "dismiss";

/**
 * In-memory safety net for the agent_settled injection loop. The marker stored
 * in the session branch is authoritative (it survives reloads); this counter
 * catches any marker-detection miss. Reset on every genuine user turn.
 */
let autocritiqueCodeInjections = 0;

const MAX_VISIBLE_MODELS = 10;
const PROMPT_CRITIQUE_TIMEOUT_MS = 30_000;
const QUESTIONS_TIMEOUT_MS = 30_000;

function autoPromptCritiqueLevelLabel(level: AutoPromptCritiqueLevel): string {
  return level === "inconsistencies" ? "Inconsistencies" : level === "critical" ? "Critical" : "Corrosive";
}

function autoPromptCritiqueModelSourceLabel(source: AutoPromptCritiqueModelSource): string {
  return source === "working" ? "Working" : "Critique";
}

function updateCritiqueStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const config = loadConfig();
  const parts: string[] = [];
  if (config.autoPromptCritique) {
    parts.push("🧠 c:on");
  }
  if (config.questions) {
    parts.push("❓ q:on");
  }
  if (config.autocritiqueCode) {
    parts.push("🛡 acode:on");
  }
  ctx.ui.setStatus("critique", parts.length > 0 ? parts.join(" ") : "🧠 c:off");
}

/**
 * Paginated model picker (TUI only). Shows at most MAX_VISIBLE_MODELS entries
 * at a time with a scroll indicator; ↑/↓ move, Enter selects, Esc cancels.
 */
async function pickModel(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  preselect?: string,
): Promise<string | undefined> {
  const [{ DynamicBorder, getSelectListTheme }, { Container, SelectList, Spacer, Text }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-tui"),
  ]);

  return ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
    const list = new SelectList(items, MAX_VISIBLE_MODELS, getSelectListTheme(), {
      minPrimaryColumnWidth: 18,
      maxPrimaryColumnWidth: 42,
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    if (preselect) {
      const index = items.findIndex((item) => item.value === preselect);
      if (index >= 0) list.setSelectedIndex(index);
    }

    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text(theme.fg("dim", "↑↓ move · Enter · Esc"), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    container.addChild(new Spacer(1));
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput(data),
    };
  });
}

/** Show the review in a scrollable markdown viewer (TUI only). */
async function showMarkdown(ctx: ExtensionCommandContext, title: string, markdown: string): Promise<void> {
  const [{ DynamicBorder, getMarkdownTheme }, { Container, Markdown, Text, matchesKey }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-tui"),
  ]);

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const mdTheme = getMarkdownTheme();

    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Markdown(markdown, 1, 1, mdTheme));
    container.addChild(new Text(theme.fg("dim", "Enter/Esc close"), 1, 0));
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
          done(undefined);
        }
      },
    };
  });
}

function formatRemaining(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else {
      lines.push(clip(line, width));
      line = word;
    }
  }
  if (line) lines.push(clip(line, width));
  return lines.length > 0 ? lines : [""];
}

function frameLine(text: string, width: number, color: (s: string) => string): string {
  const innerWidth = Math.max(10, width - 4);
  const clipped = clip(text, innerWidth);
  return color("│ ") + clipped + " ".repeat(Math.max(0, innerWidth - clipped.length)) + color(" │");
}

function frameBorder(width: number, left: string, right: string, label: string, color: (s: string) => string): string {
  const innerWidth = Math.max(10, width - 2);
  const safeLabel = clip(label, Math.max(0, innerWidth - 1));
  return color(left + safeLabel + "─".repeat(Math.max(0, innerWidth - safeLabel.length)) + right);
}

interface PromptCritiqueAdvice {
  critique: string;
  solution: string;
}

async function showPromptCritiqueWidget(
  ctx: ExtensionContext,
  advice: PromptCritiqueAdvice,
): Promise<PromptCritiqueAction> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`Critique: ${advice.critique}\nFix: ${advice.solution}`, "warning");
    const choice = await ctx.ui.select(
      "Critique (auto-discards in 30s)",
      ["Accept", "Discard", "Reply"],
      { timeout: PROMPT_CRITIQUE_TIMEOUT_MS },
    );
    if (choice === "Accept") return "accept";
    if (choice === "Reply") return "reply";
    return "discard";
  }

  const { matchesKey } = await import("@earendil-works/pi-tui");

  return ctx.ui.custom<PromptCritiqueAction>((tui, theme, _kb, done) => {
    const started = Date.now();
    let remaining = PROMPT_CRITIQUE_TIMEOUT_MS;
    let closed = false;

    const finish = (action: PromptCritiqueAction) => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      clearTimeout(timeout);
      done(action);
    };

    const timeout = setTimeout(() => finish("discard"), PROMPT_CRITIQUE_TIMEOUT_MS);
    const interval = setInterval(() => {
      remaining = PROMPT_CRITIQUE_TIMEOUT_MS - (Date.now() - started);
      tui.requestRender();
    }, 250);

    return {
      render: (width: number) => {
        const actualWidth = Math.max(20, Math.min(width, 100));
        const color = (s: string) => theme.fg("warning", s);
        const lines: string[] = [];
        lines.push(frameBorder(actualWidth, "╭", "╮", ` Critique (${formatRemaining(remaining)}) `, color));
        for (const line of wrapPlain(`Issue: ${advice.critique}`, Math.max(10, actualWidth - 4))) {
          lines.push(frameLine(line, actualWidth, color));
        }
        for (const line of wrapPlain(`Fix: ${advice.solution}`, Math.max(10, actualWidth - 4))) {
          lines.push(frameLine(line, actualWidth, color));
        }
        lines.push(frameLine("", actualWidth, color));
        lines.push(
          frameLine(
            "A accept fix · D/Esc discard · R reply",
            actualWidth,
            color,
          ),
        );
        lines.push(frameBorder(actualWidth, "╰", "╯", "", color));
        return lines;
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (data === "a" || data === "A" || matchesKey(data, "enter")) finish("accept");
        else if (data === "r" || data === "R") finish("reply");
        else if (data === "d" || data === "D" || matchesKey(data, "escape")) finish("discard");
        tui.requestRender();
      },
      dispose: () => {
        clearInterval(interval);
        clearTimeout(timeout);
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "90%", minWidth: 20 } });
}

async function showQuestionsWidget(
  ctx: ExtensionContext,
  interpretationA: string,
  interpretationB: string,
): Promise<QuestionAction> {
  if (ctx.mode !== "tui") {
    const choice = await ctx.ui.select(
      "What did you mean?",
      [
        `A: ${interpretationA}`,
        `B: ${interpretationB}`,
        "C: My own answer",
        "Dismiss (send as-is)",
      ],
      { timeout: QUESTIONS_TIMEOUT_MS },
    );
    if (choice === "A") return "a";
    if (choice === "B") return "b";
    if (choice === "C") return "c";
    return "dismiss";
  }

  const { matchesKey } = await import("@earendil-works/pi-tui");

  return ctx.ui.custom<QuestionAction>((tui, theme, _kb, done) => {
    const started = Date.now();
    let remaining = QUESTIONS_TIMEOUT_MS;
    let closed = false;

    const finish = (action: QuestionAction) => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      clearTimeout(timeout);
      done(action);
    };

    const timeout = setTimeout(() => finish("dismiss"), QUESTIONS_TIMEOUT_MS);
    const interval = setInterval(() => {
      remaining = QUESTIONS_TIMEOUT_MS - (Date.now() - started);
      tui.requestRender();
    }, 250);

    return {
      render: (width: number) => {
        const actualWidth = Math.max(20, Math.min(width, 100));
        const color = (s: string) => theme.fg("accent", s);
        const lines: string[] = [];
        lines.push(frameBorder(actualWidth, "╭", "╮", ` Questions (${formatRemaining(remaining)}) `, color));
        lines.push(frameLine("", actualWidth, color));
        lines.push(frameLine("What did you mean?", actualWidth, color));
        lines.push(frameLine("", actualWidth, color));
        lines.push(frameLine(`A) ${interpretationA}`, actualWidth, color));
        lines.push(frameLine(`B) ${interpretationB}`, actualWidth, color));
        lines.push(frameLine(`C) My own answer`, actualWidth, color));
        lines.push(frameLine("", actualWidth, color));
        lines.push(
          frameLine(
            "A/B/C choice · Esc dismiss",
            actualWidth,
            color,
          ),
        );
        lines.push(frameBorder(actualWidth, "╰", "╯", "", color));
        return lines;
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (data === "a" || data === "A") finish("a");
        else if (data === "b" || data === "B") finish("b");
        else if (data === "c" || data === "C") finish("c"); else if (data === "d" || data === "D" || matchesKey(data, "escape")) {
          finish("dismiss");
        }
        tui.requestRender();
      },
      dispose: () => {
        clearInterval(interval);
        clearTimeout(timeout);
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "90%", minWidth: 20 } });
}

async function handleAutomaticPromptCritique(
  ctx: ExtensionContext,
  text: string,
  images: unknown[] | undefined,
): Promise<string | null> {
  const config = loadConfig();
  if (!config.autoPromptCritique) return null;
  if (!ctx.hasUI) return null;

  if (!isPromptCritiqueCandidate(text, (images?.length ?? 0) > 0, config.autoPromptCritiqueLevel)) return null;

  const model = resolveAutoPromptCritiqueModel(ctx, config);
  if (!model) return null;

  let advice: PromptCritiqueAdvice | null = null;
  try {
    ctx.ui.setStatus("critique-check", "critique: checking prompt…");
    advice = await runAutoPromptCritique(
      ctx,
      model,
      text,
      config.autoPromptCritiqueLevel,
      (images?.length ?? 0) > 0,
      ctx.signal,
    );
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    return null;
  } finally {
    ctx.ui.setStatus("critique-check", undefined);
  }

  if (!advice) return null;

  const action = await showPromptCritiqueWidget(ctx, advice);
  if (action === "accept") {
    return buildAcceptedPromptCritiqueMessage(text, advice.solution);
  }
  if (action === "reply") {
    ctx.ui.notify("Reply/clarify. Empty = discard.", "info");
    const reply = await ctx.ui.editor("Reply to Critique", "");
    if (!reply?.trim()) return null;
    return buildPromptCritiqueReplyMessage(text, advice.critique, advice.solution, reply);
  }
  return null;
}

async function handleQuestions(
  ctx: ExtensionContext,
  text: string,
): Promise<string | null> {
  const config = loadConfig();
  if (!config.questions) return null;
  if (!ctx.hasUI) return null;

  // Cheap local gate first: skip inputs too small or formulaic to ever deserve
  // a question. Whether a question is genuinely useful is judged by the model
  // below — length alone never triggers one.
  if (!isAmbiguityCandidate(text, config.questionsFrequency)) return null;

  const model = resolveAutoPromptCritiqueModel(ctx, config);
  if (!model) return null;

  let suggestion: QuestionSuggestion | null = null;
  try {
    suggestion = await runQuestionsSuggestion(
      ctx,
      model,
      text,
      config.questionsFrequency,
      ctx.signal,
    );
  } catch (error) {
    // Questions are optional: a failing model must never block user input.
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    return null;
  }

  if (!suggestion) return null;

  const action = await showQuestionsWidget(
    ctx,
    suggestion.interpretationA,
    suggestion.interpretationB,
  );
  if (action === "dismiss") return null;

  let customAnswer = "";
  if (action === "c") {
    const reply = await ctx.ui.editor("Your interpretation", "");
    if (!reply?.trim()) return null;
    customAnswer = reply.trim();
  }

  return buildQuestionsMessage(
    text,
    suggestion.interpretationA,
    suggestion.interpretationB,
    action,
    customAnswer,
  );
}

async function runReview(pi: ExtensionAPI, ctx: ExtensionCommandContext, parsed: ParsedArgs): Promise<void> {
  const config = loadConfig();

  // Make sure any in-flight agent run has fully settled so the session tree
  // contains the complete work step (resolves immediately when idle).
  await ctx.waitForIdle();

  const branch = ctx.sessionManager.getBranch();
  if (branch.length === 0) {
    ctx.ui.notify("No session content to critique yet.", "warning");
    return;
  }

  const [{ extractWorkSteps, formatWorkSteps }, { buildInjectedMessage, runCritique }] = await Promise.all([
    import("./work-step.ts"),
    import("./review.ts"),
  ]);

  const steps = extractWorkSteps(branch, parsed.count);
  if (steps.length === 0) {
    ctx.ui.notify("No reviewable work step.", "warning");
    return;
  }
  if (steps.length < parsed.count) {
    ctx.ui.notify(`Only ${steps.length} work step(s) found; reviewing those.`, "info");
  }

  const model = resolveCritiqueModel(ctx, config);
  if (!model) {
    ctx.ui.notify("No critique model. Use /critique config.", "error");
    return;
  }

  if (ctx.model && modelLabel(model) === modelLabel(ctx.model)) {
    ctx.ui.notify("Critique model = working model. Use /critique config to change.", "warning");
  }

  const workText = formatWorkSteps(steps);
  const review = await runWithLoader(ctx, (signal) => runCritique(ctx, model, workText, parsed.focus, signal));

  if (review === null) {
    ctx.ui.notify("Critique cancelled.", "info");
    return;
  }
  if (!review) {
    ctx.ui.notify("The critique model returned an empty review.", "warning");
    return;
  }

  const label = modelLabel(model);
  if (parsed.mode === "view" || !config.autoInject) {
    if (ctx.mode === "tui") {
      await showMarkdown(ctx, "Critique review", review);
    } else if (ctx.hasUI) {
      ctx.ui.notify(`Critique (${label}):\n${review.slice(0, 1000)}`, "info");
    } else {
      console.log(`[critique] Review from ${label}:\n${review}`);
    }
    return;
  }

  const injected = buildInjectedMessage(label, review);
  pi.sendUserMessage(injected, { deliverAs: "followUp" });
  ctx.ui.notify(`Critique feedback from ${label} sent back to the working model.`, "info");
}

async function chooseConfigItem(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  preselect?: string,
): Promise<string | undefined> {
  if (ctx.mode === "tui") return pickModel(ctx, title, items, preselect);

  const labels = items.map((item) => `${item.label}${item.description ? ` (${item.description})` : ""}`);
  ctx.ui.setStatus("critique-config", "select a setting to change it");
  const choice = await ctx.ui.select(title, labels);
  if (choice === undefined) return undefined;
  return items.find((item) => `${item.label}${item.description ? ` (${item.description})` : ""}` === choice)?.value;
}

function configSummary(config: ReturnType<typeof loadConfig>): string {
  const promptCritique = config.autoPromptCritique
    ? `${autoPromptCritiqueLevelLabel(config.autoPromptCritiqueLevel)} via ${autoPromptCritiqueModelSourceLabel(config.autoPromptCritiqueModel)}`
    : "off";
  const questions = config.questions
    ? `on (${questionsFrequencyLabel(config.questionsFrequency)})`
    : "off";
  const autocritiqueCode = config.autocritiqueCode
    ? `on (${config.autocritiqueCodeRounds} pass${config.autocritiqueCodeRounds === 1 ? "" : "es"} × ${config.autocritiqueCodeIterations} cycle${config.autocritiqueCodeIterations === 1 ? "" : "s"}, active model${config.autocritiqueCodeRecurse ? "; subagents allowed" : "; inline"})`
    : "off";
  return `model:${config.model || "auto"} | inject:${config.autoInject ? "on" : "off"} | acode:${autocritiqueCode} | prompt:${promptCritique} | questions:${questions}`;
}

function configMenuItems(config: ReturnType<typeof loadConfig>): SelectItem[] {
  return [
    {
      value: "model",
      label: "🧠 Critique model",
      description: `model used to review edits • ${config.model || "auto; prefer non-working"}`,
    },
    {
      value: "autoInject",
      label: "♻️ Auto-inject",
      description: config.autoInject ? "on • inject critiques into the chat" : "off • manual critique only",
    },
    {
      value: "autocritiqueCode",
      label: "🛡️ Autocritique code",
      description: config.autocritiqueCode
        ? `on • ${config.autocritiqueCodeRounds} round${config.autocritiqueCodeRounds === 1 ? "" : "s"} × ${config.autocritiqueCodeIterations} cycle${config.autocritiqueCodeIterations === 1 ? "" : "s"} QA after each turn (active model)`
        : "off • no automatic code QA",
    },
    {
      value: "autocritiqueCodeRounds",
      label: "🔁 Autocritique code rounds",
      description: `${config.autocritiqueCodeRounds} pass${config.autocritiqueCodeRounds === 1 ? "" : "es"} of adversarial QA after each user turn`,
    },
    {
      value: "autocritiqueCodeIterations",
      label: "🔄 Autocritique code iterations",
      description: `${config.autocritiqueCodeIterations} verify/remediate cycle${config.autocritiqueCodeIterations === 1 ? "" : "s"} inside each pass`,
    },
    {
      value: "autocritiqueCodeRecurse",
      label: "🧩 Autocritique code recurse",
      description: config.autocritiqueCodeRecurse
        ? "on • delegate QA to a subagent (may recurse with trimegisto)"
        : "off • inline QA; default — prevents trimegisto recursion",
    },
    {
      value: "autoPromptCritique",
      label: "💬 Prompt critique",
      description: config.autoPromptCritique ? "on • review incoming prompts" : "off • no prompt critique",
    },
    {
      value: "autoPromptCritiqueLevel",
      label: "🎯 Prompt level",
      description: `critique strictness • ${autoPromptCritiqueLevelLabel(config.autoPromptCritiqueLevel)}`,
    },
    {
      value: "autoPromptCritiqueModel",
      label: "🤖 Prompt model",
      description: `source of prompt critique • ${autoPromptCritiqueModelSourceLabel(config.autoPromptCritiqueModel)}`,
    },
    {
      value: "questions",
      label: "❓ Questions",
      description: config.questions ? "on • flag unclear questions" : "off • no question critique",
    },
    {
      value: "questionsFrequency",
      label: "⚠️ Questions frequency",
      description: `how sensitive to unclear questions • ${questionsFrequencyLabel(config.questionsFrequency)}`,
    },
    {
      value: "done",
      label: "✅ Done",
      description: "save changes and close the menu",
    },
  ];
}

async function editCritiqueModel(
  ctx: ExtensionCommandContext,
  config: ReturnType<typeof loadConfig>,
  models: ReturnType<typeof pickableModels>,
): Promise<boolean> {
  if (models.length === 0) {
    ctx.ui.notify("No models with configured auth are available to pick.", "error");
    return false;
  }

  const items: SelectItem[] = [
    {
      value: "",
      label: "Auto",
      description: "prefer non-working; fallback current",
    },
    ...models.map((model) => ({
      value: modelLabel(model),
      label: model.name,
      description: `${model.provider}/${model.id}`,
    })),
  ];

  const modelChoice = await chooseConfigItem(ctx, "Critique model", items, config.model);
  if (modelChoice === undefined) return false;
  config.model = modelChoice;
  return true;
}

async function editPromptCritiqueLevel(
  ctx: ExtensionCommandContext,
  config: ReturnType<typeof loadConfig>,
): Promise<boolean> {
  const levelItems: SelectItem[] = [
    {
      value: "inconsistencies",
      label: autoPromptCritiqueLevelLabel("inconsistencies"),
      description: "low; real mismatch only",
    },
    {
      value: "critical",
      label: autoPromptCritiqueLevelLabel("critical"),
      description: "moderate; real risk",
    },
    {
      value: "corrosive",
      label: autoPromptCritiqueLevelLabel("corrosive"),
      description: "high; skip only if solid",
    },
  ];
  const choice = await chooseConfigItem(
    ctx,
    "Automatic prompt critique level",
    levelItems,
    config.autoPromptCritiqueLevel,
  );
  if (choice === undefined) return false;
  config.autoPromptCritiqueLevel = choice as AutoPromptCritiqueLevel;
  return true;
}

async function editPromptCritiqueModel(
  ctx: ExtensionCommandContext,
  config: ReturnType<typeof loadConfig>,
): Promise<boolean> {
  const sourceItems: SelectItem[] = [
    {
      value: "working",
      label: autoPromptCritiqueModelSourceLabel("working"),
      description: "active model",
    },
    {
      value: "critique",
      label: autoPromptCritiqueModelSourceLabel("critique"),
      description: "configured critic",
    },
  ];
  const choice = await chooseConfigItem(
    ctx,
    "Automatic prompt critique model",
    sourceItems,
    config.autoPromptCritiqueModel,
  );
  if (choice === undefined) return false;
  config.autoPromptCritiqueModel = choice as AutoPromptCritiqueModelSource;
  return true;
}

async function handleConfig(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/critique config requires interactive or RPC mode.", "error");
    return;
  }

  const config = loadConfig();
  const models = pickableModels(ctx);
  let preselect: string | undefined;

  while (true) {
    const choice = await chooseConfigItem(ctx, "Critique config", configMenuItems(config), preselect);
    if (choice === undefined || choice === "done") break;

    preselect = choice;
    let changed = false;
    switch (choice) {
      case "model":
        changed = await editCritiqueModel(ctx, config, models);
        break;
      case "autoInject":
        config.autoInject = !config.autoInject;
        changed = true;
        break;
      case "autocritiqueCode":
        config.autocritiqueCode = !config.autocritiqueCode;
        changed = true;
        break;
      case "autocritiqueCodeRounds":
        changed = await editAutocritiqueCodeRounds(ctx, config);
        break;
      case "autocritiqueCodeIterations":
        changed = await editAutocritiqueCodeIterations(ctx, config);
        break;
      case "autocritiqueCodeRecurse":
        config.autocritiqueCodeRecurse = !config.autocritiqueCodeRecurse;
        changed = true;
        break;
      case "autoPromptCritique":
        config.autoPromptCritique = !config.autoPromptCritique;
        changed = true;
        break;
      case "autoPromptCritiqueLevel":
        changed = await editPromptCritiqueLevel(ctx, config);
        break;
      case "autoPromptCritiqueModel":
        changed = await editPromptCritiqueModel(ctx, config);
        break;
      case "questions":
        config.questions = !config.questions;
        changed = true;
        break;
      case "questionsFrequency":
        changed = await editQuestionsFrequency(ctx, config);
        break;
    }

    if (changed) {
      saveConfig(config);
      updateCritiqueStatus(ctx);
      ctx.ui.notify(`Critique config saved — ${configSummary(config)}`, "info");
    }
  }

  saveConfig(config);
  updateCritiqueStatus(ctx);
  ctx.ui.notify(`Critique config closed — ${configSummary(config)}`, "info");
}

async function editQuestionsFrequency(
  ctx: ExtensionCommandContext,
  config: ReturnType<typeof loadConfig>,
): Promise<boolean> {
  const freqItems: SelectItem[] = [
    {
      value: "essential",
      label: "Essential only",
      description: "only ask when truly necessary",
    },
    {
      value: "normal",
      label: "Normal",
      description: "moderate sensitivity",
    },
    {
      value: "verbose",
      label: "Many questions",
      description: "high sensitivity; ask often",
    },
  ];
  const choice = await chooseConfigItem(
    ctx,
    "Questions frequency",
    freqItems,
    config.questionsFrequency,
  );
  if (choice === undefined) return false;
  config.questionsFrequency = choice as QuestionsFrequency;
  return true;
}

async function editAutocritiqueCodeRounds(
  ctx: ExtensionCommandContext,
  config: ReturnType<typeof loadConfig>,
): Promise<boolean> {
  const roundItems: SelectItem[] = AUTOCRITIQUE_CODE_ROUNDS.map((round) => ({
    value: String(round),
    label: round === 1 ? "1 round" : `${round} rounds`,
    description:
      round === 1
        ? "one adversarial QA pass after each user turn"
        : `${round} sequential QA passes after each user turn`,
  }));
  const choice = await chooseConfigItem(
    ctx,
    "Autocritique code rounds",
    roundItems,
    String(config.autocritiqueCodeRounds),
  );
  if (choice === undefined) return false;
  config.autocritiqueCodeRounds = normalizeAutocritiqueCodeRounds(Number(choice));
  return true;
}

async function editAutocritiqueCodeIterations(
  ctx: ExtensionCommandContext,
  config: ReturnType<typeof loadConfig>,
): Promise<boolean> {
  const iterationItems: SelectItem[] = AUTOCRITIQUE_CODE_ITERATIONS.map((iterations) => ({
    value: String(iterations),
    label:
      iterations === 1
        ? "1 iteration"
        : `${iterations} iterations`,
    description:
      iterations === 1
        ? "single verify/remediate cycle inside the pass (default)"
        : `up to ${iterations} verify/remediate cycles inside the pass`,
  }));
  const choice = await chooseConfigItem(
    ctx,
    "Autocritique code iterations",
    iterationItems,
    String(config.autocritiqueCodeIterations),
  );
  if (choice === undefined) return false;
  config.autocritiqueCodeIterations = normalizeAutocritiqueCodeIterations(Number(choice));
  return true;
}

/**
 * After the working agent fully settles, inject one bounded adversarial QA pass
 * when autocritique-code is enabled. Skipped unless the last episode did real
 * work, so pure chat turns are left alone.
 */
async function maybeAutocritiqueCode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const config = loadConfig();
  if (!config.autocritiqueCode) return;
  if (!ctx.hasUI) return;

  const branch = ctx.sessionManager.getBranch();
  const { listUserPrompts, extractLatestStep } = await import("./work-step.ts");
  const latestStep = extractLatestStep(branch);

  const plan = planAutocritiqueCode({
    enabled: config.autocritiqueCode,
    hasUI: ctx.hasUI,
    idle: ctx.isIdle(),
    maxRounds: config.autocritiqueCodeRounds,
    userPrompts: listUserPrompts(branch),
    lastStepHasToolCalls: (latestStep?.toolCalls.length ?? 0) > 0,
    injections: autocritiqueCodeInjections,
    iterations: config.autocritiqueCodeIterations,
    recurse: config.autocritiqueCodeRecurse,
  });
  autocritiqueCodeInjections = plan.injections;
  if (!plan.inject || !plan.directive) return;

  try {
    pi.sendUserMessage(plan.directive, { deliverAs: "followUp" });
    ctx.ui.notify(
      `Autocritique code: adversarial QA pass ${plan.round}/${config.autocritiqueCodeRounds} injected.`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Autocritique code could not inject the QA pass: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  }
}

async function handleAutocritiqueCodeCommand(
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  // All autocritique-code settings live in the /critique config menu. The
  // shortcuts here are thin conveniences that only toggle the on/off switch;
  // every other parameter (rounds, iterations, recurse) is configured from the
  // menu so a single place manages the whole feature.
  const config = loadConfig();
  const value = arg.trim().toLowerCase();
  if (value === "on" || value === "off") {
    config.autocritiqueCode = value === "on";
    saveConfig(config);
    updateCritiqueStatus(ctx);
    ctx.ui.notify(
      config.autocritiqueCode
        ? "Autocritique code on — tune rounds/iterations/recurse in /critique config."
        : "Autocritique code off — tune it in /critique config.",
      "info",
    );
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("/critique autocritique-code on|off, or use /critique config for full control.", "warning");
    return;
  }

  await handleConfig(ctx);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    updateCritiqueStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await maybeAutocritiqueCode(pi, ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };

    // A genuine user turn resets the autocritique-code budget.
    autocritiqueCodeInjections = 0;

    // First, check if the questions feature wants to ask a clarifying question.
    const questionsTransformed = await handleQuestions(ctx, event.text);
    if (questionsTransformed) {
      return { action: "transform" as const, text: questionsTransformed, images: event.images };
    }

    // Then, check if automatic prompt critique wants to challenge the prompt.
    const transformed = await handleAutomaticPromptCritique(ctx, event.text, event.images);
    if (!transformed) return { action: "continue" as const };
    return { action: "transform" as const, text: transformed, images: event.images };
  });

  pi.registerCommand("critique", {
    description: "Question last work / config",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        { value: "config", label: "config" },
        { value: "view", label: "view" },
        { value: "autocritique-code on", label: "autocritique-code on" },
        { value: "autocritique-code off", label: "autocritique-code off" },
        { value: "autocritique-code iterations 2", label: "autocritique-code iterations 2" },
        { value: "autocritique-code recurse off", label: "autocritique-code recurse off" },
        { value: "autocritique-code recurse on", label: "autocritique-code recurse on" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const autocritiqueMatch = trimmed.match(/^(autocritique-code|autocritique|acode)\b/i);
      if (autocritiqueMatch) {
        await handleAutocritiqueCodeCommand(ctx, trimmed.slice(autocritiqueMatch[0].length));
        return;
      }

      const parsed = parseArgs(args);
      if (parsed.mode === "config") {
        await handleConfig(ctx);
        return;
      }
      await runReview(pi, ctx, parsed);
    },
  });
}
