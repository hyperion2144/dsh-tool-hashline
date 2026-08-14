# PLAN: `dsh-tool-hashline` — hash-anchored `read`/`edit` for DeepSeek Harness

Goal: a DeepSeek Harness plugin that replaces the normal `edit` and `read` tools with hash-anchored hashline versions, so every edit carries a verifiable per-line content hash and stale anchors are rejected before touching the file — no silent wrong-line rewrites.

Success criteria (all observable):

1. On an agent whose preset carries the plugin, `read` returns `LINE#HASH:`-prefixed content and `edit` applies `replace`/`append`/`prepend`/`replace_text` ops validated against content hashes.
2. A stale anchor (file changed since read) fails the whole call with a structured error and re-read guidance; nothing is written.
3. A successful edit returns fresh anchors for the changed region — a second edit can chain without a re-read.
4. The stock `write`, `read_image`, `glob`, `grep` tools keep working untouched (they come from `tool-fs`/`tool-fs-search` and stay loaded).
5. The plugin ships out-of-tree (npm package), installs into a dsh profile, and composes with a drop-in preset file — no fork of deepseek-harness.

Non-goals (v1): no snapshot/3-way-merge recovery (pi-hashline-edit ADRs 0004/0005 — v2), no hashline `grep` (v2), no hashline `write`, no changes to upstream dsh.

---

## 1. Verified integration model (the part that decides the architecture)

Facts verified in deepseek-harness @ 47f943 (dev preview v0.1):

- **Duplicate tool names throw.** `ToolRuntime` builds each scope layer via `NamedEntries(name => new Error('tool "<name>" is already registered …'))`. A plugin that registers `read`/`edit` on the same scope as `tool-fs` dies at boot. (`packages/core/tools/src/index.ts`)
- **The registry and systemPrompt are scope-layered.** "both `dsh-tools` and `dsh-system-prompt` file registrations into the calling context's scope layer"; agent views resolve `agent → preset → global`, nearest shadowing farthest. (`packages/preset/agent-presets/README.md`)
- **Shipped presets re-mount `tool-fs` on the agent plane.** `apps/cli/config/agent-presets/standard/agent.cordis.yml` declares `- id: tool-fs` ("Both register into the host `tools` registry and provide nothing, so they need no realm"). Preset rows compose per standing mount; disabling the base host row does not survive them (the `tool-bash` re-enable postmortem in the loader `disabled` note). So host-plane `disabled: true` on `tool-fs` is NOT a viable swap.
- **Presets are copy-only authorable.** `agentPresets.copy()` creates a user preset under `<dshHome>/.agent-presets`; afterwards "everything happens in the preset's own files", discovery re-scans roots live, and row package names resolve from the HOST composition (so an out-of-tree npm package installs via the profile and is nameable from a preset row). (`packages/preset/agent-presets/README.md`)
- **Per-agent registration exists** (`Agent.ctx` scope context; `ctx.on('agent/created', …)` seen in `packages/schedule/schedule/src/index.ts`) — kept as the documented fallback, but subagents don't inherit agent-scope registrations ("scoped registrations do not inherit down to subagents", `docs/glossary.md`), while subagent children DO join their parent's preset via `composeFrom()`. Preset-plane wins for parent/child consistency.

**Chosen mechanism — preset-plane shadowing:**

The plugin registers `read` + `edit` (hashline) and ships a ready-made user preset, `hashline`, which is the `standard` composition with one change:

```yaml
# <dshHome>/.agent-presets/hashline/agent.cordis.yml  (shipped as a template)
# …standard rows unchanged…
# ── filesystem ─────────────
# - id: tool-fs            ← removed
#   name: '@deepseek-ai/dsh-tool-fs'
- id: tool-hashline
  name: '@deepseek-ai/dsh-tool-hashline'   # resolves from the host composition
# tool-fs-search row unchanged
```

Effect per session on the `hashline` preset:

