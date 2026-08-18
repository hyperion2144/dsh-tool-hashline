/**
 * Model-facing hash-anchored grep: ripgrep search whose matched lines return
 * as `LINE#HASH:content` anchors usable directly in edit. Execution spawns the
 * PACKAGED ripgrep binary through the subprocess seam (no system rg install
 * required), then reads each matched file through `ctx.fs` to compute
 * content-stable hashes and records it as observed — so edits anchored on
 * grep output need no prior read. Adopted from pi-hashline-edit (MIT);
 * subprocess plumbing mirrors `@deepseek-ai/dsh-tool-fs-search`.
 * @module dsh-tool-hashline/grep
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  buildGrepArgv,
  cardMatchesFor,
  displayPath,
  formatGrepFileSection,
  formatGrepSummary,
  groupMatches,
  linesOf,
  parseGrepArgs,
  parseRgMatchRecord,
} from './grep-engine.ts'
import { GREP_GUIDANCE } from './prompts/grep.ts'

/** Raw stdout budget and terminate grace, mirroring tool-fs-search defaults. */
const RAW_OUTPUT_MAX_BYTES = 20_000_000
const STDERR_MAX_BYTES = 64 * 1024
const GRACE_MS = 3_000

/** Options derived from plugin config. */
export interface GrepToolOptions {
  hashLength: number
}

let rgPathPromise: Promise<string> | undefined

/**
 * The packaged ripgrep binary path, resolved lazily once per process (the
 * same contract as tool-fs-search: a missing platform package fails at the
 * first call, never at plugin load).
 */
export function resolveRgPath(): Promise<string> {
  rgPathPromise ??= import('@vscode/ripgrep').then((module) => module.rgPath as string)
  return rgPathPromise
}

/**
 * Register the hashline `grep` tool and its system-prompt guidance.
 * @param ctx - the plugin context; execution uses its `subprocess` and `fs` services.
 * @param opts - resolved grep options from plugin config.
 */
