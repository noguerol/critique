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
  const [status, untrackedList, ...diffs] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ...(headSha
      ? [git(root, ["diff", "HEAD", ...diffFlags])]
      : [git(root, ["diff", "--cached", ...diffFlags]), git(root, ["diff", ...diffFlags])]),
  ]);
  if (!ok(status) || !ok(untrackedList) || !diffs.every(ok)) return undefined;
  const untracked = untrackedList.stdout.split("\0").filter(Boolean);

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