- `read`/`edit`: my preset-layer registrations shadow `tool-fs`'s global ones (and the preset no longer mounts its own `tool-fs` instance — no same-scope duplicate).
- `write`, `read_image` (from global `tool-fs`) and `glob`, `grep` (from `tool-fs-search`) remain — zero reimplementation.
- My `tool:read`/`tool:edit` systemPrompt sections (preset layer) shadow the global `tool-fs` guidance sections of the same names. *Verify shadow-by-name at implementation (first task); fallback: distinct section names + self-contained tool descriptions.*
- Subagents on the session inherit the preset (via `composeFrom`) — hashline everywhere.

Fallback (documented, not implemented first): a host-plane plugin row listening to `agent/created` and mounting the tool plugin on `agent.ctx` replaces read/edit for every agent regardless of preset — at the cost of subagent inconsistency.

---

## 2. Protocol — adopted from pi-hashline-edit (MIT, RimuruW)

Reference: https://github.com/RimuruW/pi-hashline-edit (161★, MIT, TypeScript, 17+ test files, 7 ADRs). Its core insights transfer 1:1; its integration layer (pi tool override) does not — that part is DSH-preset composition above.

### 2.1 Line hashing

- Prefix format: `LINE#HASH:` with LINE 1-indexed, left-padded for column alignment.
- Hash alphabet: `ZPMQVRWSNKTXJBYH` (16 visually-distinct chars), default length **2** (256 buckets), configurable 2–4. Token cost ≈ 4 chars/line.
- **Context-based hashing** (their ADR 0003 — adopted whole): hash input = `prevLine + '\n' + currentLine + '\n' + nextLine` (LF-normalized). Identical lines in different contexts hash differently → the classic "50 identical `}` lines" ambiguity mostly disappears, and editing line N invalidates anchors only for N−1, N, N+1.
- Deterministic (FNV-1a over the context triple, mapped into the alphabet); no salt, no per-file state; recomputed from file content at every read/edit.

### 2.2 `read` (replaces `read`)

- Args (snake_case, DSH convention): `file_path`, `offset?`, `limit?`, `raw?` (plain content, no prefixes — for the model to fetch un-tagged text when it wants it).
- Model-facing envelope mirrors `tool-fs` exactly so existing tooling/parsers keep working: `<path>…</path>` / `<type>file</type>` / `<content>` … same footers ("(Showing lines … Use offset=… to continue.)", capped/truncation notes).
- Lines render as `  8#VR:function hello() {` — the hash is in the render() text ONLY.
- Canonical output keeps the `tool-fs` read shape: `{ path, offset, lines: [{number, text}], totalLines }` — `presentationMeta` and `presentResult` stay hash-free so the UI read card (`presentResult` regex-parses the envelope) renders unchanged.
- Execution identical to `tool-fs` read: `ctx.fs.resolve` (session cwd via `exec.agent.session.header.cwd`), one `ctx.fs.stat` (absent → `FS_NOT_FOUND` + absent observation; directory → `FS_NOT_REGULAR_FILE`), `readText`/`streamText` above `readStreamMinSize`, window/byte/line caps, then `ctx.emit('fs/observed', target, {kind:'present', version}, exec)`. `isConcurrencySafe: true`.

### 2.3 `edit` (replaces `edit`)

Args:

```json
{
  "file_path": "string (required)",
  "edits": [
    {
      "op": "replace | append | prepend | replace_text",
      "pos": "string  (\"LINE#HASH\", required except append-EOF / prepend-BOF)",
      "end": "string  (optional; inclusive range for replace)",
      "lines": ["…"],              // literal content; replace/append/prepend
      "old_text": "string",        // replace_text
      "new_text": "string"         // replace_text
    }
  ]
}
```

Op semantics (from the reference):

| Op | Anchor | Effect |
|---|---|---|
| `replace` | `pos` (or `pos`+`end`) | replace line or inclusive range with `lines` (`lines: []` deletes) |
| `append` | `pos` (omit → EOF) | insert `lines` after `pos` |
| `prepend` | `pos` (omit → BOF) | insert `lines` before `pos` |
| `replace_text` | unique `old_text` | literal substring replace; fails unless exactly one match; **off by default** (`replaceText` config, default `false` — the point of this plugin is anchor-only edits) |

