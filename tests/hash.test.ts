import { describe, expect, it } from 'vitest'
import {
  HASH_ALPHABET,
  assertHashLength,
  affectedRange,
  computeHashes,
  fnv1a32,
  formatAnchor,
  formatHashLabel,
  formatTaggedLine,
  hashLine,
  mergeRanges,
  parseAnchor,
  splitLines,
} from '../src/hash.ts'

const encoder = new TextEncoder()

describe('fnv1a32', () => {
  it('is deterministic and matches the reference vector', () => {
    expect(fnv1a32(encoder.encode(''))).toBe(0x811c9dc5)
    expect(fnv1a32(encoder.encode('a'))).toBe(0xe40c292c)
    expect(fnv1a32(encoder.encode('hello'))).toBe(0x4f9f2cab)
  })

  it('is byte-based (UTF-8), not code-unit based', () => {
    // 'é' is two bytes in UTF-8; the hash must differ from 'e'.
    expect(fnv1a32(encoder.encode('é'))).not.toBe(fnv1a32(encoder.encode('e')))
  })
})

describe('assertHashLength', () => {
  it('accepts 2, 3, 4', () => {
    for (const n of [2, 3, 4]) expect(() => assertHashLength(n)).not.toThrow()
  })

  it('rejects out-of-range and non-integer values', () => {
    for (const bad of [0, 1, 5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertHashLength(bad)).toThrow(/hashLength/)
    }
  })
})

describe('hashLine / computeHashes', () => {
  it('produces hashes from the configured alphabet and length', () => {
    for (const length of [2, 3, 4]) {
      const hash = hashLine('b', length)
      expect(hash).toHaveLength(length)
      expect([...hash].every((ch) => HASH_ALPHABET.includes(ch))).toBe(true)
    }
  })

  it('is content-only: the same line always hashes the same, wherever it appears', () => {
    const identical = hashLine('body', 2)
    expect(hashLine('body', 2)).toBe(identical)
    // Different content (even the same text padded) hashes differently.
    expect(hashLine('other', 2)).not.toBe(identical)
    const lines = ['if (a) {', '}', 'if (b) {', '}', '}']
    const hashes = computeHashes(lines, 2)
    // Lines 2 and 5 are both '}' and therefore share a hash — the line NUMBER
    // (not the hash) is what disambiguates them in an anchor.
    expect(hashes[1]).toBe(hashes[4])
  })

  it('distinguishes different content within one line', () => {
    expect(hashLine('x', 2)).not.toBe(hashLine('y', 2))
    expect(hashLine('function a', 2)).not.toBe(hashLine('function b', 2))
  })

  it('is content-stable: changing an unrelated line never changes this line\'s hash', () => {
    const before = computeHashes(['l1', 'l2', 'l3', 'l4', 'l5', 'l6'], 2)
    const after = computeHashes(['l1', 'l2', 'CHANGED', 'l4', 'l5', 'l6'], 2)
    // Only the changed line's own hash differs; every untouched line keeps its
    // exact hash (so callers can reuse oldHashes at shifted line numbers).
    const expectation = ['same', 'same', 'diff', 'same', 'same', 'same']
    for (let i = 0; i < 6; i++) {
      const expectedDiff = expectation[i] === 'diff'
      expect(after[i] === before[i]).toBe(!expectedDiff)
    }
  })
})

describe('splitLines', () => {
  it('splits LF and CRLF, stripping the CR and trailing empty line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('a\rb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
  })

  it('handles mixed endings deterministically', () => {
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('anchor format/parse', () => {
  it('round-trips', () => {
    const anchor = { line: 42, hash: 'KT' }
    expect(parseAnchor(formatAnchor(anchor))).toEqual(anchor)
  })

  it('parses valid anchors with any supported hash length', () => {
    expect(parseAnchor('1#ZP')).toEqual({ line: 1, hash: 'ZP' })
    expect(parseAnchor('999#ZPMQ')).toEqual({ line: 999, hash: 'ZPMQ' })
    expect(parseAnchor('10#ZPM')).toEqual({ line: 10, hash: 'ZPM' })
  })

  it('rejects malformed anchors', () => {
    for (const bad of [
      '',
      '8',
      '#KT',
      '8#',
      '8#kt', // lowercase not in alphabet
      '8#K', // 1-char hash
      '8#KT123', // 5-char hash
      '0#KT', // line numbers are 1-based
      '-1#KT',
      '8 KT',
      '8#KT extra',
    ]) {
      expect(parseAnchor(bad)).toBeUndefined()
    }
  })
})

describe('formatTaggedLine', () => {
  it('left-pads line numbers to the file width', () => {
    expect(formatTaggedLine({ line: 8, hash: 'VR' }, 'function hello() {', 2))
      .toBe(' 8#VR:function hello() {')
    expect(formatTaggedLine({ line: 108, hash: 'KT' }, '}', 3))
      .toBe('108#KT:}')
  })

  it('keeps the tag readable for single-digit widths', () => {
    expect(formatTaggedLine({ line: 1, hash: 'ZP' }, 'x', 1)).toBe('1#ZP:x')
  })
})

describe('formatHashLabel', () => {
  it('renders "#HASH: text" for the web card line column', () => {
    expect(formatHashLabel({ line: 8, hash: 'VR' }, 'function hello() {')).toBe('#VR: function hello() {')
  })

  it('is independent of the line number — the gutter owns the number', () => {
    expect(formatHashLabel({ line: 108, hash: 'KT' }, 'x')).toBe('#KT: x')
  })
})

describe('affectedRange', () => {
  it('covers exactly the changed lines, clamping to the file', () => {
    expect(affectedRange(3, 3, 10)).toEqual({ from: 3, to: 3 })
    expect(affectedRange(1, 1, 10)).toEqual({ from: 1, to: 1 })
    expect(affectedRange(10, 10, 10)).toEqual({ from: 10, to: 10 })
    expect(affectedRange(1, 1, 1)).toEqual({ from: 1, to: 1 })
  })

  it('covers inclusive ranges without neighbor expansion', () => {
    expect(affectedRange(4, 7, 20)).toEqual({ from: 4, to: 7 })
  })
})

describe('mergeRanges', () => {
  it('merges overlapping and adjacent ranges', () => {
    expect(mergeRanges([
      { from: 5, to: 6 },
      { from: 2, to: 3 },
      { from: 4, to: 4 },
      { from: 9, to: 9 },
    ])).toEqual([
      { from: 2, to: 6 },
      { from: 9, to: 9 },
    ])
  })

  it('returns an empty list for no input', () => {
    expect(mergeRanges([])).toEqual([])
  })

  it('does not merge ranges with a gap', () => {
    expect(mergeRanges([{ from: 1, to: 2 }, { from: 4, to: 5 }]))
      .toEqual([{ from: 1, to: 2 }, { from: 4, to: 5 }])
  })
})
