/**
 * Per-file in-process edit lock. A module-level in-flight set — shared by
 * every plugin instance in the process — rejects a second `edit` to the same
 * resolved target while the first is still reading/applying/writing, so two
 * overlapping edits can never validate and write from the same stale snapshot
 * (their anchors would silently conflict or go stale). Same process only;
 * cross-process and worker-thread overlaps still fall through to the
 * file-level version CAS (`FS_STALE_VERSION`).
 * @module dsh-tool-hashline/edit-lock
 */

import { HashlineError } from './errors.ts'

/** An owned lock handle; releasing an already-released handle is a no-op. */
export interface EditLockHandle {
  release(): void
}

const inFlight = new Set<string>()

/**
 * Try to take the per-file lock synchronously. Returns a handle to release,
 * or `undefined` when another edit to the same key is already in flight.
 * Acquired before any `await`, so two concurrent callers in one event-loop
 * tick cannot both pass.
 * @param key - the resolved filesystem target key (shared by every alias of
 *   one file).
 */
export function acquireEditLock(key: string): EditLockHandle | undefined {
  if (inFlight.has(key)) return undefined
  inFlight.add(key)
  return { release: () => { inFlight.delete(key) } }
}

/** Whether an edit to `key` is currently in flight (exposed for tests/guards). */
export function isEditLocked(key: string): boolean {
  return inFlight.has(key)
}

/**
 * Run `fn` under the per-file lock, releasing it on every outcome (success,
 * error, or no-op). Throws `HASHLINE_EDIT_LOCKED` immediately when another
 * edit to the same key is still in flight — the failed caller writes nothing
 * and usually succeeds on retry, since in-turn edits are strictly serial.
 * @param key - the resolved filesystem target key to guard.
 * @param fn - the edit pipeline to run under the lock.
 */
export async function runWithEditLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const handle = acquireEditLock(key)
  if (handle === undefined) {
    throw new HashlineError(
      'another edit to this file is already in progress; wait for it to finish, then retry',
      'HASHLINE_EDIT_LOCKED',
    )
  }
  try {
    return await fn()
  } finally {
    handle.release()
  }
}
