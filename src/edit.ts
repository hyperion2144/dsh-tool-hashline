/**
 * Model-facing hash-anchored edit. Every op is validated against the file's
 * current content before anything is written; a stale anchor fails the whole
 * call. Writes go through the observation-policy guard exactly like
 * `@deepseek-ai/dsh-tool-fs`: `fs/edit-intent` waterfall → in-memory apply →
 * `ctx.fs.writeText` with the policy's version intent → `fs/observed`.
 * @module dsh-tool-hashline/edit
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError, type FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { applyEdits, type EditOpInput } from './edit-engine.ts'
import { HashlineError } from './errors.ts'
import { computeHashes, formatAnchor, fnv1a32, splitLines, type Anchor } from './hash.ts'
import { EDIT_GUIDANCE } from './prompts/edit.ts'

const encoder = new TextEncoder()

/** Edit-tool options derived from plugin config. */
export interface EditToolOptions {
  hashLength: number
  replaceText: boolean
}

interface EditInput {
  filePath: string
  edits: EditOpInput[]
}

/** Validate what the schema DSL can't express; per-op rules live in the engine. */
export function parseEditArgs(args: { file_path: string; edits?: unknown }): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error('edits must be a non-empty array')
  return { filePath: args.file_path, edits: args.edits as EditOpInput[] }
}

/** Signature for the noop-loop guard: the op payload plus the current content. */
function noopSignature(edits: readonly EditOpInput[], content: string): string {
  return `${fnv1a32(encoder.encode(JSON.stringify(edits)))}:${fnv1a32(encoder.encode(content))}`
}

/** Fresh `LINE#HASH` anchors for the changed region, from the final content. */
function freshAnchors(finalContent: string, range: { from: number; to: number }, hashLength: number): Anchor[] {
  const lines = splitLines(finalContent)
  const hashes = computeHashes(lines, hashLength)
  const anchors: Anchor[] = []
  for (let line = range.from; line <= range.to && line <= lines.length; line++) {
    const hash = hashes[line - 1]
    if (hash !== undefined) anchors.push({ line, hash })
  }
  return anchors
}


/**
 * Register the `edit` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param opts - resolved edit options from plugin config.
 */
export function applyEditTool(ctx: Context, opts: EditToolOptions): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: 102,
    text: EDIT_GUIDANCE,
  })

  // Consecutive identical no-op edits per file, for the loop guard.
  const noopState = new Map<string, { signature: string; count: number }>()

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file using LINE#HASH anchors from the read tool. All ops in one call validate against the same snapshot; stale anchors fail the call.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      edits: {
        type: 'array',
        required: true,
        description: 'One or more hash-anchored ops, applied together.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, description: 'replace | append | prepend | replace_text' },
            pos: { type: 'string', description: 'LINE#HASH anchor (e.g. "42#KT"); required for replace, optional for append/prepend (omitted: EOF/BOF).' },
            end: { type: 'string', description: 'LINE#HASH anchor of the inclusive range end for replace.' },
            lines: { type: 'array', items: { type: 'string' }, description: 'Literal replacement/insertion lines. Empty array deletes a replace range.' },
            old_text: { type: 'string', description: 'replace_text: literal text to replace.' },
            new_text: { type: 'string', description: 'replace_text: literal replacement.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
          appliedOps: { type: 'integer', required: true },
          changed: { type: 'boolean', required: true },
          anchors: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                line: { type: 'integer', required: true },
                hash: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const anchors = value.anchors as Anchor[]
        const block = anchors.length > 0
          ? `\n\n--- Anchors ${anchors[0]!.line}-${anchors.at(-1)!.line} ---\n${anchors.map(formatAnchor).join('\n')}`
          : ''
        const text = value.changed
          ? `The file ${value.path} has been updated: ${value.appliedOps} edit(s) applied.${block}`
          : `No changes were made to ${value.path}.`
        return [{ type: 'text', text }]
      },
      presentationMeta: (args, value) => ({
        diffs: [{ path: args.file_path, oldText: value.before, newText: value.after }],
      }),
    },
    async execute(args, exec) {
      const input = parseEditArgs(args)
      const cwd = exec.agent?.session.header.cwd
      const target = await ctx.fs.resolve(input.filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal,
      })
      const targetKey = String(target.targetKey)
      try {
        const editIntent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        const writeIntent: FsWriteIntent | undefined = editIntent === undefined
          ? undefined
          : { kind: 'replaceIfVersion', version: editIntent.version }
        const current = await ctx.fs.readText(target, exec.signal)
        const applied = applyEdits(current, input.edits, opts)

        if (!applied.changed) {
          const signature = noopSignature(input.edits, current)
          const entry = noopState.get(targetKey)
          const count = (entry?.signature === signature ? entry.count : 0) + 1
          noopState.set(targetKey, { signature, count })
          if (count >= 3) {
            throw new HashlineError(
              'three consecutive identical edits made no change — state what should actually differ, or re-read the file',
              'HASHLINE_NOOP_LOOP',
            )
          }
          return {
            path: target.displayPath,
            before: current,
            after: current,
            appliedOps: input.edits.length,
            changed: false,
            anchors: [],
          }
        }
        noopState.delete(targetKey)
        const wrote = await ctx.fs.writeText(target, applied.content, writeIntent, exec.signal)
        ctx.emit('fs/observed', target, { kind: 'present', version: wrote.version }, exec)
        return {
          path: target.displayPath,
          before: wrote.before ?? '',
          after: wrote.after,
          appliedOps: input.edits.length,
          changed: true,
          anchors: freshAnchors(wrote.after, applied.anchorsRange, opts.hashLength),
        }
      } catch (error: unknown) {
        if (error instanceof FsError) {
          if (error.code === 'FS_STALE_VERSION') {
            throw new FsError(`${error.message} — re-read the file, then retry`, error.code)
          }
          if (error.code === 'FS_NOT_OBSERVED') {
            throw new FsError(`${error.message} — read the file, then retry`, error.code)
          }
        }
        throw error
      }
    },
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = (result.meta as { diffs?: { path: string; oldText: string; newText: string }[] } | undefined)?.diffs
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
