/**
 * Critique — a pi extension that reviews the last work step with a separate
 * model and feeds the review back to the working model as advisory feedback.
 *
 * Commands:
 *   /critique                Review the last work step and inject the feedback
 *   /critique <focus>        ... focusing the review on <focus>
 *   /critique N              ... reviewing the last N work steps (max 5)
 *   /critique view [N]       Show the review only, without injecting it
 *   /critique config         Choose the critique model from pi's active models
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  DynamicBorder,
  getMarkdownTheme,
  getSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, SelectItem } from "@earendil-works/pi-tui";
import { Container, Markdown, matchesKey, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

import {
  loadConfig,
  modelLabel,
  pickableModels,
  resolveCritiqueModel,
  saveConfig,
} from "./config.ts";
import { extractWorkSteps, formatWorkSteps } from "./work-step.ts";
import { buildInjectedMessage, runCritique } from "./review.ts";

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
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Running critique...");
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

/** How many models the picker shows at once; it scrolls beyond that. */
const MAX_VISIBLE_MODELS = 10;

/**
 * Paginated model picker (TUI only). Shows at most MAX_VISIBLE_MODELS entries
 * at a time with a scroll indicator; ↑/↓ move, Enter selects, Esc cancels.
 */
function pickModel(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  preselect?: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
    const list = new SelectList(items, MAX_VISIBLE_MODELS, getSelectListTheme(), {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 48,
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
    container.addChild(new Text(theme.fg("dim", "↑/↓ move · Enter select · Esc cancel"), 1, 0));
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
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const mdTheme = getMarkdownTheme();

    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Markdown(markdown, 1, 1, mdTheme));
    container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
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

  const steps = extractWorkSteps(branch, parsed.count);
  if (steps.length === 0) {
    ctx.ui.notify("No work step found — the session has no assistant tool activity to review.", "warning");
    return;
  }
  if (steps.length < parsed.count) {
    ctx.ui.notify(`Only ${steps.length} work step(s) found; reviewing those.`, "info");
  }

  const model = resolveCritiqueModel(ctx, config);
  if (!model) {
    ctx.ui.notify("No critique model available (none with configured auth). Run /critique config to pick one.", "error");
    return;
  }

  if (ctx.model && modelLabel(model) === modelLabel(ctx.model)) {
    ctx.ui.notify("Note: the critique model is the same as the working model. Run /critique config to pick a different one.", "warning");
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

async function handleConfig(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/critique config requires interactive or RPC mode.", "error");
    return;
  }

  const config = loadConfig();
  const models = pickableModels(ctx);

  const currentModel = config.model || "auto (a different model than the working one)";
  ctx.ui.notify(
    `Critique config — model: ${currentModel} | auto-inject: ${config.autoInject ? "on" : "off"}`,
    "info",
  );

  if (models.length === 0) {
    ctx.ui.notify("No models with configured auth are available to pick.", "error");
    return;
  }

  const items: SelectItem[] = [
    {
      value: "",
      label: "Auto",
      description: "Different model than the working one (fallback: current model)",
    },
    ...models.map((model) => ({
      value: modelLabel(model),
      label: model.name,
      description: `${model.provider}/${model.id}`,
    })),
  ];

  let modelChoice: string | undefined;
  if (ctx.mode === "tui") {
    modelChoice = await pickModel(ctx, "Critique model", items, config.model);
    if (modelChoice === undefined) {
      ctx.ui.notify("Config cancelled.", "info");
      return;
    }
  } else {
    // RPC mode: ctx.ui.custom() is unavailable, fall back to the built-in select.
    const choice = await ctx.ui.select(
      "Critique model:",
      items.map((item) => `${item.label} (${item.description})`),
    );
    if (choice === undefined) {
      ctx.ui.notify("Config cancelled.", "info");
      return;
    }
    const selected = items.find((item) => `${item.label} (${item.description})` === choice);
    modelChoice = selected?.value ?? "";
  }
  config.model = modelChoice;

  const autoInject = await ctx.ui.confirm(
    "Auto-inject feedback?",
    "Inject the critique review back into the working model automatically? Choose No to only display reviews (/critique view always only displays).",
  );
  config.autoInject = autoInject;

  saveConfig(config);
  ctx.ui.notify(
    `Critique config saved — model: ${config.model || "auto"} | auto-inject: ${config.autoInject ? "on" : "off"}`,
    "info",
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("critique", {
    description:
      "Review the last work step with a separate model and feed the feedback back to the working model",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        { value: "config", label: "config" },
        { value: "view", label: "view" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.mode === "config") {
        await handleConfig(ctx);
        return;
      }
      await runReview(pi, ctx, parsed);
    },
  });
}
