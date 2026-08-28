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

export interface CritiqueConfig {
  /** Canonical "provider/modelId" of the critique model. Empty string = auto. */
  model: string;
  /** Inject the review back into the working model automatically. */
  autoInject: boolean;
}

export const DEFAULT_CONFIG: CritiqueConfig = {
  model: "",
  autoInject: true,
};

export function configFilePath(): string {
  return join(getAgentDir(), "critique.json");
}

export function loadConfig(): CritiqueConfig {
  try {
    const raw = JSON.parse(readFileSync(configFilePath(), "utf8")) as Partial<CritiqueConfig>;
    return {
      model: typeof raw.model === "string" ? raw.model : DEFAULT_CONFIG.model,
      autoInject:
        typeof raw.autoInject === "boolean" ? raw.autoInject : DEFAULT_CONFIG.autoInject,
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

export function modelLabel(model: Model): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Models the user can pick in /critique config: the session-scoped set when
 * scoping is configured, otherwise the full available catalogue. Only models
 * with configured auth are offered.
 */
export function pickableModels(ctx: ExtensionContext): Model[] {
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
): Model | undefined {
  if (config.model) {
    const slash = config.model.indexOf("/");
    const provider = slash >= 0 ? config.model.slice(0, slash) : config.model;
    const id = slash >= 0 ? config.model.slice(slash + 1) : config.model;
    const model = ctx.modelRegistry.find(provider, id);
    return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
  }

  const candidates = pickableModels(ctx);
  const working = ctx.model;
  const different = candidates.find(
    (model) => !working || model.provider !== working.provider || model.id !== working.id,
  );
  return different ?? working ?? candidates[0];
}
