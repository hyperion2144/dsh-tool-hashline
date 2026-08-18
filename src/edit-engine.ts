/**
 * Cordis-free edit engine: anchor resolution, strict validation, and
 * bottom-up application of hashline edit ops. Unit-testable in isolation,
 * like the hash core and renderer.
 * @module dsh-tool-hashline/edit-engine
 */

import { computeHashes, formatAnchor, mergeRanges, parseAnchor, splitLines, type Anchor, type LineRange } from './hash.ts'
import { HashlineError } from './errors.ts'

export type EditOpKind = 'replace' | 'append' | 'prepend' | 'replace_text'

/** The raw model-facing op as it arrives in the `edits` array. */
export interface EditOpInput {
  op: string
  pos?: string
  end?: string
  lines?: string[]
  old_text?: string
  new_text?: string
}

/** One validated op with parsed anchors. */
export interface ResolvedOp {
  kind: EditOpKind
  /** 1-based anchor line on the ORIGINAL content (undefined for EOF/BOF). */
  anchorLine?: number
  /** Inclusive end of a replace range. */
  endLine?: number
  /** Replacement/insertion lines (validated as literal content). */
  lines?: string[]
  /** replace_text payloads. */
  oldText?: string
  newText?: string
}

export interface EditEngineOptions {
  hashLength: number
  /** Whether the literal replace_text op is allowed. */
  replaceText: boolean
}

export interface ApplyResult {
  /** Final LF-normalized content (trailing newline preserved). */
  content: string
  /** Whether the content actually changed. */
  changed: boolean
  /** Fresh-anchor window on FINAL line coordinates: the changed lines only, merged. */
  anchorsRange: LineRange
}

const VALID_OPS: readonly EditOpKind[] = ['replace', 'append', 'prepend', 'replace_text']

