/**
 * Model-facing read rendering: line windowing, byte/line caps, per-line
 * truncation, and the hash-tagged read envelope. Cordis-free so it is
 * unit-testable on its own, mirroring `@deepseek-ai/dsh-tool-fs`'s
 * `read-render.ts`.
 * @module dsh-tool-hashline/render
 */

import { formatTaggedLine, hashLine, splitLines } from './hash.ts'

/** One window line. `hash` is always computed on the FULL line content. */
export interface TaggedLine {
  /** 1-based line number. */
  number: number
  /** Content hash over the line's context, from the full untruncated text. */
  hash: string
  /** The model-facing text: truncated when the line exceeds `maxLineLength`. */
  text: string
}

export interface WindowOptions {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines returned. */
  limit: number
  /** Characters kept per line before truncation (the suffix names the cap). */
  maxLineLength: number
  /** Byte cap on the selected lines' rendered output; overflow ends the window. */
  maxBytes: number
  /** Hash length in characters (2-4). */
  hashLength: number
}

export interface WindowResult {
  /** The selected lines, tagged and (for display) truncated. */
  lines: TaggedLine[]
  /** Total line count of the file; omitted when a byte cap stopped the scan. */
  totalLines?: number
  /** Whether the byte cap ended the window early. */
  cappedByBytes: boolean
}

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Truncate one over-long display line with the tool-fs-compatible suffix. */
export function truncateDisplayLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength
    ? `${line.slice(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    : line
}

/** Feed an LF-normalized line source to a consumer in file order. */
async function forEachLine(
  source: string | AsyncIterable<string>,
  cb: (line: string) => void,
): Promise<void> {
  if (typeof source === 'string') {
    for (const line of splitLines(source)) cb(line)
    return
  }
  // Streamed chunks are arbitrary slices of an LF-normalized file; carry a
  // partial line across chunk boundaries and drop the empty element a
  // trailing newline would produce (matching splitLines semantics).
  let carry = ''
  for await (const chunk of source) {
    const parts = (carry + chunk).split('\n')
    carry = parts.pop() ?? ''
    for (const part of parts) cb(part)
  }
  if (carry !== '') cb(carry)
}

/**
 * Build one window over an LF-normalized line source. Lines outside the
 * window are still counted for `totalLines`; when the rendered bytes exceed
 * `maxBytes`, the scan stops early and `totalLines` stays unknown (the capped
 * footer needs no total). Hashes are computed from the full line content,
 * never the truncated display text.
 */
export async function buildTaggedWindow(
  source: string | AsyncIterable<string>,
  opts: WindowOptions,
): Promise<WindowResult> {
  const lines: TaggedLine[] = []
  const startIndex = opts.offset - 1
  const endIndexExclusive = startIndex + opts.limit
  const padWidth = Math.max(1, String(endIndexExclusive - 1).length)
  let bytes = 0
  let cappedByBytes = false

  /**
   * Process one line (as the middle of its context triple). Returns false
   * when the byte cap fired and the scan should stop.
   */
  const process = (prev: string, curr: string, currIndex: number, next: string): boolean => {
    const hash = hashLine(prev, curr, next, opts.hashLength)
    const number = currIndex + 1
    const inWindow = currIndex >= startIndex && currIndex < endIndexExclusive
    if (!inWindow) return true
    const display = truncateDisplayLine(curr, opts.maxLineLength)
    const cost = byteLength(`${formatTaggedLine({ line: number, hash }, display, padWidth)}\n`)
    if (bytes + cost > opts.maxBytes) {
      cappedByBytes = true
      return false
    }
    bytes += cost
    lines.push({ number, hash, text: display })
    return true
  }

  // One-line-lag emission: a line's hash needs its successor, so each fed
  // line emits the PREVIOUS one (prev/curr/next all known); the tail emits
  // the last line with an empty successor. No queue, no special cases.
  let carry2 = ''
  let carry1: { line: string; index: number } | undefined
  let fed = 0
  let stopped = false
  await forEachLine(source, (line) => {
    if (stopped) return
    if (carry1 === undefined) {
      carry1 = { line, index: fed++ }
      return
    }
    if (!process(carry2, carry1.line, carry1.index, line)) {
      stopped = true
      return
    }
    carry2 = carry1.line
    carry1 = { line, index: fed++ }
  })
  if (!stopped && carry1 !== undefined) {
    process(carry2, carry1.line, carry1.index, '')
  }

  return {
    lines,
    ...(cappedByBytes ? {} : { totalLines: fed }),
    cappedByBytes,
  }
}

/** Input for the read envelope renderer (canonical value + render context). */
export interface ReadRenderInput {
  path: string
  offset: number
  lines: readonly TaggedLine[]
  totalLines?: number
  raw: boolean
  cappedByBytes: boolean
  /** Line-number column width used by the builder (request-window width). */
  padWidth: number
}

/**
 * Render the model-facing read envelope. Shape matches
 * `@deepseek-ai/dsh-tool-fs` exactly (`<path>`/`<type>`/`<content>` + a blank
 * line, one footer), except each line carries its `LINE#HASH:` tag — unless
 * `raw` is set, in which case lines are plain content.
 */
export function formatReadOutput(input: ReadRenderInput): string {
  const { path, offset, lines, totalLines, raw, cappedByBytes, padWidth } = input
  const endLine = lines.at(-1)?.number ?? Math.max(0, offset - 1)
  const next = endLine + 1
  const body = lines
    .map((line) => raw ? line.text : formatTaggedLine({ line: line.number, hash: line.hash }, line.text, padWidth))
    .join('\n')
  let footer: string
  if (cappedByBytes || totalLines === undefined) {
    footer = `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${next} to continue.)`
  } else if (endLine >= totalLines) {
    footer = `(End of file - total ${totalLines} lines)`
  } else {
    footer = `(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${next} to continue.)`
  }
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n\n${footer}\n</content>`
}
