import { describe, expect, it } from 'vitest'
import { applyEdits } from '../src/edit-engine.ts'
import { HashlineError } from '../src/errors.ts'
import { computeHashes, formatAnchor, splitLines } from '../src/hash.ts'

const OPTS = { hashLength: 2, replaceText: true }

/** Build a `replace` op anchored at a line of `content`. */
function anchor(content: string, line: number, hashLength = 2): string {
  const hashes = computeHashes(splitLines(content), hashLength)
  const hash = hashes[line - 1]
  if (hash === undefined) throw new Error(`no line ${line}`)
  return formatAnchor({ line, hash })
}

function replace(content: string, line: number, lines: string[], endLine?: number) {
  return { op: 'replace', pos: anchor(content, line), ...(endLine !== undefined ? { end: anchor(content, endLine) } : {}), lines }
}

function append(content: string, line: number, lines: string[]) {
  return { op: 'append', pos: anchor(content, line), lines }
}

function prepend(content: string, line: number, lines: string[]) {
  return { op: 'prepend', pos: anchor(content, line), lines }
}

/** Run fn and return the HashlineError code it threw, if any. */
function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error: unknown) {
    return error instanceof HashlineError ? error.code : undefined
  }
}

describe('applyEdits — single ops', () => {
  it('replaces one line', () => {
    const original = 'a\nb\nc\n'
    const { content, changed } = applyEdits(original, [replace(original, 2, ['B'])], OPTS)
    expect(content).toBe('a\nB\nc\n')
    expect(changed).toBe(true)
  })

  it('replaces an inclusive range', () => {
    const original = 'a\nb\nc\nd\n'
    const { content } = applyEdits(original, [replace(original, 2, ['X'], 3)], OPTS)
    expect(content).toBe('a\nX\nd\n')
  })

  it('deletes a range with an empty lines array', () => {
    const original = 'a\nb\nc\nd\n'
    const { content } = applyEdits(original, [replace(original, 2, [], 3)], OPTS)
    expect(content).toBe('a\nd\n')
  })

  it('appends after a line and at EOF', () => {
    const original = 'a\nb\n'
    const after = applyEdits(original, [append(original, 2, ['c'])], OPTS)
    expect(after.content).toBe('a\nb\nc\n')
    const atEof = applyEdits(original, [{ op: 'append', lines: ['z'] }], OPTS)
    expect(atEof.content).toBe('a\nb\nz\n')
  })

  it('prepends before a line and at BOF', () => {
    const original = 'a\nb\n'
    const before = applyEdits(original, [prepend(original, 2, ['x'])], OPTS)
    expect(before.content).toBe('a\nx\nb\n')
    const atBof = applyEdits(original, [{ op: 'prepend', lines: ['z'] }], OPTS)
    expect(atBof.content).toBe('z\na\nb\n')
  })

  it('appends to an empty file', () => {
    const { content, changed } = applyEdits('', [{ op: 'append', lines: ['hello'] }], OPTS)
    expect(content).toBe('hello')
    expect(changed).toBe(true)
  })

  it('preserves a missing trailing newline', () => {
    const original = 'a\nb'
    const { content } = applyEdits(original, [replace(original, 1, ['A'])], OPTS)
    expect(content).toBe('A\nb')
  })

  it('normalizes CRLF input and keeps LF output', () => {
    const original = 'a\r\nb\r\n'
    const { content } = applyEdits(original, [replace(original, 2, ['B'])], OPTS)
    expect(content).toBe('a\nB\n')
  })

  it('reports a no-op as unchanged', () => {
    const original = 'a\nb\n'
    const { content, changed } = applyEdits(original, [replace(original, 2, ['b'])], OPTS)
    expect(content).toBe(original)
    expect(changed).toBe(false)
  })
})

describe('applyEdits — multi-op batches', () => {
  const original = 'one\ntwo\nthree\nfour\nfive\n'

  it('applies mixed ops in one call', () => {
    const { content, changed } = applyEdits(original, [
      replace(original, 2, ['TWO']),
      append(original, 4, ['four-and-a-half']),
      prepend(original, 1, ['zero']),
      replace(original, 5, [], 5),
    ], OPTS)
    expect(content).toBe('zero\none\nTWO\nthree\nfour\nfour-and-a-half\n')
    expect(changed).toBe(true)
  })

  it('is order-independent for non-overlapping ops', () => {
    const opsA = [replace(original, 1, ['ONE']), append(original, 5, ['six'])]
    const opsB = [append(original, 5, ['six']), replace(original, 1, ['ONE'])]
    expect(applyEdits(original, opsA, OPTS).content).toBe(applyEdits(original, opsB, OPTS).content)
  })

  it('rejects overlapping ops', () => {
    expect(code(() => applyEdits(original, [replace(original, 2, ['X'], 3), append(original, 3, ['y'])], OPTS)))
      .toBe('HASHLINE_INVALID_PATCH')
    expect(code(() => applyEdits(original, [append(original, 3, ['y']), prepend(original, 3, ['z'])], OPTS)))
      .toBe('HASHLINE_INVALID_PATCH')
  })

  it('allows adjacent ops', () => {
    const { content } = applyEdits(original, [replace(original, 1, ['ONE']), append(original, 2, ['x'])], OPTS)
    expect(content).toBe('ONE\ntwo\nx\nthree\nfour\nfive\n')
  })
})