/** Content that betrays a non-literal patch payload. */
const PREFIXED_LINE = /^(?:\s*\d+#[A-Z]|@@|[+-]{3}\s)/u

function validateOpShape(op: EditOpInput): void {
  if (!VALID_OPS.includes(op.op as EditOpKind)) {
    throw new Error(`unknown edit op "${op.op}" (expected one of ${VALID_OPS.join(', ')})`)
  }
}

/**
 * Reject a patch whose lines are not literal content: hashline display
 * prefixes or diff markers mean the model echoed tool output instead of
 * writing file content.
 */
export function assertLiteralLines(lines: readonly string[]): void {
  for (const line of lines) {
    if (PREFIXED_LINE.test(line)) {
      throw new HashlineError(
        `edit content must be literal file content, but a line looks like display output or a diff marker: ${JSON.stringify(line)}`,
        'HASHLINE_INVALID_PATCH',
      )
    }
  }
}

/**
 * Verify a parsed anchor against the file's CURRENT content-stable hashes.
 * Positioning is by LINE NUMBER: the anchor names one exact line, and the hash
 * is a content check that the line still holds what the caller read (or that
 * the same content simply landed at this number). A mismatched anchor fails
 * the whole call — no relocation, no fuzzy matching. Identical lines sharing a
 * hash elsewhere do not matter: validation never compares across lines.
 */
export function validateAnchor(anchor: Anchor, hashes: readonly string[], totalLines: number, label: string): void {
  if (anchor.line < 1 || anchor.line > totalLines) {
    throw new HashlineError(
      `${label} anchor ${formatAnchor(anchor)} is out of range (file has ${totalLines} lines) — re-read the file, then retry`,
      'HASHLINE_STALE_ANCHOR',
    )
  }
  const actual = hashes[anchor.line - 1]
  if (actual !== anchor.hash) {
    throw new HashlineError(
      `${label} anchor ${formatAnchor(anchor)} no longer matches line ${anchor.line} — the line's content changed; re-read the file, then retry`,
      'HASHLINE_STALE_ANCHOR',
    )
  }
}

function parseRequiredAnchor(value: string | undefined, field: string): Anchor {
  if (value === undefined) throw new Error(`${field} is required for this op`)
  const anchor = parseAnchor(value)
  if (anchor === undefined) throw new Error(`${field} must be a LINE#HASH anchor like "42#KT", got ${JSON.stringify(value)}`)
  return anchor
}

/** The inclusive line range one op occupies on the ORIGINAL content. */
function opRange(op: ResolvedOp): LineRange {
  switch (op.kind) {
    case 'replace': return { from: op.anchorLine!, to: op.endLine! }
    case 'append':
      return op.anchorLine === undefined
        ? { from: 0, to: 0 } // EOF marker; overlaps nothing
        : { from: op.anchorLine, to: op.anchorLine }
    case 'prepend': return { from: op.anchorLine ?? 1, to: op.anchorLine ?? 1 }
    case 'replace_text': throw new Error('replace_text range is computed after matching')
  }
}

/** Resolve and validate every op against the current file content. */
export function resolveOps(
  original: string,
  ops: readonly EditOpInput[],
  opts: EditEngineOptions,
): { resolved: ResolvedOp[]; textRange: LineRange | undefined } {
  if (ops.length === 0) throw new Error('edits must contain at least one op')
  const lines = splitLines(original)
  const hashes = computeHashes(lines, opts.hashLength)

  const resolved: ResolvedOp[] = []
  let textRange: LineRange | undefined

  for (const raw of ops) {
    validateOpShape(raw)
    const kind = raw.op as EditOpKind
    if (kind === 'replace_text') {
      if (!opts.replaceText) {
        throw new Error('replace_text is disabled by configuration (anchor-only edits)')
      }
      if (raw.old_text === undefined || raw.old_text.length === 0) throw new Error('old_text must be a non-empty string')
      if (raw.new_text === undefined) throw new Error('new_text is required for replace_text')
      const occurrences = original.split(raw.old_text).length - 1
      if (occurrences === 0) {
        throw new HashlineError('replace_text: old_text was not found — the file may have changed; re-read the file, then retry', 'HASHLINE_STALE_ANCHOR')
      }
      if (occurrences > 1) {
        throw new HashlineError(`replace_text: old_text matches ${occurrences} times; make it unique`, 'HASHLINE_AMBIGUOUS')
      }
      const idx = original.indexOf(raw.old_text)
      const lineStart = original.slice(0, idx).split('\n').length
      const lineEnd = lineStart + raw.old_text.split('\n').length - 1
      textRange = { from: lineStart, to: lineEnd }
      resolved.push({ kind, oldText: raw.old_text, newText: raw.new_text })
      continue
    }

    const linesPayload = raw.lines ?? []
    if (kind === 'replace') {
      const pos = parseRequiredAnchor(raw.pos, 'pos')
      validateAnchor(pos, hashes, lines.length, 'pos')
      if (raw.end !== undefined) {
        const end = parseRequiredAnchor(raw.end, 'end')
        if (end.line < pos.line) throw new Error('end must be at or after pos')
        validateAnchor(end, hashes, lines.length, 'end')
        resolved.push({ kind, anchorLine: pos.line, endLine: end.line, lines: linesPayload })
      } else {
        resolved.push({ kind, anchorLine: pos.line, endLine: pos.line, lines: linesPayload })
      }
      assertLiteralLines(linesPayload)
      continue
    }

    // append / prepend
    assertLiteralLines(linesPayload)
    if (linesPayload.length === 0) throw new Error(`${kind} requires at least one line in "lines"`)
    if (raw.pos === undefined) {
      resolved.push({ kind, lines: linesPayload })
    } else {
      const pos = parseRequiredAnchor(raw.pos, 'pos')
      validateAnchor(pos, hashes, lines.length, 'pos')
      resolved.push({ kind, anchorLine: pos.line, lines: linesPayload })
    }
  }

  // Reject overlapping ops: bottom-up application is only order-independent
  // when no two ops touch the same original lines.
  const ranges = resolved.flatMap((op) => {
    if (op.kind === 'replace_text') return textRange !== undefined ? [textRange] : []
    return [opRange(op)]
  }).sort((a, b) => a.from - b.from)
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.from <= ranges[i - 1]!.to) {
      throw new HashlineError(
        `edits overlap: lines ${ranges[i - 1]!.from}-${ranges[i - 1]!.to} are touched by more than one op`,
        'HASHLINE_INVALID_PATCH',
      )
    }
  }

  return { resolved, textRange }
}

