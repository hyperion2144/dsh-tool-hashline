import { describe, expect, it } from 'vitest'
import {
  buildGrepArgv,
  displayPath,
  formatGrepFileSection,
  formatGrepSummary,
  formatHashlineRegion,
  groupMatches,
  linesOf,
  mergeRange,
  parseGrepArgs,
  parseRgMatchRecord,
} from '../src/grep-engine.ts'
import { computeHashes } from '../src/hash.ts'

describe('parseGrepArgs', () => {
  it('defaults context to 0, limit to 50, flags to false', () => {
    expect(parseGrepArgs({ pattern: 'foo' })).toEqual({ pattern: 'foo', ignoreCase: false, literal: false, context: 0, limit: 50 })
  })

  it('passes explicit values through', () => {
    expect(parseGrepArgs({ pattern: 'x', path: 'src', glob: '**/*.ts', ignore_case: true, literal: true, context: 3, limit: 10 }))
      .toEqual({ pattern: 'x', path: 'src', glob: '**/*.ts', ignoreCase: true, literal: true, context: 3, limit: 10 })
  })

  it('rejects empty pattern, blank path/glob, and out-of-range context/limit', () => {
    expect(() => parseGrepArgs({ pattern: '' })).toThrow(/pattern must be a non-empty string/u)
    expect(() => parseGrepArgs({ pattern: 'x', path: '  ' })).toThrow(/path must be a non-empty string/u)
    expect(() => parseGrepArgs({ pattern: 'x', glob: ' ' })).toThrow(/glob must be a non-empty string/u)
    expect(() => parseGrepArgs({ pattern: 'x', context: 6 })).toThrow(/context must be an integer/u)
    expect(() => parseGrepArgs({ pattern: 'x', limit: 201 })).toThrow(/limit must be an integer/u)
    expect(() => parseGrepArgs({ pattern: 'x', limit: 0 })).toThrow(/limit must be an integer/u)
  })
})

describe('buildGrepArgv', () => {
  it('always uses --json and puts the pattern behind --regexp=', () => {
    expect(buildGrepArgv(parseGrepArgs({ pattern: '-x' }))).toEqual(['--json', '--regexp=-x', '--', '.'])
  })

  it('assembles flags and the target path', () => {
    const argv = buildGrepArgv(parseGrepArgs({ pattern: 'p', path: 'src', glob: '*.ts', ignore_case: true, literal: true }))
    expect(argv).toEqual(['--json', '--ignore-case', '--fixed-strings', '--glob=*.ts', '--regexp=p', '--', 'src'])
  })
})

describe('parseRgMatchRecord', () => {
  it('parses a match record', () => {
    const line = JSON.stringify({ type: 'match', data: { path: { text: 'a.txt' }, line_number: 7, lines: { text: 'x' } } })
    expect(parseRgMatchRecord(line)).toEqual({ path: 'a.txt', lineNumber: 7 })
  })

  it('skips non-match records and malformed lines', () => {
    for (const line of [
      JSON.stringify({ type: 'begin', data: {} }),
      JSON.stringify({ type: 'end', data: {} }),
      JSON.stringify({ type: 'summary', data: {} }),
      'not json',
      '',
      JSON.stringify({ type: 'match', data: { path: { text: 'a' } } }),
      JSON.stringify({ type: 'match', data: { line_number: 1 } }),
    ]) {
      expect(parseRgMatchRecord(line)).toBeUndefined()
    }
  })
})

describe('mergeRange', () => {
  it('merges overlapping and adjacent ranges and keeps disjoint ones sorted', () => {
    const ranges: { from: number; to: number }[] = []
    mergeRange(ranges, { from: 5, to: 6 })
    mergeRange(ranges, { from: 2, to: 3 })
    mergeRange(ranges, { from: 4, to: 4 })
    mergeRange(ranges, { from: 9, to: 9 })
    expect(ranges).toEqual([{ from: 2, to: 6 }, { from: 9, to: 9 }])
  })
})

describe('formatHashlineRegion', () => {
  const lines = linesOf('alpha\nbeta\ngamma\ndelta\n')

  it('renders tagged lines with hashes over the full file context', () => {
    const region = formatHashlineRegion(lines, 2, 3, 2)
    const hashes = computeHashes(lines, 2)
    expect(region).toBe(`2#${hashes[1]}:beta\n3#${hashes[2]}:gamma`)
  })

  it('pads line numbers to the region width', () => {
    const ten = linesOf(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
    expect(formatHashlineRegion(ten, 9, 10, 2)).toContain(' 9#')
  })
})

describe('formatGrepFileSection', () => {
  const lines = linesOf('one\ntwo\nthree\nfour\nfive\nsix\n')

  it('merges context ranges and separates gaps with an ellipsis', () => {
    const section = formatGrepFileSection('f.txt', lines, [2, 6], 1, 2)
    expect(section).toContain('f.txt:')
    expect(section).toContain('1#')
    expect(section).toContain('3#') // context below match 2
    expect(section).toContain('6#')
    expect(section).toContain('    ...')
  })

  it('filters out-of-range match lines and returns undefined when none survive', () => {
    expect(formatGrepFileSection('f.txt', lines, [99], 0, 2)).toBeUndefined()
    expect(formatGrepFileSection('f.txt', lines, [99, 2], 0, 2)).toContain('2#')
  })

  it('emits anchors that verify against the file content', () => {
    const section = formatGrepFileSection('f.txt', lines, [4], 1, 2)
    const hashes = computeHashes(lines, 2)
    expect(section).toContain(`4#${hashes[3]}:four`)
  })
})

describe('groupMatches', () => {
  it('groups in first-seen file order and truncates at the limit', () => {
    const matches = [
      { path: 'b.txt', lineNumber: 1 },
      { path: 'a.txt', lineNumber: 2 },
      { path: 'b.txt', lineNumber: 3 },
      { path: 'c.txt', lineNumber: 4 },
    ]
    const limited = groupMatches(matches, 3)
    expect([...limited.byFile.keys()]).toEqual(['b.txt', 'a.txt'])
    expect(limited.byFile.get('b.txt')).toEqual([1, 3])
    expect(limited.seen).toBe(3)
    expect(limited.truncated).toBe(true)

    const full = groupMatches(matches, 10)
    expect(full.truncated).toBe(false)
    expect(full.seen).toBe(4)
  })
})

describe('formatGrepSummary and displayPath', () => {
  it('pluralizes and reports truncation', () => {
    expect(formatGrepSummary(1, 1, false, 50)).toBe('1 match in 1 file.')
    expect(formatGrepSummary(5, 2, true, 50)).toBe('5 matches in 2 files. (truncated at 50)')
  })

  it('strips the leading ./ from workdir-relative paths', () => {
    expect(displayPath('./src/a.ts')).toBe('src/a.ts')
    expect(displayPath('src/a.ts')).toBe('src/a.ts')
  })
})
