/**
 * Cordis-free grep engine: argument validation, ripgrep argv construction,
 * `rg --json` match-record parsing, context-range merging, and hash-anchored
 * region formatting. Unit-testable on its own; the tool wraps it with the
 * subprocess and filesystem seams. Adopted from pi-hashline-edit (MIT).
 * @module dsh-tool-hashline/grep-engine
 */

import { computeHashes, formatHashLabel, splitLines, type LineRange } from './hash.ts'

export const GREP_DEFAULT_LIMIT = 50
export const GREP_MAX_LIMIT = 200
export const GREP_MAX_CONTEXT = 5

/** Validated `grep` arguments after defaulting. */
export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  ignoreCase: boolean
  literal: boolean
  context: number
  limit: number
}

function parseInteger(value: number | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  }
  return value
}

/** Validate value constraints the schema DSL can't express. */
export function parseGrepArgs(args: {
  pattern: string
  path?: string
  glob?: string
  ignore_case?: boolean
  literal?: boolean
  context?: number
  limit?: number
}): GrepInput {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  if (args.glob !== undefined && args.glob.trim().length === 0) throw new Error('glob must be a non-empty string when given')
  return {
    pattern: args.pattern,
    ...(args.path !== undefined ? { path: args.path } : {}),
    ...(args.glob !== undefined ? { glob: args.glob } : {}),
    ignoreCase: args.ignore_case ?? false,
    literal: args.literal ?? false,
    context: parseInteger(args.context, 'context', 0, GREP_MAX_CONTEXT, 0),
    limit: parseInteger(args.limit, 'limit', 1, GREP_MAX_LIMIT, GREP_DEFAULT_LIMIT),
  }
}

/**
 * Build the fixed line-oriented `rg --json` argv. Every model-controlled value
 * is a plain argv element — no shell layer exists, so no quoting applies; the
 * pattern and glob ride in `--flag=value` form and the target behind `--`, so
 * a leading-dash value can never be parsed as a flag.
 */
export function buildGrepArgv(input: GrepInput): string[] {
  const parts = ['--json']
  if (input.ignoreCase) parts.push('--ignore-case')
  if (input.literal) parts.push('--fixed-strings')
  if (input.glob !== undefined) parts.push(`--glob=${input.glob}`)
  parts.push(`--regexp=${input.pattern}`)
  parts.push('--', input.path ?? '.')
  return parts
}

/** One `rg --json` match record, narrowed to the fields we consume. */
export interface RgMatch {
  path: string
  lineNumber: number
}

/**
 * Parse one `rg --json` NDJSON line into a match, or `undefined` for the
 * non-match record types (`begin`/`end`/`context`/`summary`) and anything
 * malformed — tolerant like pi-hashline-edit: framing noise never fails the
 * search, and ripgrep's own exit codes carry the real errors.
 */
export function parseRgMatchRecord(line: string): RgMatch | undefined {
  if (line.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { type?: unknown; data?: unknown }
  if (record.type !== 'match') return undefined
  if (typeof record.data !== 'object' || record.data === null) return undefined
  const data = record.data as { path?: unknown; line_number?: unknown }
  const pathText = typeof data.path === 'object' && data.path !== null
    ? (data.path as { text?: unknown }).text
    : undefined
  if (typeof pathText !== 'string') return undefined
  if (typeof data.line_number !== 'number') return undefined
  return { path: pathText, lineNumber: data.line_number }
}

/** Merge a new range into a sorted, non-overlapping list (adjacency merges). */
export function mergeRange(ranges: LineRange[], range: LineRange): void {
  let merged = range
  const remaining: LineRange[] = []
  for (const r of ranges) {
    if (r.to < merged.from - 1 || r.from > merged.to + 1) {
      remaining.push(r)
    } else {
      merged = { from: Math.min(merged.from, r.from), to: Math.max(merged.to, r.to) }
    }
  }
  remaining.push(merged)
  remaining.sort((a, b) => a.from - b.from)
  ranges.splice(0, ranges.length, ...remaining)
}

/**
 * Render one inclusive region as `LINE#HASH:content` lines, content-stable
 * hashes computed over the file's current content, line numbers padded to
 * the region's width. Mirrors pi-hashline-edit's `formatHashlineRegion`.
 */
export function formatHashlineRegion(
  fileLines: readonly string[],
  startLine: number,
  endLine: number,
  hashLength: number,
): string {
  const hashes = computeHashes(fileLines, hashLength)
  const width = String(endLine).length
  const out: string[] = []
  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    const line = fileLines[lineNum - 1]
    const hash = hashes[lineNum - 1]
    if (line === undefined || hash === undefined) continue
    out.push(`${String(lineNum).padStart(width, ' ')}#${hash}:${line}`)
  }
  return out.join('\n')
}