/**
 * Apply validated ops to the original line array, bottom-up so earlier
 * (higher-line) ops never shift later ones. replace_text applies last over
 * the joined text; its uniqueness was already validated.
 */
export function applyResolved(originalLines: readonly string[], ops: readonly ResolvedOp[]): string[] {
  const lines = [...originalLines]
  // Bottom-up: EOF appends first (lowest position), BOF prepends last.
  const keyOf = (op: ResolvedOp): number =>
    op.kind === 'append' && op.anchorLine === undefined ? Number.MAX_SAFE_INTEGER
      : op.anchorLine ?? 1
  const sorted = [...ops].sort((a, b) => keyOf(b) - keyOf(a))
  for (const op of sorted) {
    switch (op.kind) {
      case 'replace': {
        const from = op.anchorLine! - 1
        const count = (op.endLine ?? op.anchorLine!) - op.anchorLine! + 1
        lines.splice(from, count, ...(op.lines ?? []))
        break
      }
      case 'append': {
        const at = op.anchorLine === undefined ? lines.length : op.anchorLine
        lines.splice(at, 0, ...(op.lines ?? []))
        break
      }
      case 'prepend': {
        const at = op.anchorLine === undefined ? 0 : op.anchorLine - 1
        lines.splice(at, 0, ...(op.lines ?? []))
        break
      }
      case 'replace_text': {
        const joined = lines.join('\n')
        const idx = joined.indexOf(op.oldText!)
        if (idx === -1) {
          // Uniqueness was validated against the original; an op touching the
          // match region is rejected as overlap, so this cannot happen.
          throw new Error('replace_text match disappeared during application')
        }
        const updated = joined.slice(0, idx) + (op.newText ?? '') + joined.slice(idx + op.oldText!.length)
        lines.length = 0
        lines.push(...splitLines(updated))
        break
      }
    }
  }
  return lines
}

/**
 * The fresh-anchor window on FINAL coordinates: the changed lines only (no
 * context expansion — content-stable hashing means untouched lines keep their
 * hashes and the caller reuses them with shifted line numbers). `first`/`last`
 * are 0-indexed diff boundaries; converted to 1-based inclusive and clamped.
 */
function anchorsRange(originalLines: readonly string[], finalLines: readonly string[], finalTotal: number): LineRange {
  const min = Math.min(originalLines.length, finalLines.length)
  let first = 0
  while (first < min && originalLines[first] === finalLines[first]) first++
  let lastOrig = originalLines.length - 1
  let lastFinal = finalLines.length - 1
  // Pair equal interior tail lines too (down to — and including — `first`):
  // when an insert shifts the tail, unchanged content pairs at shifted
  // indices and must stay OUT of the changed range.
  while (lastOrig >= first && lastFinal >= first && originalLines[lastOrig] === finalLines[lastFinal]) {
    lastOrig--
    lastFinal--
  }
  // No lines changed (already caught by `changed`, but be safe): an empty-ish
  // window at the first line rather than an inverted range.
  const from = Math.min(first + 1, finalTotal)
  const to = Math.max(from, Math.min(finalTotal, lastFinal + 1))
  return { from, to }
}

/**
 * Resolve, validate, and apply a batch of hashline ops against the current
 * file content. Throws HashlineError for stale/ambiguous anchors and invalid
 * patches; every anchor is checked before anything is applied.
 */
export function applyEdits(original: string, ops: readonly EditOpInput[], opts: EditEngineOptions): ApplyResult {
  const { resolved } = resolveOps(original, ops, opts)
  const originalLines = splitLines(original)
  const hadTrailingNewline = /[\r\n]$/u.test(original)
  const finalLines = applyResolved(originalLines, resolved)
  const content = `${finalLines.join('\n')}${finalLines.length > 0 && hadTrailingNewline ? '\n' : ''}`
  const changed = content !== original
  return {
    content,
    changed,
    anchorsRange: anchorsRange(originalLines, finalLines, finalLines.length),
  }
}

export { mergeRanges }
