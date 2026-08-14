/**
 * Model-facing hash-tagged read. One provider stat for type routing and the
 * observed version, streamed or whole-file read, a bounded tagged window, and
 * the `fs/observed` emit — the exact execution contract of
 * `@deepseek-ai/dsh-tool-fs`'s read, with `LINE#HASH:` tags in the render.
 * @module dsh-tool-hashline/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { buildTaggedWindow, formatReadOutput } from './render.ts'
import { READ_GUIDANCE } from './prompts/read.ts'

/** Resolved read-tool caps — plugin config after defaulting. */
export interface ReadToolCaps {
  /** Default and maximum number of lines returned by one `read` call. */
  limit: number
  /** Maximum characters returned for a single line before truncation. */
  maxLineLength: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  maxBytes: number
  /** Files at or above this size stream instead of loading whole into memory. */
  streamMinSize: number
  /** Hash length in characters (2-4). */
  hashLength: number
}

/** Validated `read` arguments after defaulting. */
export interface ReadInput {
  filePath: string
  offset: number
  limit: number
  raw: boolean
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate value constraints the schema DSL can't express. Mirrors tool-fs.
 * @param args - the schema-validated raw tool arguments.
 * @param maxLimit - the deployment's line cap.
 */
export function parseReadArgs(
  args: { file_path: string; offset?: number; limit?: number; raw?: boolean },
  maxLimit: number,
): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  return { filePath: args.file_path, offset, limit, raw: args.raw ?? false }
}

/** Line-number column width for a requested window starting at `offset`. */
function padWidthFor(offset: number, limit: number): number {
  return Math.max(1, String(offset + limit - 2).length)
}

/**
 * Register the `read` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param caps - the deployment's resolved read caps.
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: 100,
    text: READ_GUIDANCE,
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content with per-line content hashes (LINE#HASH).',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
      raw: { type: 'boolean', description: 'Return plain content without LINE#HASH prefixes. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                hash: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer' },
          cappedByBytes: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => {
        const input = parseReadArgs(args, caps.limit)
        return [{
          type: 'text',
          text: formatReadOutput({
            path: value.path,
            offset: value.offset,
            lines: value.lines,
            totalLines: value.totalLines,
            raw: input.raw,
            cappedByBytes: value.cappedByBytes,
            padWidth: padWidthFor(input.offset, input.limit),
          }),
        }]
      },
      // Persist a hash-free projection so the UI read card and replay keep
      // the tool-fs shape; tags exist only in the model-facing text.
      presentationMeta: (_args, value) => ({
        path: value.path,
        offset: value.offset,
        lines: value.lines.map(({ number, text }: { number: number; text: string }) => ({ number, text })),
        ...(value.totalLines === undefined ? {} : { totalLines: value.totalLines }),
      }),
    },
    // Observation races fail closed because guarded mutations re-check the
    // version in-lock (same contract as tool-fs read).
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit)
      const cwd = exec.agent?.session.header.cwd
      const target = await ctx.fs.resolve(input.filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal,
      })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      const source = info.size === undefined || info.size >= caps.streamMinSize
        ? await ctx.fs.streamText(target, exec.signal)
        : await ctx.fs.readText(target, exec.signal)
      const window = await buildTaggedWindow(source, {
        offset: input.offset,
        limit: input.limit,
        maxLineLength: caps.maxLineLength,
        maxBytes: caps.maxBytes,
        hashLength: caps.hashLength,
      })
      if (window.totalLines !== undefined && input.offset > window.totalLines) {
        throw new Error(`offset ${input.offset} is out of range for "${target.displayPath}" (${window.totalLines} lines)`)
      }
      const outcome = {
        path: target.displayPath,
        offset: input.offset,
        lines: window.lines.map(({ number, hash, text }) => ({ number, hash, text })),
        ...(window.totalLines === undefined ? {} : { totalLines: window.totalLines }),
        cappedByBytes: window.cappedByBytes,
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return outcome
    },
    // Pure display: a generic card titled by the file with the read window
    // appended — mirrors tool-fs read's presenter.
    presentCall(args): GenericCallView {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.file_path}${window}`,
        kind: 'read',
        locations: [{ path: args.file_path, line: offset ?? 1 }],
      }
    },
    // Result-time display: a read card from the persisted meta when the
    // envelope matches (same regex contract as tool-fs read).
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      if (result.meta === undefined) return undefined
      // The persisted meta mirrors tool-fs's shape; totalLines is omitted for
      // byte-capped reads, which the read card cannot express — fall back to
      // the generic result rendering in that rare case.
      const meta = result.meta as { path: string; offset: number; lines: { number: number; text: string }[]; totalLines?: number }
      if (meta.totalLines === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        totalLines: meta.totalLines,
        content: [{ type: 'text', text: body }],
      }
    },
  }))
}
