/**
 * autocritique-code gate: a QA pass is injected only after turns that changed
 * files (successful file-mutating tool call, or a git working-tree change),
 * never after read-only investigation turns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasSuccessfulFileMutation,
  normalizeToolName,
  planAutocritiqueCode,
  workspaceChanged,
} from "../src/autocritique-code.ts";
import { extractLatestStep, listUserPrompts } from "../src/work-step.ts";
import { workspaceFingerprint, type FingerprintExec } from "../src/workspace-fingerprint.ts";

const call = (id: string, name: string) => ({ id, name });
const result = (callId: string, isError = false) => ({ callId, isError });

test("read-only tools are not file changes", () => {
  const calls = ["read", "grep", "ls", "bash", "web_search"].map((name, i) => call(String(i), name));
  assert.equal(hasSuccessfulFileMutation(calls, []), false);
  assert.equal(hasSuccessfulFileMutation([], []), false);
});

test("successful edit/write-style calls are file changes", () => {
  assert.equal(hasSuccessfulFileMutation([call("1", "edit")], [result("1")]), true);
  assert.equal(hasSuccessfulFileMutation([call("1", "write")], []), true);
  assert.equal(hasSuccessfulFileMutation([call("1", "mcp__tools__edit")], []), true);
  assert.equal(hasSuccessfulFileMutation([call("1", "Apply_Patch")], []), true);
});

test("failed mutations and look-alike names do not count", () => {
  assert.equal(hasSuccessfulFileMutation([call("1", "edit")], [result("1", true)]), false);
  assert.equal(
    hasSuccessfulFileMutation([call("1", "edit"), call("2", "write")], [result("1", true), result("2")]),
    true,
  );
  assert.equal(hasSuccessfulFileMutation([call("1", "readwrite_notes"), call("2", "editor_open")], []), false);
});

test("normalizeToolName and workspaceChanged edge cases", () => {
  assert.equal(normalizeToolName(undefined as unknown as string), "");
  assert.equal(normalizeToolName("a__b__Write"), "write");
  assert.equal(workspaceChanged(undefined, "a"), false);
  assert.equal(workspaceChanged("a", undefined), false);
  assert.equal(workspaceChanged("a", "a"), false);
  assert.equal(workspaceChanged("a", "b"), true);
});

// --- planAutocritiqueCode over real episode extraction ----------------------

type Entry = { type: string; message: Record<string, unknown> };
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}): Entry => ({
  type: "message",
  message: { role, content, ...extra },
});
const user = (text: string) => msg("user", [{ type: "text", text }]);
const toolCall = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
const toolResult = (id: string, name: string, isError = false) =>
  msg("toolResult", [{ type: "text", text: "out" }], { toolCallId: id, toolName: name, isError });

function plan(branch: Entry[], workspace = false) {
  const b = branch as unknown as Parameters<typeof extractLatestStep>[0];
  const step = extractLatestStep(b);
  return planAutocritiqueCode({
    enabled: true,
    hasUI: true,
    idle: true,
    maxRounds: 1,
    userPrompts: listUserPrompts(b),
    lastStepChangedFiles: (step ? hasSuccessfulFileMutation(step.toolCalls, step.toolResults) : false) || workspace,
    injections: 0,
  });
}

test("a read-only investigation turn does not inject a QA pass", () => {
  const branch = [
    user("why does X happen?"),
    msg("assistant", [toolCall("1", "read"), toolCall("2", "bash")]),
    toolResult("1", "read"),
    toolResult("2", "bash"),
    msg("assistant", [{ type: "text", text: "because" }]),
  ];
  assert.equal(plan(branch).inject, false);
  assert.equal(plan(branch, true).inject, true, "a workspace change (e.g. bash write) still injects");
});

test("an edit turn injects; a turn whose only edit failed does not", () => {
  assert.equal(plan([user("fix"), msg("assistant", [toolCall("1", "edit")]), toolResult("1", "edit")]).inject, true);
  assert.equal(
    plan([user("fix"), msg("assistant", [toolCall("1", "edit")]), toolResult("1", "edit", true)]).inject,
    false,
  );
});

// --- workspaceFingerprint against real temporary git repositories ----------

const exec: FingerprintExec = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: options?.timeout, maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ stdout: String(stdout), code, killed: Boolean(error?.killed) });
    });
  });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

test("workspaceFingerprint tracks file changes without writing the index", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "critique-fp-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const plain = join(scratch, "plain");
  mkdirSync(plain);
  assert.equal(await workspaceFingerprint(exec, plain), undefined, "non-git directory");
  assert.equal(await workspaceFingerprint(exec, ""), undefined, "empty cwd");

  const repo = join(scratch, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "u.txt"), "untracked\n");
  const unborn = await workspaceFingerprint(exec, repo);
  assert.equal(typeof unborn, "string", "unborn HEAD fingerprints");

  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const base = await workspaceFingerprint(exec, repo);
  assert.notEqual(base, unborn, "commit changes it");
  assert.equal(await workspaceFingerprint(exec, repo), base, "stable when nothing changed");

  const index = join(repo, ".git", "index");
  const indexMtime = statSync(index).mtimeMs;
  writeFileSync(join(repo, "a.txt"), "two\n");
  const m1 = await workspaceFingerprint(exec, repo);
  assert.notEqual(m1, base, "tracked modification");
  assert.equal(statSync(index).mtimeMs, indexMtime, "does not write .git/index");
  writeFileSync(join(repo, "a.txt"), "three\n");
  const m2 = await workspaceFingerprint(exec, repo);
  assert.notEqual(m2, m1, "second edit to an already-modified file");
  writeFileSync(join(repo, "new\nname.txt"), "x\n");
  const m3 = await workspaceFingerprint(exec, repo);
  assert.notEqual(m3, m2, "new untracked file with an odd name");
  writeFileSync(join(repo, "ignored.log"), "noise\n");
  assert.equal(await workspaceFingerprint(exec, repo), m3, "ignored files do not count");
});

test("workspaceFingerprint degrades to undefined on git failures", async () => {
  const cwd = process.cwd();
  assert.equal(await workspaceFingerprint(async () => { throw new Error("boom"); }, cwd), undefined);
  assert.equal(await workspaceFingerprint(async () => ({ stdout: "", code: 1 }), cwd), undefined);
  assert.equal(await workspaceFingerprint(async () => ({ stdout: cwd, code: 0, killed: true }), cwd), undefined);
});