export function applyGrepTool(ctx: Context, opts: GrepToolOptions): void {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: 104,
    text: GREP_GUIDANCE,
  })

  ctx.tools.register(defineTool({
    name: 'grep',
    description: 'Search file contents with ripgrep. Each matched line returns as `LINE#HASH: content` — the line NUMBER is the line\'s position in the whole file, the hash its content-stable check — usable directly in edit without a prior read.',
    timeoutMs: 30_000,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Search pattern (regex unless literal: true).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace.' },
      glob: { type: 'string', description: 'Filename glob filter, e.g. "**/*.ts".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive matching. Defaults to false.' },
      literal: { type: 'boolean', description: 'Treat pattern as a literal string, not a regex. Defaults to false.' },
      context: { type: 'number', description: 'Number of context lines around each match (0-5, default 0).' },
      limit: { type: 'number', description: 'Maximum matched lines to return (default 50, max 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
              },
            },
          },
          // Additive projection for the web search card: per-file matched
          // lines with `#HASH:` labels. Not model-facing; the `render` text is
          // the anchor contract the model consumes.
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                matches: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      lineNumber: { type: 'integer', required: true },
                      line: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
          output: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.output as string }],
      // Persist the card projection so the search card renders identically on
      // live and replay paths (the presentation contract: presentResult only
      // sees result.meta + content, so the data must ride the canonical value).
      presentationMeta: (_args, value) => ({
        files: value.files ?? [],
        truncated: value.truncated,
        total: value.matches.length,
      }),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args)
      const cwd = exec.agent?.session.header.cwd
      const workdir = cwd ?? process.cwd()

      let handle: SubprocessHandle
      try {
        handle = ctx.subprocess.spawn({
          argv: [await resolveRgPath(), '--no-config', ...buildGrepArgv(input)],
          cwd: workdir,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: RAW_OUTPUT_MAX_BYTES },
            stderr: { maxBytes: STDERR_MAX_BYTES },
          },
          graceMs: GRACE_MS,
          signal: exec.signal,
        } satisfies SubprocessSpawnSpec)
      } catch (error: unknown) {
        throw new Error(`grep could not start ripgrep: ${error instanceof Error ? error.message : String(error)}`)
      }
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      if (stdout === undefined || stderr === undefined) {
        throw new Error('grep produced no collected output streams')
      }
      if (outcome.signal !== null || outcome.exitCode === null) {
        throw new Error(`grep was aborted (signal ${outcome.signal ?? '(unknown)'})`)
      }
      if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
        const detail = stderr.text.trim()
        if (/regex parse error|error parsing glob/i.test(detail)) {
          throw new Error(`grep pattern rejected by ripgrep: ${detail}`)
        }
        throw new Error(`grep failed (exit ${outcome.exitCode})${detail.length > 0 ? `: ${detail}` : ''}`)
      }
      if (stdout.lossy) {
        throw new Error(`grep produced more raw output than the ${RAW_OUTPUT_MAX_BYTES}-byte cap; narrow pattern, path, or glob and retry`)
      }

      const all = stdout.text.split('\n').flatMap((line) => {
        const match = parseRgMatchRecord(line)
        return match === undefined ? [] : [match]
      })
      const { byFile, seen, truncated } = groupMatches(all, input.limit)

      if (seen === 0) {
        return {
          matches: [],
          truncated: false,
          output: `No matches found for ${input.pattern}.`,
        }
      }

      const sections: string[] = []
      let fileCount = 0
      const canonicalMatches: { path: string; lineNumber: number }[] = []
      const files: { path: string; matches: { lineNumber: number; line: string }[] }[] = []
      for (const [filePath, matchLines] of byFile) {
        try {
          const target = await ctx.fs.resolve(filePath, {
            ...(cwd !== undefined ? { cwd } : {}),
            signal: exec.signal,
          })
          const info = await ctx.fs.stat(target, exec.signal)
          if (info === undefined || info.type !== 'file') continue // raced/odd target: skip like pi
          const content = await ctx.fs.readText(target, exec.signal)
          // Record the observation so edits anchored on these matches pass the
          // read-before-edit gate (pi's read-snapshot behavior, DSH-native).
          ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
          const fileLines = linesOf(content)
          const section = formatGrepFileSection(displayPath(filePath), fileLines, matchLines, input.context, opts.hashLength)
          if (section !== undefined) {
            sections.push(section)
            fileCount++
            for (const lineNumber of matchLines) canonicalMatches.push({ path: displayPath(filePath), lineNumber })
            files.push({ path: displayPath(filePath), matches: cardMatchesFor(fileLines, matchLines, opts.hashLength) })
          }
        } catch (error: unknown) {
          // Binary/non-text files and files that vanished between rg and us
          // contribute nothing — ripgrep already matched their bytes.
          if (error instanceof FsError && (error.code === 'FS_NOT_TEXT' || error.code === 'FS_NOT_FOUND' || error.code === 'FS_NOT_REGULAR_FILE')) continue
          throw error
        }
      }

      const output = `${sections.join('\n---\n')}\n\n${formatGrepSummary(canonicalMatches.length, fileCount, truncated, input.limit)}`
      return { matches: canonicalMatches, truncated, output, files }
    },
    // Result-time display: a grouped search card whose matched lines carry the
    // `#HASH:` label (the meta projection buildGrepCardView narrows). Absent —
    // generic raw-text row — for a failed search and for zero matches.
    presentResult(_args, result: ToolResult): ToolResultView | undefined {
      if (result.isError) return undefined
      const meta = result.meta as { files: { path: string; matches: { lineNumber: number; line: string }[] }[]; truncated?: boolean; total?: number } | undefined
      if (meta === undefined || meta.files.length === 0) return undefined
      return {
        card: 'search',
        shape: 'matches',
        files: meta.files,
        truncated: meta.truncated ?? false,
        total: meta.total ?? 0,
      }
    },
  }))
}