describe('applyEdits — anchor validation', () => {
  const original = 'a\nb\nc\nd\n'

  it('rejects a stale anchor with HASHLINE_STALE_ANCHOR', () => {
    // pos hash computed from a different file shape: the anchor no longer
    // matches the line it names.
    const stale = { op: 'replace', pos: anchor('x\na\nb\nc\nd\n', 2), lines: ['A'] }
    expect(code(() => applyEdits(original, [stale], OPTS))).toBe('HASHLINE_STALE_ANCHOR')
    // A correct anchor still applies.
    const shifted = replace(original, 1, ['A'])
    expect(code(() => applyEdits(original, [shifted], OPTS))).toBeUndefined()
  })

  it('rejects an out-of-range anchor as stale', () => {
    const op = { op: 'replace', pos: '99#KT', lines: ['A'] }
    expect(code(() => applyEdits(original, [op], OPTS))).toBe('HASHLINE_STALE_ANCHOR')
  })

  it('reports ambiguity when the hash matches elsewhere', () => {
    // 'a a a a': interior lines 2 and 3 share the (a,a,a) context triple.
    const content = 'a\na\na\na\n'
    const hashes = computeHashes(splitLines(content), 2)
    expect(hashes[1]).toBe(hashes[2])
    // Anchor line 4's edge hash onto line 2: mismatch at pos, but the hash
    // exists at line 4 → ambiguous, never relocated.
    const op = { op: 'replace', pos: `2#${hashes[3]}`, lines: ['X'] }
    expect(code(() => applyEdits(content, [op], OPTS))).toBe('HASHLINE_AMBIGUOUS')
  })

  it('rejects a patch containing display prefixes or diff markers', () => {
    const op = replace(original, 2, ['  2#KT:b', '@@ -1 +1 @@', '+++ header'])
    expect(code(() => applyEdits(original, [op], OPTS))).toBe('HASHLINE_INVALID_PATCH')
  })

  it('requires end at or after pos', () => {
    const op = { op: 'replace', pos: anchor(original, 3), end: anchor(original, 1), lines: ['X'] }
    expect(() => applyEdits(original, [op], OPTS)).toThrow(/end must be at or after pos/u)
  })
})

describe('applyEdits — replace_text', () => {
  const original = 'const x = 1\nconst y = 2\n'

  it('replaces a unique substring', () => {
    const { content, changed } = applyEdits(original, [{ op: 'replace_text', old_text: 'const x', new_text: 'let x' }], OPTS)
    expect(content).toBe('let x = 1\nconst y = 2\n')
    expect(changed).toBe(true)
  })

  it('rejects a missing substring as stale', () => {
    expect(code(() => applyEdits(original, [{ op: 'replace_text', old_text: 'gone', new_text: 'x' }], OPTS)))
      .toBe('HASHLINE_STALE_ANCHOR')
  })

  it('rejects a non-unique substring as ambiguous', () => {
    expect(code(() => applyEdits(original, [{ op: 'replace_text', old_text: 'const', new_text: 'let' }], OPTS)))
      .toBe('HASHLINE_AMBIGUOUS')
  })

  it('is disabled when the config disallows it', () => {
    expect(() => applyEdits(original, [{ op: 'replace_text', old_text: 'const x', new_text: 'let x' }], { ...OPTS, replaceText: false }))
      .toThrow(/replace_text is disabled/u)
  })
})

describe('applyEdits — fresh anchor ranges', () => {
  const original = 'one\ntwo\nthree\nfour\nfive\n'

  it('covers the changed region with context on final coordinates', () => {
    const { anchorsRange } = applyEdits(original, [replace(original, 3, ['THREE'])], OPTS)
    expect(anchorsRange).toEqual({ from: 2, to: 4 })
  })

  it('clamps at the top and bottom of the file', () => {
    expect(applyEdits(original, [replace(original, 1, ['ONE'])], OPTS).anchorsRange).toEqual({ from: 1, to: 2 })
    expect(applyEdits(original, [{ op: 'append', lines: ['six'] }], OPTS).anchorsRange).toEqual({ from: 5, to: 6 })
  })

  it('uses final coordinates when the edit changes line counts', () => {
    const { content, anchorsRange } = applyEdits(original, [append(original, 2, ['two-b', 'two-c'])], OPTS)
    expect(content).toBe('one\ntwo\ntwo-b\ntwo-c\nthree\nfour\nfive\n')
    // Changed final lines 3-5 (indices 2-4), expanded by one for context → 2-6.
    expect(anchorsRange).toEqual({ from: 2, to: 6 })
  })
})

describe('applyEdits — shape validation', () => {
  it('rejects unknown ops', () => {
    expect(() => applyEdits('a\n', [{ op: 'swap', pos: '1#KT', lines: [] }], OPTS)).toThrow(/unknown edit op/u)
  })

  it('requires non-empty lines for append/prepend', () => {
    expect(() => applyEdits('a\n', [{ op: 'append', pos: '1#KT', lines: [] }], OPTS)).toThrow(/at least one line/u)
  })

  it('requires an anchor for replace', () => {
    expect(() => applyEdits('a\n', [{ op: 'replace', lines: ['x'] }], OPTS)).toThrow(/pos is required/u)
  })
})
