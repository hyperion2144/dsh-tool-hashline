/**
 * Unit tests for the sandbox-aware edit controller: standing-policy
 * resolution, escalation arg validation + approval routing, denial mapping
 * (duck-typed, identity-preserving), and the unconfined composition.
 */

import { describe, expect, it } from 'vitest'
import { createEditSandbox, hasFsErrorCode } from '../src/sandbox.ts'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'

function ctxWith(get: (name: string) => unknown, sandboxMode?: SandboxMode) {
  return { fs: { sandboxMode }, get }
}

function policy(mode: SandboxExecutionPolicy['mode'], workspaceRoot = '/'): SandboxExecutionPolicy {
  return { mode, workspaceRoot }
}

const noSandbox = ctxWith(() => undefined, undefined)
const resolver = (standing: SandboxExecutionPolicy) => ctxWith(
  (name: string) => name === 'sandboxPolicy' ? { resolve: () => standing } : undefined,
  'workspace-write',
)

describe('creation', () => {
  it('is inert when the backend is not confined (no escalation schema)', () => {
    const s = createEditSandbox(noSandbox)
    expect(s.schemaFields()).toEqual({})
  })

  it('advertises escalation fields when the backend confines with a policy service', () => {
    const s = createEditSandbox(resolver(policy('workspace-write')))
    const fields = s.schemaFields()
    expect(fields.sandbox_permissions?.type).toBe('string')
    expect(fields.justification?.type).toBe('string')
  })

  it('degrades to no-policy writes when confined but the policy service is absent', () => {
    const s = createEditSandbox(ctxWith(() => undefined, 'workspace-write'))
    expect(s.schemaFields()).toEqual({})
  })
})

describe('resolvePolicy', () => {
  it('returns the session standing policy (full access) for the calling session', async () => {
    const s = createEditSandbox(resolver(policy('danger-full-access', '/wk')))
    const exec = { agent: { session: { id: 's1' } }, callId: 'c1' }
    await expect(s.resolvePolicy({}, exec)).resolves.toEqual(policy('danger-full-access', '/wk'))
    // An agent-less call still resolves the standing policy.
    await expect(s.resolvePolicy({}, { callId: 'c2' })).resolves.toEqual(policy('danger-full-access', '/wk'))
  })

  it('is undefined when no confining backend is mounted', async () => {
    const s = createEditSandbox(noSandbox)
    await expect(s.resolvePolicy({}, { callId: 'c' })).resolves.toBeUndefined()
  })

  it('rejects an escalation arg without its justification (and vice versa)', async () => {
    const s = createEditSandbox(resolver(policy('workspace-write')))
    await expect(s.resolvePolicy({ sandbox_permissions: 'danger-full-access' }, { callId: 'c' })).rejects.toThrow(/justification/u)
    await expect(s.resolvePolicy({ justification: 'need it' }, { callId: 'c' })).rejects.toThrow(/sandbox_permissions/u)
  })

  it('requires a sandbox policy service for an escalation request', async () => {
    const s = createEditSandbox(noSandbox)
    await expect(s.resolvePolicy({ sandbox_permissions: 'danger-full-access', justification: 'need it' }, { callId: 'c' }))
      .rejects.toThrow(/no sandbox policy/u)
  })

  it('routes an approved escalation onto the wider mode and stamps it on the call', async () => {
    const asks: unknown[] = []
    const s = createEditSandbox(ctxWith(
      (name: string) => {
        if (name === 'sandboxPolicy') return { resolve: () => policy('workspace-write') }
        if (name === 'approval') return { request: async (req: unknown) => { asks.push(req); return 'allowed-once' } }
        return undefined
      },
      'workspace-write',
    ))
    const exec = { agent: { session: { id: 's' } }, callId: 'c', signal: undefined }
    const out = await s.resolvePolicy(
      { sandbox_permissions: 'danger-full-access', justification: 'writing outside the workspace' },
      exec,
    )
    expect(out?.mode).toBe('danger-full-access')
    expect(asks).toHaveLength(1)
  })
})

describe('hasFsErrorCode / mapError', () => {
  it('duck-types a structured file error code across class boundaries', () => {
    expect(hasFsErrorCode({ code: 'FS_STALE_VERSION' }, 'FS_STALE_VERSION')).toBe(false) // not an Error
    expect(hasFsErrorCode(Object.assign(new Error('x'), { code: 'FS_STALE_VERSION' }), 'FS_STALE_VERSION')).toBe(true)
    expect(hasFsErrorCode(new Error('x'), 'FS_STALE_VERSION')).toBe(false)
  })

  it('maps an FS_SANDBOX_DENIED to the shared marker on the SAME error object', () => {
    const s = createEditSandbox(noSandbox)
    const err = Object.assign(new Error('raw denial text'), { code: 'FS_SANDBOX_DENIED' })
    const mapped = s.mapError(err, policy('workspace-write'))
    expect(mapped).toBe(err) // identity preserved → host code routing survives
    const msg = (mapped as Error).message
    expect(msg).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(msg).toContain('escalation available')
    expect(s.mapError(new Error('unrelated'), undefined)).toBeInstanceOf(Error)
  })

  it('passes through non-denial errors unchanged', () => {
    const s = createEditSandbox(noSandbox)
    const other = new Error('boom')
    expect(s.mapError(other, policy('workspace-write'))).toBe(other)
    expect(s.mapError('not an error', undefined)).toBe('not an error')
  })
})
