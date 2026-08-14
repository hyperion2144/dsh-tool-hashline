/**
 * Hash-anchored read/edit tool plugin for DeepSeek Harness. Registers the
 * hashline `read` and `edit` tools and their prompt guidance; composition is
 * a preset-plane swap (see PLAN.md) — the preset mounts this plugin in place
 * of `tool-fs`, and scope layering shadows the global read/edit.
 * @module dsh-tool-hashline
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertHashLength, DEFAULT_HASH_LENGTH } from './hash.ts'
import { applyEditTool } from './edit.ts'
import { applyReadTool, type ReadToolCaps } from './read.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-hashline'

/** Services required by the hashline tool suite. */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize: number
  /** Characters per line hash (2-4); longer reduces false-accept risk. */
  hashLength: number
  /** Allow the literal `replace_text` op in edit (off by default: anchor-only). */
  replaceText: boolean
}

export const Config: z<Config> = z.object({
  readLimit: z.number().default(2000),
  readMaxLineLength: z.number().default(2000),
  readMaxBytes: z.number().default(51200),
  readStreamMinSize: z.number().default(10485760),
  hashLength: z.natural().min(2).max(4).default(DEFAULT_HASH_LENGTH),
  replaceText: z.boolean().default(false),
})

/** Every read cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-hashline: ${name} must be a positive integer`)
  }
}

/**
 * Register the hashline `read` and `edit` tools and their guidance. All
 * registrations are effects scoped to the mounting context, so a preset-layer
 * mount shadows the global `tool-fs` tools by name.
 */
export function apply(ctx: Context, config: Config): void {
  assertPositiveInteger('readLimit', config.readLimit)
  assertPositiveInteger('readMaxLineLength', config.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', config.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', config.readStreamMinSize)
  assertHashLength(config.hashLength)
  applyReadTool(ctx, {
    limit: config.readLimit,
    maxLineLength: config.readMaxLineLength,
    maxBytes: config.readMaxBytes,
    streamMinSize: config.readStreamMinSize,
    hashLength: config.hashLength,
  })
  applyEditTool(ctx, {
    hashLength: config.hashLength,
    replaceText: config.replaceText,
  })
}
