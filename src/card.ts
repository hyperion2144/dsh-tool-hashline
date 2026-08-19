/**
 * Pure formatting for the hashline web cards. Cordis-free and dependency-free
 * so the client bundle can inline it and vitest can cover it: a read card or a
 * grep card's display lines render as ` LINE#HASH: content`, the same anchor
 * format the model sees. The empty-input guards make the renderers total — a
 * card can never throw rendering.
 * @module dsh-tool-hashline/card
 */

/** One ready-to-display read line (the hash and text are clean). */
export interface CardReadLine {
  number: number
  hash: string
  text: string
}

/** The hashline read tool's persisted projection (`presentationMeta`). */
export interface CardReadMeta {
  path: string
  offset: number
  lines: CardReadLine[]
  totalLines?: number
}

/** One matched line inside a file group (grep meta `line` = `#HASH: content`). */
export interface CardGrepMatch {
  lineNumber: number
  line: string
}

/** One file's grouped matches. */
export interface CardGrepFile {
  path: string
  matches: CardGrepMatch[]
}

/** The hashline grep tool's persisted projection (`presentationMeta`). */
export interface CardGrepMeta {
  files: CardGrepFile[]
  truncated: boolean
  total: number
}

/** Render one line as `` `  8#VR:content` `` padded to `width`. */
function formatLine(number: number, hash: string, text: string, width: number): string {
  return `${String(number).padStart(width)}#${hash}: ${text}`
}

/**
 * The read card body: a header path line, the `N#HASH: content` lines (aligned
 * to the window's widest line number), and the same continue / EOF footer the
 * model-facing envelope uses.
 */
export function formatHashlineReadCard(meta: CardReadMeta): string {
  const endLine = meta.lines.at(-1)?.number ?? Math.max(0, meta.offset - 1)
  const width = Math.max(1, String(endLine).length)
  const body = meta.lines
    .map(({ number, hash, text }) => formatLine(number, hash, text, width))
    .join('\n')
  let footer: string
  if (meta.totalLines === undefined) {
    footer = `(Output capped. Showing lines ${meta.offset}-${endLine}.)`
  } else if (endLine >= meta.totalLines) {
    footer = `(End of file - total ${meta.totalLines} lines)`
  } else {
    footer = `(Showing lines ${meta.offset}-${endLine} of ${meta.totalLines})`
  }
  return `${meta.path}\n${body}\n${footer}`
}

/**
 * The grep card body: per-file headers with `N#HASH: content` matches (line
 * numbers aligned within each file), dashed separators, and a summary line.
 */
export function formatHashlineGrepCard(meta: CardGrepMeta): string {
  const parts: string[] = []
  for (const file of meta.files) {
    const width = Math.max(
      1,
      String(file.matches.at(-1)?.lineNumber ?? 1).length,
    )
    parts.push(`${file.path}:`)
    for (const match of file.matches) {
      // grep meta `line` already begins with `#HASH: content`.
      parts.push(`${String(match.lineNumber).padStart(width)}${match.line}`)
    }
  }
  const fileNoun = meta.files.length === 1 ? 'file' : 'files'
  const summary = meta.truncated
    ? `${meta.total} matches in ${meta.files.length} ${fileNoun} (truncated).`
    : `${meta.total} matches in ${meta.files.length} ${fileNoun}.`
  return parts.join('\n') === '' ? summary : `${parts.join('\n')}\n\n${summary}`
}
