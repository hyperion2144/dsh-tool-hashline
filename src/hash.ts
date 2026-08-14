/**
 * Hash-anchored line protocol core. Cordis-free and dependency-free so it is
 * unit-testable in isolation, mirroring how `@deepseek-ai/dsh-tool-fs` keeps
 * its renderer core separate from plugin code.
 *
 * Adopted from pi-hashline-edit (MIT, github.com/RimuruW/pi-hashline-edit):
 * every line carries a short content hash over its immediate context
 * (`prev + curr + next`), so identical lines in different contexts hash
 * differently, and editing line N invalidates anchors only for N-1, N, N+1.
 * @module dsh-tool-hashline/hash
 */

/** Hash output alphabet: 16 visually distinct characters, 4 bits each. */
export const HASH_ALPHABET = 'ZPMQVRWSNKTXJBYH'

export const DEFAULT_HASH_LENGTH = 2
export const MIN_HASH_LENGTH = 2
export const MAX_HASH_LENGTH = 4

const FNV1A_OFFSET = 0x811c9dc5
const FNV1A_PRIME = 0x01000193
const encoder = new TextEncoder()

/** Reject an invalid hash length loudly (repo convention: fail at load). */
export function assertHashLength(value: number): void {
  if (!Number.isInteger(value) || value < MIN_HASH_LENGTH || value > MAX_HASH_LENGTH) {
    throw new Error(`hashLength must be an integer in [${MIN_HASH_LENGTH}, ${MAX_HASH_LENGTH}], got ${value}`)
  }
}

/** FNV-1a 32-bit over UTF-8 bytes; deterministic across platforms. */
export function fnv1a32(bytes: Uint8Array): number {
  let hash = FNV1A_OFFSET
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!
    hash = Math.imul(hash, FNV1A_PRIME)
  }
  return hash >>> 0
}

/**
 * Hash one line from its context triple. Missing neighbors hash as empty
 * strings, so the first and last lines still get context-sensitive hashes.
 */
export function hashLine(prev: string, curr: string, next: string, length: number): string {
  const digest = fnv1a32(encoder.encode(`${prev}\n${curr}\n${next}`))
  let out = ''
  for (let i = 0; i < length; i++) {
    out += HASH_ALPHABET.charAt((digest >>> (i * 4)) & 0xf)
  }
  return out
}

/** Compute the hash of every line of an LF-normalized file. */
export function computeHashes(lines: readonly string[], length: number): string[] {
  return lines.map((line, i) => hashLine(
    lines[i - 1] ?? '',
    line,
    lines[i + 1] ?? '',
    length,
  ))
}

/**
 * Split content into LF-normalized lines; CRLF and lone CR are accepted.
 * A trailing newline does NOT produce a final empty line (line counts and
 * hash contexts agree between the read window and the edit engine).
 */
export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

/** A parsed `LINE#HASH` anchor. */
export interface Anchor {
  /** 1-based line number. */
  line: number
  /** Content hash over the line's context, from {@link HASH_ALPHABET}. */
  hash: string
}

/** Serialize an anchor as `LINE#HASH`. */
export function formatAnchor(anchor: Anchor): string {
  return `${anchor.line}#${anchor.hash}`
}

const ANCHOR_PATTERN = /^(\d{1,8})#([ZPMQVRWSNKTXJBYH]{2,4})$/u

/**
 * Parse a `LINE#HASH` anchor. Returns `undefined` for anything malformed —
 * a stricter shape check than the edit schema, since hash length depends on
 * the running config and is validated at anchor resolution time.
 */
export function parseAnchor(value: string): Anchor | undefined {
  const match = ANCHOR_PATTERN.exec(value)
  if (!match) return undefined
  const line = Number(match[1])
  const hash = match[2]
  return hash !== undefined && line >= 1 ? { line, hash } : undefined
}

/**
 * Render one file line as `` `  8#VR:text` `` — the model-facing read format.
 * `padWidth` is the column width for the line number (digit count of the
 * file's total line count), matching pi-hashline-edit's aligned output.
 */
export function formatTaggedLine(anchor: Anchor, text: string, padWidth: number): string {
  return `${String(anchor.line).padStart(padWidth, ' ')}#${anchor.hash}:${text}`
}

/** One inclusive line range. */
export interface LineRange {
  from: number
  to: number
}

/**
 * The anchor-invalidation window of an edit touching lines `first..last`
 * (inclusive): context hashing invalidates `first-1 .. last+1`. Clamped to
 * the file; callers use this to compute the fresh-anchor block returned
 * after a successful edit.
 */
export function affectedRange(first: number, last: number, totalLines: number): LineRange {
  return {
    from: Math.max(1, first - 1),
    to: Math.min(totalLines, last + 1),
  }
}

/**
 * Merge overlapping or adjacent ranges (adjacency merges too — one extra
 * anchor line costs a few tokens and keeps the returned block contiguous).
 */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: LineRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to)
    } else {
      merged.push({ from: range.from, to: range.to })
    }
  }
  return merged
}
