/**
 * Unit tests for the web-card formatters: the read card renders `N#HASH:
 * content` aligned to the file's line-number width with the same footers the
 * model sees; the grep card renders per-file `N#HASH:` matches with a summary.
 */

import { describe, expect, it } from 'vitest'
import { formatHashlineGrepCard, formatHashlineReadCard } from '../src/card.ts'

describe('formatHashlineReadCard', () => {
  it('renders path, aligned N#HASH lines, and the end-of-file footer', () => {
    const out = formatHashlineReadCard({
      path: '/p/f.ts',
      offset: 1,
      lines: [
        { number: 1, hash: 'XY', text: 'function a() {' },
        { number: 2, hash: 'ZZ', text: '}' },
      ],
      totalLines: 2,
    })
    expect(out).toBe('/p/f.ts\n1#XY: function a() {\n2#ZZ: }\n(End of file - total 2 lines)')
  })

  it('pads line numbers to the widest line in the window', () => {
    const out = formatHashlineReadCard({
      path: '/p/f.ts',
      offset: 11,
      lines: [{ number: 11, hash: 'AB', text: 'x' }],
      totalLines: 100,
    })
    expect(out.startsWith('/p/f.ts\n11#AB: x')).toBe(true)
  })

  it('renders the showing-window footer for a partial read', () => {
    const out = formatHashlineReadCard({
      path: '/p/f.ts',
      offset: 6,
      lines: [{ number: 6, hash: 'YX', text: 'x' }],
      totalLines: 100,
    })
    expect(out).toContain('(Showing lines 6-6 of 100)')
  })

  it('renders the capped footer when totalLines is absent', () => {
    const out = formatHashlineReadCard({ path: '/p/f.ts', offset: 1, lines: [], totalLines: undefined })
    expect(out).toContain('(Output capped. Showing lines 1-0.)')
  })
})

describe('formatHashlineGrepCard', () => {
  it('renders per-file N#HASH matches (line carries #HASH:) with alignment and summary', () => {
    const out = formatHashlineGrepCard({
      files: [
        { path: 'a.ts', matches: [{ lineNumber: 2, line: '#MM: const app = 2' }, { lineNumber: 12, line: '#QQ: x' }] },
      ],
      truncated: false,
      total: 2,
    })
    expect(out).toBe('a.ts:\n 2#MM: const app = 2\n12#QQ: x\n\n2 matches in 1 file.')
  })

  it('reports truncation in the summary', () => {
    const out = formatHashlineGrepCard({
      files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: '#KT: y' }] }],
      truncated: true,
      total: 50,
    })
    expect(out).toContain('50 matches in 1 file (truncated).')
  })

  it('is total when there are no files (summary only)', () => {
    expect(formatHashlineGrepCard({ files: [], truncated: false, total: 0 })).toBe('0 matches in 0 files.')
  })
})
