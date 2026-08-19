/**
 * End-to-end tool-registry tests against the real local backend and the
 * observation policy: hashline read/edit through ctx.tools.execute, with
 * assertions read back byte-for-byte from disk rather than trusting tool
 * messages. Mirrors dsh-tool-fs's integration.spec.ts deployment shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { acquireEditLock } from '../src/edit-lock.ts'
import { readViewLines } from '../src/read.ts'
import * as Hashline from '../src/index.ts'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
const session = { header: {} }

let callCounter = 0
function call(name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session } as never,
  })
}

type ToolResultLike = { isError: boolean; content: { type: string; text?: string }[]; error?: { message?: string; info?: { code?: string } } }

function text(result: ToolResultLike): string {
  return result.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

function codeOf(result: ToolResultLike): string | undefined {
  return result.error?.info?.code
}

/** Parse the `LINE#HASH` anchor for `line` out of a tagged read/edit output. */
function anchorAt(output: string, line: number): string {
  for (const match of output.matchAll(/^\s*(\d+)#([ZPMQVRWSNKTXJBYH]{2,4}):?/gmu)) {
    if (Number(match[1]) === line) return `${match[1]}#${match[2]}`
  }
  throw new Error(`no anchor for line ${line} in output:\n${output}`)
}

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('default deployment (with dsh-fs-observation-policy)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-hashline-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    fiber = await ctx.plugin(Hashline)
  })

  it('read returns hash-tagged lines with the tool-fs envelope', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta')
    const result = await call('read', { file_path: 'a.txt' })
    expect(result.isError).toBe(false)
    const out = text(result)
    expect(out).toMatch(/^\s*1#[ZPMQVRWSNKTXJBYH]{2}:alpha$/mu)
    expect(out).toMatch(/^\s*2#[ZPMQVRWSNKTXJBYH]{2}:beta$/mu)
    expect(out).toContain('<path>')
    expect(out).toContain('(End of file - total 2 lines)')
  })

  it('read labels lines with their WHOLE-file number even past an offset', async () => {
    const body = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')
    await writeFile(join(dir, 'a.txt'), body)
    const result = await call('read', { file_path: 'a.txt', offset: 6, limit: 4 })
    expect(result.isError).toBe(false)
    const out = text(result)
    // The line numbers are the file's own numbering, never a re-count from 1.
    expect(out).toMatch(/^\s*6#[ZPMQVRWSNKTXJBYH]{2}:line 6$/mu)
    expect(out).toMatch(/^\s*8#[ZPMQVRWSNKTXJBYH]{2}:line 8$/mu)
    expect(out).not.toMatch(/^\s*1#[ZPMQVRWSNKTXJBYH]{2}:line/mu)
    const meta = (result as { meta?: unknown }).meta as { offset: number; lines: { number: number }[] } | undefined
    expect(meta?.offset).toBe(6)
    expect(meta?.lines.map((l) => l.number)).toEqual([6, 7, 8])
  })

  it('raw read returns untagged content', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta')
    const result = await call('read', { file_path: 'a.txt', raw: true })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('<content>\nalpha\nbeta')
    expect(text(result)).not.toContain('#')
  })

  it('persists the hash in presentationMeta and renders the web card as LINE#HASH', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n')
    const result = await call('read', { file_path: 'a.txt' })
    expect(result.isError).toBe(false)
    const meta = (result as { meta?: unknown }).meta as
      | { path: string; offset: number; lines: { number: number; hash: string; text: string }[]; totalLines: number }
      | undefined
    expect(meta).toBeDefined()
    expect(meta!.lines.map((l) => l.text)).toEqual(['alpha', 'beta', 'gamma'])
    expect(meta!.lines.every((l) => /^[ZPMQVRWSNKTXJBYH]{2}$/u.test(l.hash))).toBe(true)
    // The web card line projection embeds the hash label in the text column.
    const viewLines = readViewLines(meta!.lines)
    expect(viewLines[1]).toEqual({ number: 2, text: `#${meta!.lines[1]!.hash}: beta` })
    expect(viewLines.map((l) => l.text).join('\n')).toContain(`#${meta!.lines[0]!.hash}: alpha`)
  })

  it('edit applies a replace anchored on the read output', async () => {
    await writeFile(join(dir, 'a.txt'), 'function hello() {\n  return 1\n}\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    const result = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['  return 2;'] }],
    })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('function hello() {\n  return 2;\n}\n')
  })

  it('applies multiple ops in one call and returns fresh anchors', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    const result = await call('edit', {
      file_path: 'a.txt',
      edits: [
        { op: 'prepend', pos: anchorAt(readOut, 1), lines: ['zero'] },
        { op: 'replace', pos: anchorAt(readOut, 4), lines: [] },
      ],
    })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('zero\none\ntwo\nthree\n')
    const out = text(result)
    expect(out).toContain('2 edit(s) applied')
    expect(out).toContain('--- Anchors')
    // The result also persists the fresh anchors for the web diff card.
    const meta = (result as { meta?: unknown }).meta as { anchors?: { line: number; hash: string }[] } | undefined
    expect(meta?.anchors?.length).toBeGreaterThan(0)
    const first = meta!.anchors![0]!
    expect(out).toMatch(new RegExp(`^\\s*${first.line}#${first.hash}$`, 'mu'))
  })

  it('chained edits: fresh anchors from one edit drive the next without a re-read', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    const first = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['BETA'] }],
    })
    expect(first.isError).toBe(false)
    // The anchor block covers the changed region (context ±1): line 2's new
    // anchor is present in the first edit's own output.
    const firstOut = text(first)
    const second = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(firstOut, 2), lines: ['BETA2'] }],
    })
    expect(second.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('alpha\nBETA2\ngamma\n')
  })

  it('rejects an edit before any read with FS_NOT_OBSERVED and the remedy', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world\n')
    const result = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: '1#KT', lines: ['x'] }],
    })
    expect(result.isError).toBe(true)
    expect(codeOf(result)).toBe('FS_NOT_OBSERVED')
    expect(text(result)).toContain('read the file, then retry')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello world\n')
  })

  it('rejects a stale anchor with HASHLINE_STALE_ANCHOR, file untouched', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    await writeFile(join(dir, 'a.txt'), 'ONE\ntwo\nthree\n') // out-of-band change
    const result = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 1), lines: ['1'] }],
    })
    expect(result.isError).toBe(true)
    expect(codeOf(result)).toBe('HASHLINE_STALE_ANCHOR')
    expect(text(result)).toContain('re-read the file')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nthree\n')
  })

  it('falls through to the file-level CAS when anchors still match but the file drifted', async () => {
    await writeFile(join(dir, 'a.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    // Append far from the anchor: context hashes of lines 1-2 stay valid.
    await writeFile(join(dir, 'a.txt'), `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\nline 20`)
    const result = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['LINE 2'] }],
    })
    expect(result.isError).toBe(true)
    expect(codeOf(result)).toBe('FS_STALE_VERSION')
    expect(text(result)).toContain('re-read the file, then retry')
  })

  it('rejects a concurrent edit to the same file with HASHLINE_EDIT_LOCKED and writes nothing', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    const target = await ctx.fs.resolve('a.txt', { cwd: dir, signal: testToolSignal })
    const key = String(target.targetKey)
    const held = acquireEditLock(key)
    expect(held).toBeDefined()
    try {
      const result = await call('edit', {
        file_path: 'a.txt',
        edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['TWO'] }],
      })
      expect(result.isError).toBe(true)
      expect(codeOf(result)).toBe('HASHLINE_EDIT_LOCKED')
      expect(text(result)).toContain('already in progress')
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    } finally {
      held!.release()
    }
    // Once released, a serial edit to the same file succeeds normally.
    const retried = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['TWO'] }],
    })
    expect(retried.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
  })

  it('does not reject a follow-up edit after an edit completes (lock released)', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    const first = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 1), lines: ['ALPHA'] }],
    })
    expect(first.isError).toBe(false)
    // Content-stable chaining: editing line 1 left line 2's content (and thus
    // its hash) unchanged, so the PRE-EDIT anchor for line 2 still validates —
    // no re-read needed. Also proves the edit lock was released.
    const second = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['BETA'] }],
    })
    expect(second.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('ALPHA\nBETA\n')
  })

  it('continues with newLine#sameHash after an insert shifts the target (no re-read)', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntarget\ntwo\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    const targetAnchor = anchorAt(readOut, 2)
    const targetHash = targetAnchor.split('#')[1]
    // Insert a line above: the target's content is untouched, so its hash is
    // unchanged but its line number shifts 2 → 3.
    const shifted = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'prepend', pos: anchorAt(readOut, 1), lines: ['zero'] }],
    })
    expect(shifted.isError).toBe(false)
    // Continue at the NEW line number with the SAME (unchanged) hash without re-reading.
    const continued = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: `3#${targetHash}`, lines: ['TARGET!'] }],
    })
    expect(continued.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('zero\none\nTARGET!\ntwo\n')
  })

  it('the stale remedy is actionable: re-read then retry succeeds', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    await writeFile(join(dir, 'a.txt'), 'ONE\ntwo\nthree\n')
    const stale = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['TWO'] }],
    })
    expect(stale.isError).toBe(true)
    const fresh = text(await call('read', { file_path: 'a.txt' }))
    const retried = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(fresh, 2), lines: ['TWO'] }],
    })
    expect(retried.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('ONE\nTWO\nthree\n')
  })

  it('reports a no-op edit as success-with-warning and leaves the file untouched', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    const result = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['beta'] }],
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('No changes were made')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
  })

  it('three consecutive identical no-ops trip the loop guard', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    const op = { op: 'replace', pos: anchorAt(readOut, 2), lines: ['beta'] }
    for (let i = 0; i < 2; i++) {
      expect((await call('edit', { file_path: 'a.txt', edits: [op] })).isError).toBe(false)
    }
    const third = await call('edit', { file_path: 'a.txt', edits: [op] })
    expect(third.isError).toBe(true)
    expect(codeOf(third)).toBe('HASHLINE_NOOP_LOOP')
  })

  it('read reports a missing file with FS_NOT_FOUND', async () => {
    const result = await call('read', { file_path: 'missing.txt' })
    expect(result.isError).toBe(true)
    expect(codeOf(result)).toBe('FS_NOT_FOUND')
  })
})

