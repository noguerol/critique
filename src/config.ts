/**
 * Critique — configuration.
 *
 * The critique config is a small JSON file in the pi user directory
 * (getAgentDir()/critique.json), shared across projects.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  AutoPromptCritiqueLevel,
  AutoPromptCritiqueModelSource,
} from "./prompt-critique.ts";
import { normalizeAutocritiqueCodeIterations, normalizeAutocritiqueCodeRounds, type AutocritiqueCodeIterations, type AutocritiqueCodeRounds } from "./autocritique-code.ts";

export type QuestionsFrequency = "essential" | "normal" | "verbose";

export interface CritiqueConfig {
  /** Canonical "provider/modelId" of the critique model. Empty string = auto. */
  model: string;
  /** Inject the review back into the working model automatically. */
  autoInject: boolean;
  /** Challenge sufficiently rich user instructions before the agent starts. */
  autoPromptCritique: boolean;
  /** How adversarial the automatic prompt critique should be. */
  autoPromptCritiqueLevel: AutoPromptCritiqueLevel;
  /** Which model is used for automatic prompt critique. */
  autoPromptCritiqueModel: AutoPromptCritiqueModelSource;
  /** Ask clarifying questions when user input is ambiguous. */
  questions: boolean;
  /** Sensitivity level for the questions feature. */
  questionsFrequency: QuestionsFrequency;
  /** Run an adversarial QA pass on the work once the agent settles. */
  autocritiqueCode: boolean;
  /** How many adversarial QA passes may follow a single user turn. */
  autocritiqueCodeRounds: AutocritiqueCodeRounds;
  /** Max verification/remediation cycles allowed inside one QA pass. */
  autocritiqueCodeIterations: AutocritiqueCodeIterations;
}

export const DEFAULT_CONFIG: CritiqueConfig = {
  model: "",
  autoInject: true,
  autoPromptCritique: false,
  autoPromptCritiqueLevel: "inconsistencies",
  autoPromptCritiqueModel: "working",
  questions: false,
  questionsFrequency: "normal",
  autocritiqueCode: false,
  autocritiqueCodeRounds: 1,
  autocritiqueCodeIterations: 1,
};

export function configFilePath(): string {
  return join(getAgentDir(), "critique.json");
}

export function loadConfig(): CritiqueConfig {
  try {
    const raw = JSON.parse(readFileSync(configFilePath(), "utf8")) as Partial<CritiqueConfig>;
    const level = raw.autoPromptCritiqueLevel;
    const modelSource = raw.autoPromptCritiqueModel;
    const frequency = raw.questionsFrequency;
    return {
      model: typeof raw.model === "string" ? raw.model : DEFAULT_CONFIG.model,
      autoInject:
        typeof raw.autoInject === "boolean" ? raw.autoInject : DEFAULT_CONFIG.autoInject,
      autoPromptCritique:
        typeof raw.autoPromptCritique === "boolean"
          ? raw.autoPromptCritique
          : DEFAULT_CONFIG.autoPromptCritique,
      autoPromptCritiqueLevel:
        level === "inconsistencies" || level === "critical" || level === "corrosive"
          ? level
          : DEFAULT_CONFIG.autoPromptCritiqueLevel,
      autoPromptCritiqueModel:
        modelSource === "working" || modelSource === "critique"
          ? modelSource
          : DEFAULT_CONFIG.autoPromptCritiqueModel,
      questions:
        typeof raw.questions === "boolean" ? raw.questions : DEFAULT_CONFIG.questions,
      questionsFrequency:
        frequency === "essential" || frequency === "normal" || frequency === "verbose"
          ? frequency
          : DEFAULT_CONFIG.questionsFrequency,
      autocritiqueCode:
        typeof raw.autocritiqueCode === "boolean"
          ? raw.autocritiqueCode
          : DEFAULT_CONFIG.autocritiqueCode,
      autocritiqueCodeRounds: normalizeAutocritiqueCodeRounds(raw.autocritiqueCodeRounds),
      autocritiqueCodeIterations: normalizeAutocritiqueCodeIterations(raw.autocritiqueCodeIterations),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: CritiqueConfig): void {
  const path = configFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function modelLabel(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Models the user can pick in /critique config: the session-scoped set when
 * scoping is configured, otherwise the full available catalogue. Only models
 * with configured auth are offered.
 */
export function pickableModels(ctx: ExtensionContext): Model<any>[] {
  const scoped = (ctx.scopedModels ?? []).map((entry) => entry.model);
  const candidates = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
  return candidates.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
}

/**
 * Resolve the model that runs the critique.
 *
 * - Pinned ("provider/modelId"): used when it exists and has configured auth.
 * - Auto (""): prefer a different model than the working one, so the review is
 *   independent; fall back to the working model when nothing else is usable.
 */
export function resolveCritiqueModel(
  ctx: ExtensionContext,
  config: CritiqueConfig,
): Model<any> | undefined {
  if (config.model) {
    const slash = config.model.indexOf("/");
    const provider = slash >= 0 ? config.model.slice(0, slash) : config.model;
    const id = slash >= 0 ? config.model.slice(slash + 1) : config.model;
    const model = ctx.modelRegistry.find(provider, id);
    if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
  }

  const candidates = pickableModels(ctx);
  const working = ctx.model;
  const different = candidates.find(
    (model) => !working || model.provider !== working.provider || model.id !== working.id,
  );
  return different ?? working ?? candidates[0];
}

/** Resolve the model used by automatic prompt critique. */
export function resolveAutoPromptCritiqueModel(
  ctx: ExtensionContext,
  config: CritiqueConfig,
): Model<any> | undefined {
  if (config.autoPromptCritiqueModel === "working") {
    return ctx.model ?? pickableModels(ctx)[0];
  }
  return resolveCritiqueModel(ctx, config) ?? ctx.model ?? pickableModels(ctx)[0];
}
