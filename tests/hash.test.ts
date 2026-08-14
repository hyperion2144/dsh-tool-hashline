import { describe, expect, it } from 'vitest'
import {
  HASH_ALPHABET,
  assertHashLength,
  affectedRange,
  computeHashes,
  fnv1a32,
  formatAnchor,
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
      const hash = hashLine('a', 'b', 'c', length)
      expect(hash).toHaveLength(length)
      expect([...hash].every((ch) => HASH_ALPHABET.includes(ch))).toBe(true)
    }
  })

  it('is context-sensitive: neighbors change the hash', () => {
    const base = hashLine('x', 'body', 'y', 2)
    expect(hashLine('z', 'body', 'y', 2)).not.toBe(base)
    expect(hashLine('x', 'body', 'z', 2)).not.toBe(base)
  })

  it('hashes identical lines differently in different contexts', () => {
    const lines = ['if (a) {', '}', 'if (b) {', '}', '}']
    const hashes = computeHashes(lines, 2)
    // Lines 2 and 5 are both '}' but have different neighbors.
    expect(hashes[1]).not.toBe(hashes[4])
    // Lines 4 and 5 are adjacent '}' lines sharing one neighbor; contexts
    // still differ ('}' vs 'if (b) {' as prev), so they must differ too.
    expect(hashes[3]).not.toBe(hashes[4])
  })

  it('treats the first and last lines as having empty neighbors', () => {
    const hashes = computeHashes(['a', 'b'], 2)
    expect(hashes[0]).toBe(hashLine('', 'a', 'b', 2))
    expect(hashes[1]).toBe(hashLine('a', 'b', '', 2))
  })

  it('invalidates only N-1..N+1 when line N changes', () => {
    const before = computeHashes(['l1', 'l2', 'l3', 'l4', 'l5', 'l6'], 2)
    const after = computeHashes(['l1', 'l2', 'CHANGED', 'l4', 'l5', 'l6'], 2)
    for (let i = 0; i < 6; i++) {
      const expectedStale = i >= 1 && i <= 3 // indices 1..3 = lines 2..4
      expect(after[i] === before[i]).toBe(!expectedStale)
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

describe('affectedRange', () => {
  it('expands one line in both directions and clamps', () => {
    expect(affectedRange(3, 3, 10)).toEqual({ from: 2, to: 4 })
    expect(affectedRange(1, 1, 10)).toEqual({ from: 1, to: 2 })
    expect(affectedRange(10, 10, 10)).toEqual({ from: 9, to: 10 })
    expect(affectedRange(1, 1, 1)).toEqual({ from: 1, to: 1 })
  })

  it('covers inclusive ranges', () => {
    expect(affectedRange(4, 7, 20)).toEqual({ from: 3, to: 8 })
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