/** One file's rendered grep section: display path plus merged context regions. */
export function formatGrepFileSection(
  displayPath: string,
  fileLines: readonly string[],
  matchLines: readonly number[],
  contextLines: number,
  hashLength: number,
): string | undefined {
  // Guard against a race where the file was truncated between rg reading it
  // and our read: out-of-bounds line numbers are filtered, and a file with no
  // surviving matches contributes nothing.
  const valid = matchLines.filter((n) => n >= 1 && n <= fileLines.length)
  if (valid.length === 0) return undefined

  const ranges: LineRange[] = []
  for (const lineNum of valid) {
    mergeRange(ranges, {
      from: Math.max(1, lineNum - contextLines),
      to: Math.min(fileLines.length, lineNum + contextLines),
    })
  }

  const parts = [`${displayPath}:`]
  let previousEnd = -1
  for (const range of ranges) {
    if (previousEnd !== -1) parts.push('    ...')
    parts.push(formatHashlineRegion(fileLines, range.from, range.to, hashLength))
    previousEnd = range.to
  }
  return parts.join('\n')
}

/** The final summary line for a grep result. */
export function formatGrepSummary(matches: number, files: number, truncated: boolean, limit: number): string {
  const noun = matches === 1 ? 'match' : 'matches'
  const fileNoun = files === 1 ? 'file' : 'files'
  return `${matches} ${noun} in ${files} ${fileNoun}.${truncated ? ` (truncated at ${limit})` : ''}`
}

/**
 * The web search card's per-match projection from matched file content: each
 * match is `{lineNumber, line}` where `line` carries the hash label
 * (`#HASH: content`), mirroring {@link formatGrepFileSection}'s out-of-range
 * filter. A harness `SearchBlock` line has no hash slot, so the digest rides
 * the text — every matched line displays as `LINE#HASH`.
 */
export function cardMatchesFor(
  fileLines: readonly string[],
  matchLines: readonly number[],
  hashLength: number,
): { lineNumber: number; line: string }[] {
  const hashes = computeHashes(fileLines, hashLength)
  const out: { lineNumber: number; line: string }[] = []
  for (const lineNum of matchLines) {
    if (lineNum < 1 || lineNum > fileLines.length) continue
    const text = fileLines[lineNum - 1]
    const hash = hashes[lineNum - 1]
    if (text === undefined || hash === undefined) continue
    out.push({ lineNumber: lineNum, line: formatHashLabel({ line: lineNum, hash }, text) })
  }
  return out
}

/** Split rg's match list into first-seen file order with their line numbers. */
export function groupMatches(matches: readonly RgMatch[], limit: number): {
  byFile: Map<string, number[]>
  seen: number
  truncated: boolean
} {
  const byFile = new Map<string, number[]>()
  let seen = 0
  for (const match of matches) {
    if (seen >= limit) {
      return { byFile, seen, truncated: true }
    }
    const lines = byFile.get(match.path)
    if (lines !== undefined) lines.push(match.lineNumber)
    else byFile.set(match.path, [match.lineNumber])
    seen++
  }
  return { byFile, seen, truncated: false }
}

/** Strip the leading `./` ripgrep prints when searching the workdir itself. */
export function displayPath(rawPath: string): string {
  return rawPath.startsWith('./') ? rawPath.slice(2) : rawPath
}

/** Convenience: split one file's content for region rendering. */
export function linesOf(content: string): string[] {
  return splitLines(content)
}
