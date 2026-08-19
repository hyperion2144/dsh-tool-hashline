/**
 * Minimal sandbox handling for the hashline `edit` tool, mirroring
 * `@deepseek-ai/dsh-tool-fs`: resolve the calling session's standing file
 * policy and thread it onto the write (so a `danger-full-access` session can
 * write outside the sandbox workspace), support the one-shot
 * `sandbox_permissions` escalation retried after a denial, and map a provider
 * `FS_SANDBOX_DENIED` to the shared `[sandbox: …]` marker the model is taught.
 *
 * Detection is DUCK-TYPED (an Error carrying `code`), never `instanceof`: this
 * plugin's build bundles its own copies of the harness packages while the host
 * resolves its own, so class identity across the boundary is not guaranteed.
 * @module dsh-tool-hashline/sandbox
 */

import {
  approveEscalation,
  ESCALATION_TARGETS,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  type EscalationApprover,
  type SandboxExecutionPolicy,
  type SandboxMode,
} from '@deepseek-ai/dsh-sandbox'

/** The escalation arguments a confining edit tool advertises. */
export interface EscalationArgs {
  sandbox_permissions?: string
  justification?: string
  /** The tool call carries more fields; the controller reads only these two. */
  [key: string]: unknown
}

/** Structural stand-in for the `sandboxPolicy` service's per-session resolver. */
export interface SandboxPolicyResolver {
  resolve(input?: { session?: unknown }): SandboxExecutionPolicy | undefined
}

/** The minimal `ctx` surface the controller needs. */
export interface SandboxCtx {
  fs: { sandboxMode?: SandboxMode | undefined }
  get(name: string): unknown
}

/** The minimal tool-execution surface the controller needs. */
export interface SandboxExecContext {
  agent?: { session?: unknown } | undefined
  callId: unknown
  signal?: AbortSignal | undefined
}

/**
 * True when an error is one of the harness's structured file errors carrying
 * `code` — robust across class boundaries the `instanceof` check is not.
 */
export function hasFsErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === code
}

/** A sandbox-aware `edit` tool controller. */
export interface EditSandboxController {
  /** Escalation field specs to advertise on the tool when the backend confines. */
  schemaFields(): { sandbox_permissions: { type: 'string'; enum: readonly SandboxMode[]; description: string }; justification: { type: 'string'; description: string } } | Record<string, never>
  /**
   * The policy for this call: the session's standing mode, or — when
   * `sandbox_permissions` + `justification` are supplied — the approved
   * strictly-wider mode. `undefined` when no confining backend is mounted.
   */
  resolvePolicy(args: EscalationArgs, exec: SandboxExecContext): Promise<SandboxExecutionPolicy | undefined>
  /**
   * Map a provider `FS_SANDBOX_DENIED` to the shared marker text, mutating the
   * SAME error object in place so its host-side HarnessError identity (and thus
   * the structured `code`) survives the throw.
   */
  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown
}

export function createEditSandbox(ctx: SandboxCtx): EditSandboxController {
  const confined = ctx.fs.sandboxMode !== undefined
  // A confining backend normally mounts `sandboxPolicy`; if it does not we
  // degrade to no-policy writes rather than failing plugin load.
  const resolver = (confined ? ctx.get('sandboxPolicy') : undefined) as SandboxPolicyResolver | undefined
  return {
    schemaFields() {
      if (resolver === undefined) return {} as Record<string, never>
      return {
        sandbox_permissions: {
          type: 'string',
          enum: [...ESCALATION_TARGETS],
          description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval.',
        },
        justification: {
          type: 'string',
          description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access.',
        },
      }
    },
    async resolvePolicy(args, exec) {
      validateEscalationArgs(args.sandbox_permissions, args.justification)
      const standing = resolver?.resolve(exec.agent?.session === undefined ? {} : { session: exec.agent.session })
      if (args.sandbox_permissions === undefined || args.justification === undefined) return standing
      if (standing === undefined) throw new Error('sandbox_permissions is not available for this session (no sandbox policy)')
      const approver = ctx.get('approval') as unknown as EscalationApprover<object, unknown> | undefined
      const approvedMode = await approveEscalation<object, unknown>({
        requestedMode: args.sandbox_permissions,
        justification: args.justification,
        effectiveMode: standing.mode,
        subject: 'operation',
      }, {
        approver,
        agent: exec.agent as object | undefined,
        callId: exec.callId,
        toolName: 'edit',
        signal: exec.signal,
      })
      return { ...standing, mode: approvedMode }
    },
    mapError(error, policy) {
      if (!hasFsErrorCode(error, 'FS_SANDBOX_DENIED')) return error
      const mode = policy?.mode ?? 'workspace-write'
      const err = error as Error & { code: string }
      err.message = `${sandboxDenialMarker(mode)}\n${escalationHintMarker('operation')}`
      return err
    },
  }
}
