/**
 * Unit tests for the per-file in-process edit lock: acquire/release, rejection
 * of a second holder, key independence, and release on every outcome. The lock
 * map is module-scoped and persists across tests in this file, so every test
 * releases every key it touches (unique keys make leakage visible promptly).
 */

import { describe, expect, it, vi } from 'vitest'
import { HashlineError } from '../src/errors.ts'
import { acquireEditLock, isEditLocked, runWithEditLock } from '../src/edit-lock.ts'

describe('edit lock', () => {
  it('acquires and releases a key', () => {
    const handle = acquireEditLock('k-acquire')
    expect(handle).toBeDefined()
    expect(isEditLocked('k-acquire')).toBe(true)
    handle!.release()
    expect(isEditLocked('k-acquire')).toBe(false)
  })

  it('rejects a second acquire of the same key while the first is held', () => {
    const first = acquireEditLock('k-reject')
    expect(acquireEditLock('k-reject')).toBeUndefined()
    expect(acquireEditLock('k-reject')).toBeUndefined()
    first!.release()
    expect(isEditLocked('k-reject')).toBe(false) // freed again, not re-acquired
  })

  it('keeps different keys independent', () => {
    const a = acquireEditLock('k-independent-a')!
    const b = acquireEditLock('k-independent-b')!
    expect(isEditLocked('k-independent-a')).toBe(true)
    expect(isEditLocked('k-independent-b')).toBe(true)
    expect(acquireEditLock('k-independent-a')).toBeUndefined()
    a.release()
    b.release()
    expect(isEditLocked('k-independent-a')).toBe(false)
    expect(isEditLocked('k-independent-b')).toBe(false)
  })

  it('release is idempotent', () => {
    const handle = acquireEditLock('k-idempotent')!
    handle.release()
    handle.release()
    expect(isEditLocked('k-idempotent')).toBe(false)
  })

  it('runWithEditLock runs the guarded fn and releases afterwards', async () => {
    expect(isEditLocked('k-run')).toBe(false)
    const ran = await runWithEditLock('k-run', async () => {
      expect(isEditLocked('k-run')).toBe(true)
      return 42
    })
    expect(ran).toBe(42)
    expect(isEditLocked('k-run')).toBe(false)
  })

  it('runWithEditLock throws HASHLINE_EDIT_LOCKED while the key is held', async () => {
    const held = acquireEditLock('k-held')!
    const fn = vi.fn(async () => 'never')
    await expect(runWithEditLock('k-held', fn)).rejects.toMatchObject({ code: 'HASHLINE_EDIT_LOCKED' })
    expect(fn).not.toHaveBeenCalled() // rejected before touching the pipeline
    held.release()
    expect(isEditLocked('k-held')).toBe(false)
  })

  it('releases the lock when the guarded fn throws', async () => {
    await expect(runWithEditLock('k-throw', async () => {
      throw new HashlineError('boom', 'HASHLINE_STALE_ANCHOR')
    })).rejects.toMatchObject({ code: 'HASHLINE_STALE_ANCHOR' })
    expect(isEditLocked('k-throw')).toBe(false)
  })

  it('a second runWithEditLock on a different key races only its own key', async () => {
    await runWithEditLock('k-nested-x', async () => {
      await expect(runWithEditLock('k-nested-y', async () => 'ok')).resolves.toBe('ok')
      await expect(runWithEditLock('k-nested-x', async () => 'never')).rejects.toMatchObject({ code: 'HASHLINE_EDIT_LOCKED' })
    })
    expect(isEditLocked('k-nested-x')).toBe(false)
    expect(isEditLocked('k-nested-y')).toBe(false)
  })
})
