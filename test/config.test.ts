/**
 * Config defaults, validation and the 1.7.0 legacy migration. Run with: npm test
 *
 * PI_CODING_AGENT_DIR points the config loader at an isolated temp directory,
 * so these tests never touch the real ~/.pi/agent/critique.json. The env var is
 * read lazily inside configFilePath(), so setting it after the imports is safe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_VERSION, DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "critique-config-"));
process.env.PI_CODING_AGENT_DIR = dir;

function writeRaw(value: unknown): void {
  writeFileSync(join(dir, "critique.json"), JSON.stringify(value), "utf8");
}

test("autocritiqueCodeRecurse defaults to true (delegation is the default)", () => {
  assert.equal(DEFAULT_CONFIG.autocritiqueCodeRecurse, true);
});

test("a legacy explicit false (no configVersion) migrates to the new default", () => {
  writeRaw({ autocritiqueCode: true, autocritiqueCodeRecurse: false });
  assert.equal(loadConfig().autocritiqueCodeRecurse, true);
});

test("a versioned explicit false is preserved (deliberate inline choice)", () => {
  writeRaw({ configVersion: CONFIG_VERSION, autocritiqueCodeRecurse: false });
  assert.equal(loadConfig().autocritiqueCodeRecurse, false);
});

test("saveConfig stamps the config version without dropping the setting", () => {
  saveConfig({ ...DEFAULT_CONFIG, autocritiqueCodeRecurse: false });
  const saved = JSON.parse(readFileSync(join(dir, "critique.json"), "utf8")) as {
    configVersion?: number;
    autocritiqueCodeRecurse?: boolean;
  };
  assert.equal(saved.configVersion, CONFIG_VERSION);
  assert.equal(saved.autocritiqueCodeRecurse, false);
});

test("an out-of-range stored value falls back safely", () => {
  writeRaw({ configVersion: CONFIG_VERSION, autocritiqueCodeRecurse: "yes" });
  assert.equal(loadConfig().autocritiqueCodeRecurse, true);
});
