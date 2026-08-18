/**
 * Structured hashline failure codes. Carried on HarnessError so the tool
 * registry exposes `{ name, code }` on isError results, letting retry/policy
 * layers branch without parsing messages — the same convention as FsError.
 * @module dsh-tool-hashline/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

export type HashlineErrorCode =
  | 'HASHLINE_STALE_ANCHOR'
  | 'HASHLINE_AMBIGUOUS'
  | 'HASHLINE_INVALID_PATCH'
  | 'HASHLINE_NOOP_LOOP'
  | 'HASHLINE_EDIT_LOCKED'

/** Stable, machine-routable hashline failure. */
export class HashlineError extends HarnessError {
  override readonly code: HashlineErrorCode

  constructor(message: string, code: HashlineErrorCode) {
    super(message, code)
    this.name = 'HashlineError'
    this.code = code
  }
}
