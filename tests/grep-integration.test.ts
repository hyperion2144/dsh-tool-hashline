/**
 * End-to-end grep tests against the real ripgrep binary (packaged), the real
 * local backend, and the observation policy. The headline contract: anchors
 * from grep output drive edit WITHOUT a prior read — grep records its matched
 * files as observed.
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
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as Hashline from '../src/index.ts'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
let session: { header: { cwd?: string } }

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

function anchorAt(output: string, line: number): string {
  for (const match of output.matchAll(/^\s*(\d+)#([ZPMQVRWSNKTXJBYH]{2,4}):?/gmu)) {
    if (Number(match[1]) === line) return `${match[1]}#${match[2]}`
  }
  throw new Error(`no anchor for line ${line} in output:\n${output}`)
}

const HASH_CONFIG = {
  readLimit: 2000,
  readMaxLineLength: 2000,
  readMaxBytes: 51200,
  readStreamMinSize: 10485760,
  hashLength: 2,
  replaceText: false,
  grep: false,
}

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('hashline grep (packaged ripgrep + policy)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-hashline-grep-'))
    session = { header: { cwd: dir } }
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(FsPolicy)
    fiber = await ctx.plugin(Hashline, { ...HASH_CONFIG, grep: true })
  })

  it('returns hash-anchored matches grouped by file with a summary', async () => {
    await writeFile(join(dir, 'notes.txt'), 'apple pie\nbanana bread\ncherry apple\n')
    const result = await call('grep', { pattern: 'apple' })
    expect(result.isError).toBe(false)
    const out = text(result)
    expect(out).toContain('notes.txt:')
    expect(out).toMatch(/1#[ZPMQVRWSNKTXJBYH]{2}:apple pie/u)
    expect(out).toMatch(/3#[ZPMQVRWSNKTXJBYH]{2}:cherry apple/u)
    expect(out).toContain('2 matches in 1 file.')
  })

  it('anchors from grep drive edit WITHOUT a prior read', async () => {
    await writeFile(join(dir, 'code.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n')
    const grepResult = await call('grep', { pattern: 'const b' })
    expect(grepResult.isError).toBe(false)
    const anchor = anchorAt(text(grepResult), 2)
    // No read call: the edit must pass the observation gate on grep's record.
    const editResult = await call('edit', {
      file_path: 'code.ts',
      edits: [{ op: 'replace', pos: anchor, lines: ['const b = 42;'] }],
    })
    expect(editResult.isError).toBe(false)
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('const a = 1\nconst b = 42;\nconst c = 3\n')
  })

  it('returns context lines when requested', async () => {
    await writeFile(join(dir, 'f.txt'), 'one\ntwo\nthree\nfour\n')
    const result = await call('grep', { pattern: 'three', context: 1 })
    const out = text(result)
    expect(out).toMatch(/2#[ZPMQVRWSNKTXJBYH]{2}:two/u)
    expect(out).toMatch(/4#[ZPMQVRWSNKTXJBYH]{2}:four/u)
  })

  it('reports zero matches cleanly', async () => {
    await writeFile(join(dir, 'f.txt'), 'nothing here\n')
    const result = await call('grep', { pattern: 'zzz-not-there' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('No matches found')
  })

  it('rejects an invalid regex with the ripgrep error', async () => {
    const result = await call('grep', { pattern: '(' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('pattern rejected by ripgrep')
  })

  it('honors the literal flag', async () => {
    await writeFile(join(dir, 'f.txt'), 'a.b\nacb\n')
    const result = await call('grep', { pattern: 'a.b', literal: true })
    const out = text(result)
    expect(out).toContain('1 match in 1 file.')
    expect(out).toContain('a.b')
    expect(out).not.toContain('acb')
  })

  it('respects a glob filter', async () => {
    await writeFile(join(dir, 'a.ts'), 'target\n')
    await writeFile(join(dir, 'b.md'), 'target\n')
    const result = await call('grep', { pattern: 'target', glob: '*.ts' })
    const out = text(result)
    expect(out).toContain('a.ts:')
    expect(out).not.toContain('b.md')
  })

  it('reports truncation past the limit', async () => {
    await writeFile(join(dir, 'many.txt'), Array.from({ length: 10 }, (_, i) => `item ${i}`).join('\n'))
    const result = await call('grep', { pattern: 'item', limit: 3 })
    const out = text(result)
    expect(out).toContain('(truncated at 3)')
  })
})

describe('grep stays off by default', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-hashline-nogrep-'))
    session = { header: { cwd: dir } }
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(FsPolicy)
    fiber = await ctx.plugin(Hashline, HASH_CONFIG)
  })

  it('does not register the grep tool without config.grep', async () => {
    await writeFile(join(dir, 'f.txt'), 'x\n')
    const result = await call('grep', { pattern: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
  })
})
