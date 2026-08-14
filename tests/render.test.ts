import { describe, expect, it } from 'vitest'
import { buildTaggedWindow, formatReadOutput, truncateDisplayLine } from '../src/render.ts'
import { hashLine, parseAnchor } from '../src/hash.ts'

const OPTS = {
  offset: 1,
  limit: 50,
  maxLineLength: 200,
  maxBytes: 51200,
  hashLength: 2,
}

function stream(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

describe('buildTaggedWindow', () => {
  it('tags every window line with number and content hash', async () => {
    const source = 'function hello() {\n  return 1\n}\n'
    const { lines, totalLines, cappedByBytes } = await buildTaggedWindow(source, OPTS)
    expect(totalLines).toBe(3)
    expect(cappedByBytes).toBe(false)
    expect(lines.map((l) => l.number)).toEqual([1, 2, 3])
    expect(lines.map((l) => l.text)).toEqual(['function hello() {', '  return 1', '}'])
    // Hash must match the context-triple computation.
    expect(lines[0]!.hash).toBe(hashLine('', 'function hello() {', '  return 1', 2))
    expect(lines[1]!.hash).toBe(hashLine('function hello() {', '  return 1', '}', 2))
  })

  it('honors offset and limit', async () => {
    const source = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    const { lines, totalLines } = await buildTaggedWindow(source, { ...OPTS, offset: 4, limit: 3 })
    expect(totalLines).toBe(10)
    expect(lines.map((l) => l.number)).toEqual([4, 5, 6])
  })

  it('computes hashes from the full line, not the truncated display text', async () => {
    const longLine = 'x'.repeat(500)
    const source = `a\n${longLine}\nc`
    const { lines } = await buildTaggedWindow(source, { ...OPTS, maxLineLength: 10 })
    expect(lines[1]!.text).toBe(`${'x'.repeat(10)}... (line truncated to 10 chars)`)
    expect(lines[1]!.hash).toBe(hashLine('a', longLine, 'c', 2))
  })

  it('stops at the byte cap and omits totalLines', async () => {
    const source = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
    const { lines, totalLines, cappedByBytes } = await buildTaggedWindow(source, { ...OPTS, maxBytes: 25 })
    expect(cappedByBytes).toBe(true)
    expect(totalLines).toBeUndefined()
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThan(100)
  })

  it('counts all lines when the cap never fires', async () => {
    const source = 'a\nb\nc' // no trailing newline
    const { lines, totalLines } = await buildTaggedWindow(source, OPTS)
    expect(totalLines).toBe(3)
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('handles an empty file', async () => {
    const { lines, totalLines, cappedByBytes } = await buildTaggedWindow('', OPTS)
    expect(lines).toEqual([])
    expect(totalLines).toBe(0)
    expect(cappedByBytes).toBe(false)
  })

  it('normalizes CRLF input', async () => {
    const { lines, totalLines } = await buildTaggedWindow('a\r\nb\r\nc', OPTS)
    expect(totalLines).toBe(3)
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('matches the string path when reading the same content streamed in odd chunks', async () => {
    const content = 'alpha\nbeta\ngamma\ndelta\n'
    const [whole, chunked] = await Promise.all([
      buildTaggedWindow(content, OPTS),
      buildTaggedWindow(stream(['al', 'pha\nbe', 'ta\nga', 'mma\ndelta\n']), OPTS),
    ])
    expect(chunked).toEqual(whole)
  })

  it('uses the requested-window width for line-number padding', async () => {
    const source = 'x\ny\nz\n'
    const { lines } = await buildTaggedWindow(source, { ...OPTS, offset: 1, limit: 2000 })
    const first = formatReadOutput({
      path: '/f', offset: 1, lines, totalLines: 3, raw: false, cappedByBytes: false, padWidth: 4,
    })
    expect(first).toContain('   1#')
  })
})

describe('truncateDisplayLine', () => {
  it('leaves short lines alone and truncates long ones with the suffix', () => {
    expect(truncateDisplayLine('short', 10)).toBe('short')
    expect(truncateDisplayLine('123456789012345', 10))
      .toBe('1234567890... (line truncated to 10 chars)')
  })
})

describe('formatReadOutput', () => {
  const lines = [
    { number: 1, hash: hashLine('', 'a', 'b', 2), text: 'a' },
    { number: 2, hash: hashLine('a', 'b', 'c', 2), text: 'b' },
    { number: 3, hash: hashLine('b', 'c', '', 2), text: 'c' },
  ]

  it('renders the tagged envelope with the continue footer', () => {
    const out = formatReadOutput({
      path: '/p/f.ts', offset: 1, lines, totalLines: 10, raw: false, cappedByBytes: false, padWidth: 1,
    })
    expect(out).toContain('<path>/p/f.ts</path>')
    expect(out).toContain('<type>file</type>')
    expect(out).toContain(`1#${lines[0]!.hash}:a`)
    expect(out).toContain('(Showing lines 1-3 of 10. Use offset=4 to continue.)')
    expect(out).toMatch(/<content>\n[\s\S]*\n\n\(Showing lines[\s\S]*\n<\/content>$/u)
  })

  it('renders the end-of-file footer when the window reaches EOF', () => {
    const out = formatReadOutput({
      path: '/p/f.ts', offset: 2, lines: lines.slice(1), totalLines: 3, raw: false, cappedByBytes: false, padWidth: 1,
    })
    expect(out).toContain('(End of file - total 3 lines)')
  })

  it('renders the capped footer when the byte cap fired', () => {
    const out = formatReadOutput({
      path: '/p/f.ts', offset: 1, lines, totalLines: undefined, raw: false, cappedByBytes: true, padWidth: 1,
    })
    expect(out).toContain('(Output capped. Showing lines 1-3. Use offset=4 to continue.)')
  })

  it('renders raw mode without tags', () => {
    const out = formatReadOutput({
      path: '/p/f.ts', offset: 1, lines, totalLines: 3, raw: true, cappedByBytes: false, padWidth: 1,
    })
    expect(out).not.toContain('#')
    expect(out).toContain('<content>\na\nb\nc')
  })

  it('renders an empty file', () => {
    const out = formatReadOutput({
      path: '/p/e.ts', offset: 1, lines: [], totalLines: 0, raw: false, cappedByBytes: false, padWidth: 1,
    })
    expect(out).toContain('(End of file - total 0 lines)')
  })

  it('keeps every displayed tag parseable back into an anchor', () => {
    const out = formatReadOutput({
      path: '/p/f.ts', offset: 1, lines, totalLines: 3, raw: false, cappedByBytes: false, padWidth: 1,
    })
    for (const match of out.matchAll(/^(\d+)#([A-Z]{2,4}):/gmu)) {
      expect(parseAnchor(`${match[1]}#${match[2]}`)).not.toBeUndefined()
    }
  })
})
