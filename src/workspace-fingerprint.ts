/**
 * Critique — workspace fingerprint for autocritique-code.
 *
 * A turn can change files without a file-mutating tool call (a bash `sed -i`,
 * a redirect, a code generator). To catch those, the extension fingerprints
 * the git working tree at each checkpoint (genuine user input, every settle)
 * and treats a differing fingerprint as "this turn changed files".
 *
 * The fingerprint covers HEAD, the porcelain status, the full diff of tracked
 * files against HEAD, and the content hashes of untracked (non-ignored) files,
 * so a second edit to an already-modified file still changes it. Every git
 * call is read-only (`--no-optional-locks`, `hash-object` without `-w`).
 *
 * Cost matters: this runs on a turn boundary, so the untracked list is taken
 * from the same `git status -z` call instead of a second `git ls-files` (both
 * walk the whole tree), and the remaining queries run in parallel. Callers that
 * can decide from the tool-call signal alone should not call this at all (see
 * needsWorkspaceFingerprint in autocritique-code.ts).
 *
 * `undefined` means "no evidence": not a git work tree, git missing, a failed
 * or timed-out call. Callers must then fall back to the tool-call signal.
 *
 * `exec` is injected (pi.exec in production) so this can be tested against a
 * real temporary repository without the pi runtime.
 */

import { createHash } from "node:crypto";

export interface FingerprintExecResult {
  stdout: string;
  code: number;
  killed?: boolean;
}

export type FingerprintExec = (
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string },
) => Promise<FingerprintExecResult>;

const GIT_TIMEOUT_MS = 5_000;

/**
 * Untracked paths from `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * In `-z` mode fields are NUL-separated and never quoted: each entry is
 * `XY <path>`, and a rename/copy entry (X is `R` or `C`) is followed by one
 * extra field holding the origin path, which is skipped so it can never be
 * mistaken for an entry of its own. Only `??` entries (untracked, honouring
 * .gitignore) are returned.
 */
export function untrackedFilesFromStatus(status: string): string[] {
  if (typeof status !== "string" || !status) return [];
  const fields = status.split("\0");
  const untracked: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // "XY" + space + at least one path character.
    if (field.length < 4 || field.charAt(2) !== " ") continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code.charAt(0) === "R" || code.charAt(0) === "C") i += 1;
    if (code === "??") untracked.push(path);
  }
  return untracked;
}
/** Untracked files hashed per `git hash-object` call (keeps argv bounded). */
const HASH_CHUNK = 200;
/** Beyond this many untracked files only their names/count are fingerprinted. */
const MAX_HASHED_UNTRACKED = 2_000;

export async function workspaceFingerprint(
  exec: FingerprintExec,
  cwd: string,
): Promise<string | undefined> {
  if (typeof cwd !== "string" || !cwd) return undefined;

  const git = async (dir: string, args: string[]): Promise<FingerprintExecResult | undefined> => {
    try {
      const result = await exec("git", ["--no-optional-locks", "-C", dir, ...args], { timeout: GIT_TIMEOUT_MS });
      return result.killed ? undefined : result;
    } catch {
      return undefined;
    }
  };
  const ok = (result: FingerprintExecResult | undefined): result is FingerprintExecResult =>
    !!result && result.code === 0;

  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!ok(top)) return undefined;
  const root = top.stdout.trim();
  if (!root) return undefined;

  // Unborn HEAD (fresh repo) is valid: verify fails and HEAD is just empty.
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!head || head.killed) return undefined;
  const headSha = head.code === 0 ? head.stdout.trim() : "";

  // Independent read-only queries run in parallel to keep turn latency down.
  const diffFlags = ["--no-ext-diff", "--no-textconv", "--binary", "--no-color"];
  const [status, ...diffs] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ...(headSha
      ? [git(root, ["diff", "HEAD", ...diffFlags])]
      : [git(root, ["diff", "--cached", ...diffFlags]), git(root, ["diff", ...diffFlags])]),
  ]);
  if (!ok(status) || !diffs.every(ok)) return undefined;
  const untracked = untrackedFilesFromStatus(status.stdout);

  const untrackedHashes: string[] = [];
  const hashed = untracked.slice(0, MAX_HASHED_UNTRACKED);
  for (let i = 0; i < hashed.length; i += HASH_CHUNK) {
    const chunk = hashed.slice(i, i + HASH_CHUNK);
    const result = await git(root, ["hash-object", "--no-filters", "--", ...chunk]);
    if (ok(result)) {
      untrackedHashes.push(result.stdout);
      continue;
    }
    // One unreadable or vanished file fails the whole call; hash the chunk
    // file by file so it cannot hide content changes of its neighbours.
    for (const path of chunk) {
      const single = await git(root, ["hash-object", "--no-filters", "--", path]);
      untrackedHashes.push(ok(single) ? single.stdout : `unreadable:${path}\n`);
    }
  }

  const hash = createHash("sha256");
  for (const part of [
    root,
    headSha,
    status.stdout,
    ...diffs.map((diff) => (diff as FingerprintExecResult).stdout),
    untracked.join("\0"),
    ...untrackedHashes,
  ]) {
    hash.update(part);
    hash.update("\0\u0001");
  }
  return hash.digest("hex");
}
