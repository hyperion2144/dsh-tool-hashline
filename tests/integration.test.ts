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

  it('raw read returns untagged content', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta')
    const result = await call('read', { file_path: 'a.txt', raw: true })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('<content>\nalpha\nbeta')
    expect(text(result)).not.toContain('#')
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
