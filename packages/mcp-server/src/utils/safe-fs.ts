import fs from 'fs';
import path from 'path';

/**
 * Symlink guard (M10) for writes to fixed, hard-coded config paths (e.g.
 * ~/.claude/settings.json, <repo>/.deerdawn-context.md). Those paths are never
 * derived from user input, so this is not a path-traversal fix — it protects
 * against a cloned repo (or a tampered home directory) that plants a symlink
 * at one of those fixed names, which would otherwise cause `fs.writeFileSync`
 * to follow the link and silently overwrite whatever it points to.
 *
 * Chosen behavior: REFUSE, don't unlink. Deleting a symlink the caller doesn't
 * own to force a write through is a destructive action of its own; refusing
 * and logging is a clear, non-destructive signal the user or an admin can act
 * on, and it fails closed (skip the write) rather than fail open.
 *
 * A missing path (fs.lstatSync throwing ENOENT) is the normal first-run case,
 * NOT an error — callers should proceed with the write.
 *
 * This is the LEAF check only. See isInsideRoot for the rest of the path.
 */
export function isUnsafeSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    // Missing entry (first run) or unreadable — not a symlink we need to guard.
    return false;
  }
}

/**
 * Does `target` stay inside `root` once every symlink on the way is followed?
 *
 * isUnsafeSymlink looks at the LAST component only. That stops a planted
 * `<repo>/AGENTS.md -> ~/.zshrc`, and does nothing about a planted DIRECTORY: a
 * cloned repo that ships `.claude/skills -> ~/.ssh` (or `.github -> ~/.config`)
 * passes the leaf check, because the leaf — `deerdawn-foo/SKILL.md` — does not
 * exist yet, and the write, the mkdir before it and the recursive delete that
 * cleans it up later all land outside the repo.
 *
 * So the question is asked of the whole path, from the trusted root down: the
 * deepest part of `target` that exists is resolved with realpath, the components
 * that do not exist yet are appended (they cannot be links), and the result must
 * still be `root` or below it. Both sides are resolved, so a root that is itself
 * reached through a link (/tmp -> /private/tmp, a home on another volume) is not
 * a false alarm; path.relative handles case-insensitive and cross-drive Windows
 * paths. A symlink that stays INSIDE the root is allowed — a monorepo may well
 * link one package's `.claude` to another's.
 *
 * Fails closed: a root that cannot be resolved contains nothing.
 */
export function isInsideRoot(target: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    return false;
  }
  const resolved = path.resolve(target);
  const pending: string[] = [];
  let existing = resolved;
  // Walk up to the deepest ancestor that exists. lstat, not exists(): a dangling
  // symlink "does not exist" to existsSync and would be skipped as if it were a
  // plain missing directory, then created THROUGH by mkdir.
  for (;;) {
    let present = false;
    try { fs.lstatSync(existing); present = true; } catch { present = false; }
    if (present) break;
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    pending.unshift(path.basename(existing));
    existing = parent;
  }
  let realExisting: string;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    return false; // dangling link, or unreadable: not provably inside
  }
  const realTarget = path.join(realExisting, ...pending);
  const rel = path.relative(realRoot, realTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * fs.writeFileSync wrapper that refuses to write through an existing symlink.
 * Returns true if the write happened, false if it was refused (logged via
 * console.error — non-fatal, mirrors the non-fatal posture of every other
 * write in project-sync.ts / auth.ts).
 *
 * Pass `root` for any path built under a directory DeerDawn does not own the
 * contents of — a repo — and the write is also refused when a symlinked parent
 * would carry it outside that root. Writes to fixed paths under the user's own
 * home pass no root and keep the leaf check only: `~/.claude` linked into a
 * dotfiles repo on another volume is a common, legitimate setup, and a tampered
 * home directory is not a threat a path check can answer.
 */
export function safeWriteFileSync(
  filePath: string,
  data: string,
  options?: fs.WriteFileOptions,
  root?: string,
): boolean {
  if (isUnsafeSymlink(filePath)) {
    console.error(`[DeerDawn] Refusing to write through symlink at ${filePath} — remove it manually if this is expected.`);
    return false;
  }
  if (root !== undefined && !isInsideRoot(filePath, root)) {
    console.error(`[DeerDawn] Refusing to write ${filePath}: a symlinked directory on the way leads outside ${root}.`);
    return false;
  }
  fs.writeFileSync(filePath, data, options);
  return true;
}

/**
 * mkdir -p that will not create directories through a link leading out of `root`.
 * Without this the refusal above comes too late: the recursive mkdir that
 * precedes a write has already made the directory on the far side of the link.
 */
export function safeMkdirSync(dirPath: string, root: string): boolean {
  if (!isInsideRoot(dirPath, root)) {
    console.error(`[DeerDawn] Refusing to create ${dirPath}: a symlinked directory on the way leads outside ${root}.`);
    return false;
  }
  fs.mkdirSync(dirPath, { recursive: true });
  return true;
}
