/**
 * Client half of `dsh-tool-hashline`: renders the read / grep / details tool
 * cards in the web GUI as `LINE#HASH: content`, the same anchors the model
 * sees. Mounted only in sessions whose composition includes this plugin (the
 * `hashline` preset), because the `tool.call.toolview` and
 * `conversation.details.tool` slots are session-scoped.
 *
 * Framing: this module becomes `lib/client.js` wrapped by
 * `scripts/build-client.mjs` in `window.__ModuleLoader__.load({ id, factory })`
 * and registers under the package loader id (`dsh-tool-hashline`). `React`,
 * `ctx`, and `styles` are client-platform builtins; no external require is
 * needed, so the bundle is self-contained.
 * @module dsh-tool-hashline/client
 */

import { formatHashlineGrepCard, formatHashlineReadCard } from './card.ts'

/** Ambient globals injected by the client loader (not bundled). */
declare const React: any
declare const styles: { insert(css: string): () => void }

/** Run-scoped card styles. Neutral monospace, works in both themes. */
const HASHLINE_CSS = `
.hashline-card {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
  max-height: 420px;
  margin: 4px 0;
  padding: 8px 10px;
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.08);
}
.hashline-card-title { font-size: 12px; font-weight: 600; line-height: 1.6; }
.hashline-tool-view { padding: 2px 4px; }
.hashline-generic {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
`

// ---- Block shapes (the subset of ToolCallBlock this UI reads) ----

interface ContentBlock { type: string; text?: string }

interface ToolResultNodeLike {
  kind: 'tool-result'
  call?: { name: string; argsRaw: string } | null
  content: readonly ContentBlock[]
  isError: boolean
  error?: { name?: string; code?: string } | undefined
  meta?: unknown
}

interface RunningToolCallLike {
  name: string
  call?: { name: string; argsRaw: string } | null
}

type BlockLike = ToolResultNodeLike | RunningToolCallLike

/** A settled tool-result node carries `kind`; a still-running call does not. */
function isSettled(block: unknown): block is ToolResultNodeLike {
  return typeof block === 'object' && block !== null && 'kind' in block
}

function toolNameOf(block: BlockLike): string {
  if ('name' in block && typeof block.name === 'string') return block.name
  return block.call?.name ?? 'tool'
}

function pathArg(raw: string | undefined): string {
  if (raw === undefined) return ''
  try {
    const parsed = JSON.parse(raw) as { file_path?: unknown }
    return typeof parsed.file_path === 'string' ? parsed.file_path : ''
  } catch {
    return ''
  }
}

function argsText(block: BlockLike): string {
  const raw = block.call?.argsRaw
  if (raw === undefined || raw === null || raw === '') return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function contentText(block: ToolResultNodeLike): string {
  const parts: string[] = []
  for (const content of block.content) {
    if (content.type === 'text' && content.text !== undefined) parts.push(content.text)
    else parts.push(JSON.stringify(content))
  }
  if (parts.length === 0 && block.error) parts.push(`${block.error.name ?? 'Error'}: ${block.error.code ?? ''}`)
  return parts.join('\n')
}

function isReadMeta(meta: unknown): meta is { path: string; offset: number; lines: { number: number; hash: string; text: string }[]; totalLines?: number } {
  if (typeof meta !== 'object' || meta === null) return false
  const lines = (meta as { lines?: unknown }).lines
  return Array.isArray(lines) && (lines as unknown[]).every((l) => {
    const o = l as { number?: unknown; hash?: unknown; text?: unknown }
    return typeof o === 'object' && o !== null && typeof o.number === 'number' && typeof o.hash === 'string' && typeof o.text === 'string'
  })
}

function isGrepMeta(meta: unknown): meta is { files: { path: string; matches: { lineNumber: number; line: string }[] }[]; truncated: boolean; total: number } {
  if (typeof meta !== 'object' || meta === null) return false
  const files = (meta as { files?: unknown }).files
  return Array.isArray(files) && (files as unknown[]).every((f) => {
    const o = f as { path?: unknown; matches?: unknown }
    return typeof o === 'object' && o !== null && typeof o.path === 'string' && Array.isArray(o.matches)
  })
}

// ---- Generic fallback (the keyed/single replacement must still render well) ----

function GenericView(props: { title: string; body?: string }): any {
  return React.createElement(
    'div',
    { className: 'hashline-tool-view' },
    React.createElement('div', { className: 'hashline-card-title' }, props.title),
    props.body === undefined || props.body === '' ? null
      : React.createElement('pre', { className: 'hashline-generic' }, props.body),
  )
}

/** The hashline read card: `N#HASH: content` from `block.meta.lines`. */
function ReadToolView(owner: { block: unknown }): any {
  const block = owner.block as unknown
  if (!isSettled(block)) {
    return GenericView({ title: `Read ${pathArg((block as RunningToolCallLike).call?.argsRaw) || 'file'}` })
  }
  if (block.isError) return GenericView({ title: 'Read failed', body: contentText(block) })
  if (isReadMeta(block.meta)) {
    return React.createElement('pre', { className: 'hashline-card' }, formatHashlineReadCard(block.meta))
  }
  return GenericView({ title: `Read ${pathArg(block.call?.argsRaw) || 'file'}`, body: contentText(block) })
}

/** The hashline grep card: per-file `N#HASH:` matches from `block.meta.files`. */
function GrepToolView(owner: { block: unknown }): any {
  const block = owner.block as unknown
  if (!isSettled(block)) return GenericView({ title: 'Search' })
  if (block.isError) return GenericView({ title: 'Search failed', body: contentText(block) })
  if (isGrepMeta(block.meta)) {
    return React.createElement('pre', { className: 'hashline-card' }, formatHashlineGrepCard(block.meta))
  }
  return GenericView({ title: 'Search', body: contentText(block) })
}

/**
 * Details panel takeover (single seat): hashline read/grep get the `N#HASH:`
 * card, every other tool gets a compact generic renderer.
 */
function DetailsToolView(owner: { block: unknown }): any {
  const block = owner.block as unknown
  if (!isSettled(block)) return GenericView({ title: toolNameOf(block as BlockLike) })
  if (block.isError) return GenericView({ title: `${toolNameOf(block)} failed`, body: contentText(block) })
  const meta = block.meta
  if (isReadMeta(meta)) return React.createElement('pre', { className: 'hashline-card' }, formatHashlineReadCard(meta))
  if (isGrepMeta(meta)) return React.createElement('pre', { className: 'hashline-card' }, formatHashlineGrepCard(meta))
  const path = pathArg(block.call?.argsRaw)
  const title = `${toolNameOf(block)}${path === '' ? '' : ` ${path}`}`
  const body = [argsText(block as BlockLike), contentText(block)].filter((s) => s !== '').join('\n')
  return GenericView({ title, body })
}

export const name = 'tool-hashline-client'

export function apply(clientCtx: any): void {
  const slots = clientCtx.get('slots')
  if (slots === undefined) return
  styles.insert(HASHLINE_CSS)
  // Replace the shipped read/grep tool cards for this session's chat rows.
  slots.inject('tool.call.toolview', function* () {
    yield slots.register({ name: 'tool.call.toolview', key: 'read' }, ReadToolView)
    yield slots.register({ name: 'tool.call.toolview', key: 'grep' }, GrepToolView)
  })
  // Details panel: whole-seat takeover so read/grep also render N#HASH there.
  slots.inject('conversation.details.tool', () => slots.register(
    { name: 'conversation.details.tool' },
    DetailsToolView,
  ))
}