Execution pipeline (all hooks = the verified `tool-fs` contract):

1. Validate args (schema DSL + `parseEditArgs`: op/field matrix, `pos` pattern `^\d{1,8}#[ZPMQVRWSNKTXJBYH]{2,4}$`, non-overlapping ops, `lines` must not contain display prefixes/diff markers → `HASHLINE_INVALID_PATCH`).
2. `ctx.fs.resolve(file_path, {cwd: session cwd, signal})`.
3. `ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` — the observation policy returns `{version}` or throws `FS_NOT_OBSERVED`/`FS_NOT_FOUND` (read-before-edit preserved verbatim).
4. `ctx.fs.readText(target, signal)` → split lines → compute context hashes for the CURRENT content.
5. Resolve every anchor against the current content: hash must match the anchor line exactly — **no relocation, no fuzzy matching** (reference's core rule). Mismatch → `HASHLINE_STALE_ANCHOR` naming the offending op, advising re-read. Hash matches multiple lines → `HASHLINE_AMBIGUOUS` listing candidate line numbers. (Both are the hashline value-add over `tool-fs`'s file-level version guard.)
6. Apply all ops **bottom-up** (reference's order) against the pre-edit snapshot → final content; preserve original trailing-newline status.
7. `ctx.fs.writeText(target, finalContent, intent, signal)` — the file-level `replaceIfVersion` CAS still fires → concurrent modification between step 3 and 7 → `FS_STALE_VERSION` → re-read remedy (same message shape `tool-fs` uses).
8. `ctx.emit('fs/observed', target, {kind:'present', version: outcome.version}, exec)` — so the next edit needs no re-read (policy parity with `tool-fs`).
9. Result render: `--- Anchors A-B ---` block with fresh `LINE#HASH` anchors for the **affected range** `[minAnchor−1, maxAnchor+1]` (context-hash invalidation range, clamped) → chained edits without re-read. Noop edit → warning + unchanged anchors; 3 consecutive identical no-ops → `HASHLINE_NOOP_LOOP` (reference's loop guard).
10. Canonical output: `{ path, before, after, appliedOps, changedRange: {from, to} }`; `presentationMeta` → `{ diffs: [{path, oldText: before, newText: after}] }` (diff card parity with `tool-fs` edit). Mutations exclusive (no `isConcurrencySafe`).

### 2.4 Error codes

Thrown as `HarnessError` (`{name, code}` shows up on `isError` tool results):

| Code | Trigger | Model-facing remedy |
|---|---|---|
| `HASHLINE_STALE_ANCHOR` | hash mismatch at anchor line | "re-read the file, then retry" + the op |
| `HASHLINE_AMBIGUOUS` | hash matches 2+ lines | candidate line numbers |
| `HASHLINE_INVALID_PATCH` | `lines` contains prefixes/diff markers; op/field matrix violated | show valid literal content |
| `HASHLINE_NOOP_LOOP` | 3rd identical no-op in a row | "state what should change" |

Pass-through untouched: `FS_NOT_FOUND`, `FS_NOT_REGULAR_FILE`, `FS_NOT_OBSERVED`, `FS_STALE_VERSION` (with `tool-fs`'s remedy suffix appended).

### 2.5 Config (schemastery, defaults = reference defaults)

`hashLength` 2 (2–4) · `readLimit` 2000 · `readMaxLineLength` 2000 · `readMaxBytes` 51200 · `readStreamMinSize` 10485760 · `replaceText` false · `raw` flag always available. Invalid values fail loud at load (repo convention).

---

## 3. Package layout (out-of-tree npm package)

```
dsh-tool-hashline/
  package.json            # deps: @deepseek-ai/cordis, @deepseek-ai/dsh-tools,
                          #   @deepseek-ai/dsh-fs, @deepseek-ai/dsh-system-prompt,
                          #   @deepseek-ai/schemastery  (all host-resolvable)
  src/index.ts            # plugin contract: name='tool-hashline',
                          #   inject=['tools','fs','systemPrompt'], Config, apply()
  src/hash.ts             # Cordis-free: FNV-1a, alphabet map, context triple,
                          #   format/parse of "LINE#HASH", affected-range calc
  src/read.ts             # hashline read tool (mirrors tool-fs read execution)
  src/edit.ts             # hashline edit tool: arg validation, anchor resolution,
                          #   bottom-up apply, fresh-anchor render
  src/render.ts           # window/envelope rendering (Cordis-free, unit-tested)
  src/errors.ts           # HarnessError codes above
  prompts/                # guidance text shipped as data (tested for consistency)
  preset/agent.cordis.yml # drop-in `hashline` preset template (copy of standard,
                          #   tool-fs row → tool-hashline row)
  README.md               # install + preset + config + protocol reference
  tests/                  # vitest — see §6
```

One plugin package only (the repo's "do not split preemptively" rule); `src/hash.ts`/`src/render.ts` stay Cordis-free exactly like `tool-fs`'s `read-render.ts`.

No imports from `@deepseek-ai/dsh-tool-fs` internals — its npm tarball ships only `lib/*` and the root exports only the plugin contract; the plan's modules are self-contained reimplementations of the small, already-verified behaviors.

---

## 4. Composition & delivery

1. `dsh plugin --profile web add dsh-tool-hashline` (installs into the profile; host composition resolves the package name for preset rows) — dev flow: absolute path row + `--patch` overlay, per the official develop/basic guide.
2. Author the preset: Web UI Settings → presets → copy `standard` as `hashline` (official `agentPresets.copy` flow), then replace the shipped `agent.cordis.yml` contents with the shipped template; or create `<dshHome>/.agent-presets/hashline/agent.cordis.yml` directly (discovery scans roots live; smoke-test this path).
3. Select `hashline` as the session preset (or set `agent-presets.default` in settings).
4. Verify composition: session log / Trajectory shows the hashline read output and prompt sections; `read` returns tagged lines; a stale-anchor edit is rejected.

Prompt guidance (systemPrompt sections in the preset layer — shadow the global ones by name `tool:read`/`tool:edit`, order 100/102):

- `tool:read`: "Lines are shown as `LINE#HASH:` … copy anchors verbatim into edit ops; `raw` for untagged content."
- `tool:edit`: the op table, anchor rule ("hash must match at the exact line; never guess or relocate"), multi-op batching in one call, chained-anchor note, error remedies. Guidance is data (`prompts/*.md`) with a consistency test asserting every schema/example in the docs appears in the guidance and vice versa (reference's prompt-examples test pattern).

---

## 5. Edge cases & failure modes

| Case | Behavior |
|---|---|
| Stale anchor (file drifted) | whole call rejected, `HASHLINE_STALE_ANCHOR`, nothing written |
| Duplicate hash in file | `HASHLINE_AMBIGUOUS` + candidates (context hashing makes this rare) |
| Concurrent modification mid-edit | `FS_STALE_VERSION` via write CAS → re-read remedy |
| No prior read | `FS_NOT_OBSERVED` (policy, unchanged) |
| CRLF files | LF-normalized hashing both sides; `ctx.fs` normalizes on write (mixed-endings test) |
| Empty file / EOF append / BOF prepend | `pos` optional for append/prepend; EOF anchor = `totalLines#HASH` |
| Missing trailing newline | preserved across edits |
| `lines` with `LINE#HASH:` prefixes or diff markers | `HASHLINE_INVALID_PATCH` |
| Noop edit | warning + fresh anchors, not an error; 3× → `HASHLINE_NOOP_LOOP` |
| Windows paths / backslashes | `ctx.fs.resolve` + session cwd (same path `tool-fs` uses) |
| Binary / image / directory | pass-through `FS_NOT_TEXT`/image routing/`FS_NOT_REGULAR_FILE` semantics of `ctx.fs`; `read_image` untouched (global `tool-fs`) |
| `raw` read | returns plain content; still emits `fs/observed` |

---

## 6. Test plan

Unit (vitest, `src/hash.ts` + `edit.ts` apply, Cordis-free): hash determinism & context invalidation (edit line N → only N−1,N,N+1 anchors go stale); alphabet mapping; format/parse round-trip incl. left-padded lines; hashLength 2–4; bottom-up multi-op apply (mixed replace/append/prepend in one call); range replace; delete via `lines: []`; non-overlapping-op validation; trailing-newline preservation; CRLF/LF mixed; affected-range calculation; noop detection + loop guard counter.

Integration (mirror `tool-fs/tests/integration.spec.ts`): boot test context = `LocalFileSystem` + `FsPolicy` + plugin; execute read → edit → assert content; edit-without-read → `FS_NOT_OBSERVED`; external write between read and edit → `FS_STALE_VERSION` remedy; stale anchor → `HASHLINE_STALE_ANCHOR`; chained edit using returned anchors with no re-read; `write`/`glob`/`grep` still registered and functional (no shadowing fallout); read envelope byte/line caps.

Prompt consistency: examples in `prompts/*.md` match the tool schemas (reference's `prompt-examples.test.ts` pattern).

E2E acceptance (smoke, on a real dsh checkout @ 47f943): install plugin + `hashline` preset → `dsh web`; in a session: task "edit function X, insert helper above it, delete dead code below" (3 hunks) → assert all three landed; assert one stale-anchor rejection triggers re-read and retry; assert second chained edit succeeded without re-read; Trajectory view shows tagged reads. Headless repeat for flake check.

---

## 7. Milestones

1. **Scaffold + hash core**: package, `src/hash.ts`, unit tests. (Also: verify systemPrompt section shadow-by-name in a mounted preset — fallback documented.)
2. **Read tool**: execution mirror + tagged rendering + observation parity.
3. **Edit tool**: arg validation, anchor resolution, bottom-up apply, fresh-anchor render, error taxonomy.
4. **Integration tests** over fs-local + policy.
5. **Preset template + README + composition verification** (`--dump-config` per profile, live preset discovery smoke).
6. **E2E smoke** on real checkout; fix; publish.

## 8. Risks & assumptions

- **Dev preview churn** ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES"): pin to 47f943; the plugin touches only public seams (`defineTool`, `ctx.fs`, `fs/*` events, presets) — highest-stability surface in the repo.
- **Guidance shadowing by name** is inferred from "nearest shadowing farthest" for both registries — verified in milestone 1, fallback ready.
- **Manual preset directory creation** relies on live root scanning (documented); official `copy()` flow is the primary path.
- `str_replace`/`view`/`create`/`insert` (global `tool-str-replace-editor`) remain available alongside hashline in the standard family — intentional v1 coexistence; optionally deny-listable later.
- Reference design features deferred: snapshot-merge recovery (ADR 0004/0005) only — hashline `grep` and the `replace_text` config now ship.

## 9. Grep (added per user scope: full reference surface)

Adopted from pi-hashline-edit's third tool: `grep` (opt-in, `grep: true`) runs the
PACKAGED ripgrep (`@vscode/ripgrep`) through `ctx.subprocess.spawn` — no system
rg required — with `--json` NDJSON match records. Args: `pattern` (regex unless
`literal`), `path`, `glob`, `ignore_case`, `context` (0-5), `limit` (50/200).

- Matched files are read through `ctx.fs` for context-correct hashes, then
  `fs/observed` is emitted — the DSH-native equivalent of pi's read-snapshot,
  so anchors from grep feed `edit` with NO prior read (integration-tested).
- Merged context ranges render as `formatHashlineRegion` blocks (`LINE#HASH:text`,
  gap ellipsis, per-file `---` separators, summary line).
- Subprocess dependency is conditional (`ctx.inject(['subprocess'], ...)` inside
  apply, mirroring tool-fs's read_image pattern) so the read/edit suite mounts
  in deployments without a subprocess seam.
- On the `hashline` preset the tool shadows the global tool-fs-search `grep` by
  name; in a host-plane swap the `tool-fs-search` row must be disabled first
  (same-layer duplicate names throw).

Prompt injection = the three `ctx.systemPrompt.section` guidance sections
(`tool:read` 100, `tool:edit` 102, `tool:grep` 104): read teaches anchor
capture, edit teaches the op vocabulary and stale rejection, grep teaches the
grep→edit loop and narrowing order.