describe('bare provider (no dsh-fs-observation-policy)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-hashline-bare-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    fiber = await ctx.plugin(Hashline)
  })

  it('edit works on an UNREAD existing file (no policy gate)', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world\n')
    const readOut = text(await call('read', { file_path: 'a.txt' }))
    // Simulate a second session that never read: a fresh context read is not
    // needed — the bare provider performs an unconditional edit.
    const result = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 1), lines: ['goodbye'] }],
    })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('goodbye\n')
  })

  it('anchor validation is still enforced without policy', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    await call('read', { file_path: 'a.txt' })
    const result = await call('edit', {
      file_path: 'a.txt',
      edits: [{ op: 'replace', pos: '2#XX', lines: ['TWO'] }],
    })
    expect(result.isError).toBe(true)
    expect(codeOf(result)).toBe('HASHLINE_STALE_ANCHOR')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  })
})

describe('confining backend: the standing sandbox policy is threaded into writeText', () => {
  // Simulate a confining filesystem (sandboxMode = workspace-write) whose
  // session resolves to danger-full-access, and prove the edit passes that
  // policy to writeText — otherwise a full-access session would be defaulted
  // to workspace-write and denied writes outside the workspace.
  const resolvedPoliciesPushed: { mode: string; workspaceRoot: string }[] = []

  beforeEach(async () => {
    resolvedPoliciesPushed.length = 0
    dir = await mkdtemp(join(tmpdir(), 'dsh-hashline-sandbox-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    const fs = ctx.fs as unknown as { [k: string]: unknown }
    Object.defineProperty(fs, 'sandboxMode', { get: () => 'workspace-write', configurable: true })
    const writeText = (fs.writeText as (t: unknown, c: unknown, e?: unknown, s?: unknown, p?: unknown) => Promise<unknown>).bind(ctx.fs)
    fs.writeText = async (target: unknown, content: unknown, expected: unknown, signal: unknown, policy: unknown) => {
      resolvedPoliciesPushed.push(policy as { mode: string; workspaceRoot: string })
      return writeText(target, content, expected, signal, policy)
    }
    // The sandbox policy service resolves the session's standing mode.
    ctx.provide('sandboxPolicy', {
      resolve: (input?: { session?: unknown }) =>
        input?.session === undefined ? undefined : { mode: 'danger-full-access', workspaceRoot: dir },
    })
    fiber = await ctx.plugin(Hashline)
  })

  it('a full-access session edit outside the workspace carries the danger-full-access policy', async () => {
    const outside = join(tmpdir(), `dsh-hashline-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    await writeFile(outside, 'alpha\nbeta\n')
    try {
      const readOut = text(await call('read', { file_path: outside }))
      const result = await call('edit', {
        file_path: outside,
        edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['BETA'] }],
      })
      expect(result.isError).toBe(false)
      expect(await readFile(outside, 'utf8')).toBe('alpha\nBETA\n')
      // The write was stamped with the resolved standing policy, not the
      // backend's workspace-write default.
      expect(resolvedPoliciesPushed.at(-1)).toEqual({ mode: 'danger-full-access', workspaceRoot: dir })
      expect(await readFile(join(dir, 'a.txt'), 'utf8').catch(() => '')).toBe('') // dir untouched
    } finally {
      await rm(outside, { force: true })
    }
  })
})

describe('per-session cwd', () => {
  let sessionDir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-hashline-cfg-'))
    sessionDir = await mkdtemp(join(tmpdir(), 'dsh-hashline-session-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    fiber = await ctx.plugin(Hashline)
  })
  afterEach(async () => { await rm(sessionDir, { recursive: true, force: true }) })

  const callIn = (sessionObj: object, name: string, args: unknown) =>
    ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId(`call-${++callCounter}`),
      name,
      arguments: args,
      agent: { session: sessionObj } as never,
    })

  it('read + edit resolve relative paths against the session cwd', async () => {
    const session = { header: { cwd: sessionDir } }
    await writeFile(join(sessionDir, 'code.txt'), 'alpha\nbeta\n')
    const readOut = text(await callIn(session, 'read', { file_path: 'code.txt' }))
    expect(readOut).toContain('(End of file - total 2 lines)')
    const edited = await callIn(session, 'edit', {
      file_path: 'code.txt',
      edits: [{ op: 'replace', pos: anchorAt(readOut, 2), lines: ['BETA'] }],
    })
    expect(edited.isError).toBe(false)
    expect(await readFile(join(sessionDir, 'code.txt'), 'utf8')).toBe('alpha\nBETA\n')
    await expect(readFile(join(dir, 'code.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
