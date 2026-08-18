/**
 * Hash-anchored line protocol core. Cordis-free and dependency-free so it is
 * unit-testable in isolation, mirroring how `@deepseek-ai/dsh-tool-fs` keeps
 * its renderer core separate from plugin code.
 *
 * Every anchor is `LINE#HASH`: the **line number is the locator** (the 1-based
 * position of the line in the whole file), and the hash is a content
 * verification tag — it never locates a line on its own. Hashing is
 * CONTENT-STABLE: the digest covers only the line's own text, so a line whose
 * content is unchanged keeps the same hash even after edits shift it to a new
 * line number, letting a caller continue with `newLine#sameHash` instead of
 * re-reading. Directing by line number also makes identical lines at
 * different positions unambiguous by construction.
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
 * Hash one line from its OWN text (content-stable): identical lines always
 * hash identically, wherever they appear, and a line keeps its hash across
 * edits as long as its content is unchanged — only its line number changes.
 */
export function hashLine(curr: string, length: number): string {
  const digest = fnv1a32(encoder.encode(curr))
  let out = ''
  for (let i = 0; i < length; i++) {
    out += HASH_ALPHABET.charAt((digest >>> (i * 4)) & 0xf)
  }
  return out
}

/** Compute the content hash of every line of an LF-normalized file. */
export function computeHashes(lines: readonly string[], length: number): string[] {
  return lines.map((line) => hashLine(line, length))
}

/**
 * Split content into LF-normalized lines; CRLF and lone CR are accepted.
 * A trailing newline does NOT produce a final empty line (line counts agree
 * between the read window and the edit engine).
 */
export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

/** A parsed `LINE#HASH` anchor. */
export interface Anchor {
  /** 1-based line number in the whole file — the locator. */
  line: number
  /** Content-stable hash over the line's own text, from {@link HASH_ALPHABET}. */
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

/**
 * Render one line's hash label as `` `#VR: text` `` — the text the web read
 * and search cards show in the line column beside the file line-number
 * gutter, so a UI without a dedicated hash slot (the harness `ReadBlock` /
 * `SearchBlock` shapes carry only `{number,text}`) still displays every line
 * as `LINE#HASH`. The digest lives on the line's `text`, never in the gutter.
 */
export function formatHashLabel(anchor: Anchor, text: string): string {
  return `#${anchor.hash}: ${text}`
}

/** One inclusive line range. */
export interface LineRange {
  from: number
  to: number
}

/**
 * The changed-line range an edit invalidates. With content-stable hashing an
 * edit touches ONLY the lines whose content it actually changed — no
 * expansion to neighbors (unchanged lines keep their hashes). Clamped to the
 * file; callers use this to compute the fresh-anchor block returned after a
 * successful edit.
 */
export function affectedRange(first: number, last: number, totalLines: number): LineRange {
  return {
    from: Math.max(1, first),
    to: Math.min(totalLines, Math.max(first, last)),
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
