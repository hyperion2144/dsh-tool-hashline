# dsh-tool-hashline

Hash-anchored `read`, `edit`, and `grep` tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Every line carries a short content hash; edits reference `LINE#HASH` anchors that are verified against the file's current content **before anything is written**. Stale anchors fail the whole call — never relocated, never fuzzy-matched, never silently applied to the wrong line.

Protocol adopted from [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) (MIT), inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi).

---

## How to install

### Prerequisites

- **Node.js ≥ 20** (for running dsh and the plugin).
- **dsh**. Two ways to have it:
  - No install: `npx @deepseek-ai/dsh <command>` — note the bare command always needs a profile: `npx @deepseek-ai/dsh web` or `npx @deepseek-ai/dsh --profile headless "task"`.
  - Global install (gives you the bare `dsh` command on PATH, plus pnpm in one go): `npm i -g pnpm @deepseek-ai/dsh`.
- **pnpm** — the `dsh plugin` command forwards to it (installed by the global command above).
- A **DeepSeek API key** for live sessions (configure it in the Web UI at Settings → Models, or export `DEEPSEEK_API_KEY`).

### Step 1 — get the plugin

**Option A: npm (recommended)** — published on the registry, installs the prebuilt `lib/` bundle:

```sh
dsh plugin --profile web add dsh-tool-hashline
# …or without a global dsh:
npx @deepseek-ai/dsh plugin --profile web add dsh-tool-hashline
```

**Option B: from source** (development):

```sh
git clone https://github.com/InklingYoshi584/dsh-tool-hashline.git
cd dsh-tool-hashline && npm install
```

The `@deepseek-ai/*` harness packages are dev dependencies here on purpose: at runtime the plugin resolves them from the dsh installation through the profile's maintained flat fallback (`$DSH_HOME/profiles/node_modules` symlinks), so no duplicate harness core ever ships with the plugin. `npm install` only needs to succeed for the tests; running the plugin needs nothing but the preset row.

### Step 2 — author the `hashline` preset

The plugin replaces the stock tools by **preset-plane shadowing**: a preset that mounts this plugin instead of `tool-fs` gives its sessions the hashline `read`/`edit`/`grep` while everything else keeps working from the host composition. Create the preset by dropping the shipped files into the user preset root (hand-created presets are discovered live):

```sh
mkdir -p "$DSH_HOME/.agent-presets/hashline"
cp preset/agent.cordis.yml "$DSH_HOME/.agent-presets/hashline/"
cp preset/preset.yml "$DSH_HOME/.agent-presets/hashline/"
```

…or use the Web UI (Settings → presets → copy `standard` as `hashline`) and replace the copied composition with the shipped template.

Then edit the plugin row in `$DSH_HOME/.agent-presets/hashline/agent.cordis.yml` to point at your install:

```yaml
# npm install:
- id: tool-hashline
  name: 'dsh-tool-hashline'

# from source (Windows needs the file:/// URL form):
- id: tool-hashline
  name: 'file:///C:/path/to/dsh-tool-hashline/src/index.ts'
```

To also enable grep, add `config: { grep: true }` to that row.

### Step 3 — select the preset

Settings → presets → `hashline`, or set the default in `$DSH_HOME/settings.yaml`:

```yaml
agent-presets:
  default: hashline
```

New sessions now run on hashline. Sessions already running keep their composition — only new sessions pick up the preset.

### Step 4 — verify it works

1. In a session: **read any text file** — output lines are `LINE#HASH:` tagged (`   1#PK:alpha`).
2. Ask the agent to **edit something** — the call carries `edits: [{op, pos: "N#HASH", …}]` and the result returns an `--- Anchors ---` block.
3. Settings → Agent presets should show **"In use: Hashline"**.

### What the swap changes

On the `hashline` preset, `read`/`edit` (and `grep` when enabled) are the hashline versions — the preset's scope layer shadows the global `tool-fs`/`tool-fs-search` tools **by name**. `write`, `read_image`, `glob`, `bash`, and everything else keep working from the host composition, and subagents inherit the preset.

### Headless / no-roster deployments

The `headless` profile composes no preset roster. Use a `--patch` overlay with a host-plane swap instead:

```yaml
# hashline.patch.yml
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
- insert:
    - id: tool-hashline
      name: 'file:///C:/…/src/index.ts'
      config:
        grep: true
```

```sh
npx @deepseek-ai/dsh --profile headless --patch ./hashline.patch.yml "your task"
```

## Why use it

AI coding agents edit files by quoting what they saw on screen. Two things can be true at edit time: the file changed since the read (a concurrent write, a drift, an earlier edit in the same turn), and the quoted text appears in more than one place. Stock edit tools handle this badly:

- **Literal string-replace** (`old_string`/`new_string`, what DSH ships) requires the quoted text to match *exactly once*. Any drift means a retry loop; ambiguity means "make it more specific" busywork.
- **Line-number editing** is worse: numbers silently point at the *wrong* line after any shift, and the edit corrupts code the model never looked at.
- The problem is real enough that Cursor trained a dedicated 70B model just to apply edits correctly.

The evidence that the harness — not the model — is the lever: [Can Balioglu's benchmark](https://blog.can.ac/2026/02/12/the-harness-problem/) kept 15 models fixed and swapped only the edit format. Hashline beat patch for 14 of 16 configurations, **and the weakest models gained the most**. Better anchoring rescues the long tail of models you'd otherwise give up on.

What hashline changes:

| Property | Stock `edit` | hashline |
|---|---|---|
| Anchor | literal `old_string` text | `LINE#HASH`: **the line number locates, the hash verifies** |
| Same text appears twice | ambiguity, "be more specific" | line number is the locator — identical lines never conflict |
| File drifted since read | error, retry with new text | error **naming the stale line**, re-read, retry |
| Multiple hunks | one call per hunk | **N ops in one call**, one snapshot, one atomic write |
| After an edit | re-read the file | fresh `--- Anchors ---` block for the changed lines → chained edits with no re-read |
| Search-to-edit | grep, then open, then quote | `grep` returns the same anchors → edit with no read at all |
| Line shifted by your own edit | re-read to re-number | reuse `newLine#unchangedHash` — content keeps its hash |

On top of that, DSH's own observation policy stays in force: read-before-write and a file-level version CAS still guard the whole file, while the anchors guard the *lines*. You get line-level correctness and file-level freshness together.

## Demo

```text
$ read e2e/probe/notes.txt

<path>…/notes.txt</path>
<type>file</type>
<content>
   1#PK:alpha
   2#YB:beta
   3#VZ:gamma
   4#WX:delta
   5#XJ:epsilon
   6#BK:zeta
   7#XP:eta
   8#KR:theta

(End of file - total 8 lines)
</content>
```

One `edit` call, four ops, one snapshot:

```json
{
  "file_path": "e2e/probe/notes.txt",
  "edits": [
    { "op": "replace", "pos": "2#YB", "lines": [] },
    { "op": "append", "pos": "3#VZ", "lines": ["BETA-NEW"] },
    { "op": "replace", "pos": "4#WX", "lines": ["DELTA"] },
    { "op": "replace", "pos": "5#XJ", "end": "6#BK", "lines": ["EPSILON-ZETA"] }
  ]
}
```

```text
The file …/notes.txt has been updated: 4 edit(s) applied.

--- Anchors 1-6 ---
1#ZP
2#XZ
3#BY
4#RJ
```

Deletes `beta`, inserts `BETA-NEW` after `gamma`, rewrites `delta`, and collapses the two-line range `epsilon…zeta` into one — all validated against the pre-edit content and committed in one write. The fresh anchor block drives the next edit without a re-read.

## Tools

### `read`

Line-numbered UTF-8 content with a hash per line. Each line is `LINE#HASH: content`: the **line number is the line's position in the whole file** (absolute — a window past `offset` keeps the file's own numbering), and the hash is a **content-stable** check over that line's own text — a line whose content is unchanged keeps the same hash anywhere in the file and across edits. Identical lines at different positions share a hash; the line number, never the hash, tells them apart.

| Arg | Meaning |
|---|---|
| `file_path` | Path, resolved against the session workspace |
| `offset`, `limit` | 1-based window (default 2000 lines, byte-capped) |
| `raw` | Plain content without tags |

### `edit`

| Op | Anchor | Effect |
|---|---|---|
| `replace` | `pos` (or `pos` + `end`) | Replace a line or inclusive range with `lines`; `lines: []` deletes |
| `append` | `pos` (omit → EOF) | Insert `lines` after `pos` |
| `prepend` | `pos` (omit → BOF) | Insert `lines` before `pos` |
| `replace_text` | unique `old_text` | Literal substring replace (off by default: anchor-only) |

Rules: every op validates against the same pre-edit snapshot; overlapping ops are rejected (`HASHLINE_INVALID_PATCH`); `lines` must be literal content — hashline prefixes or diff markers are refused; a successful edit returns fresh anchors for the changed region; a no-op warns, three consecutive identical no-ops raise `HASHLINE_NOOP_LOOP`.

### `grep` (opt-in, `grep: true`)

Searches with the **packaged** ripgrep binary — no system rg required. Matched lines return as the same `LINE#HASH` anchors, and matched files are recorded as read, so anchors feed `edit` directly with no prior `read`. Args: `pattern` (regex unless `literal: true`), `path`, `glob`, `ignore_case`, `context` (0–5), `limit` (default 50, max 200). Respects `.gitignore`.

### Errors

Stable `{name, code}` metadata on failures:

| Code | Trigger |
|---|---|
| `HASHLINE_STALE_ANCHOR` | The anchored line's content no longer matches its hash (or the line is out of range) |
| `HASHLINE_AMBIGUOUS` | `replace_text`: `old_text` matches multiple times — make it unique |
| `HASHLINE_INVALID_PATCH` | Overlapping ops, or non-literal `lines` |
| `HASHLINE_NOOP_LOOP` | Three consecutive identical no-op edits |
| `HASHLINE_EDIT_LOCKED` | Another edit to the same file is already in flight — retry after it finishes |
| `FS_NOT_OBSERVED` / `FS_STALE_VERSION` | DSH policy gate, unchanged from stock, with re-read remedies |

## How the protocol works

- **Anchors are `LINE#HASH`; the line number is the locator.** An anchor names *one exact line* by its position in the whole file; the hash is a content-verification tag, never a locator of its own. Validation compares the hash at that line only — identical lines elsewhere are irrelevant.
- **Content-stable hashing**: FNV-1a over the line's own UTF-8 text, mapped to the alphabet `ZPMQVRWSNKTXJBYH` (16 visually distinct chars, 4 bits each), default length **2** (configurable 2–4). A line whose content is unchanged keeps the same hash anywhere in the file and across edits; editing line N re-anchors only the lines N actually changed. To keep editing after your own insert/delete shifts a target, continue with `newLineNumber#unchangedHash` — no re-read, no full-context re-anchor.
- **Web display**: the read and (enabled) grep tools present their results so the web GUI shows the same anchors as the model — the read card's lines render as `LINE#HASH`, grep renders a grouped search card whose matches carry `#HASH:`, and an edit's web card names its fresh-anchor range (`Edit … — fresh anchors A-B`). The anchor data rides the tool's own presentation metadata, so live and replayed sessions render identically with no harness changes.
- **Concurrent edits, per file**: an in-process per-file lock rejects a second `edit` to the same resolved file while the first is still in flight (`HASHLINE_EDIT_LOCKED`) — two overlapping edits can never validate and write from the same stale snapshot. In-turn edits are strictly serial, so this only fires for genuinely overlapping calls (parallel agents/sessions). The lock covers one process; cross-process or worker-thread overlaps still fall through to the version CAS.
- **Strictness**: an anchor whose line's content no longer matches fails the whole call. No relocation to a "close enough" line, ever — the tool trades convenience for correctness.
- **File-level safety net**: every mutation still goes through DSH's `fs/edit-intent` → version-CAS write, so any modification to the file between validation and write is caught as `FS_STALE_VERSION`.


## Configuration

All optional (on the preset row's `config`):

| Key | Default | Meaning |
|---|---|---|
| `hashLength` | 2 | Hash chars per line (2–4); longer → fewer collisions, more tokens |
| `replaceText` | false | Allow the literal `replace_text` op |
| `grep` | false | Register the hash-anchored `grep` tool |
| `readLimit` | 2000 | Max lines per `read` |
| `readMaxLineLength` | 2000 | Chars per line before truncation |
| `readMaxBytes` | 51200 | Byte cap per `read` window |
| `readStreamMinSize` | 10485760 | Files at/above this size stream |

## Composition gotchas (verified against the published dsh)

- Id-targeted overrides in a profile `cordis.patch.yml` are **bare top-level entries** (`- id: tool-fs` + `disabled: true`, no `name`); restating `name` inside an `insert:` list creates a NEW row and the loader fails with `duplicate loader entry id`.
- Absolute plugin paths in patch rows must be `file:///` URLs on Windows; a bare drive path fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- The registry throws on same-name tools **within one scope layer** — the preset-plane shadowing is what makes replacement possible, not re-registration.

## Repository layout

```
src/hash.ts         Hash core: FNV-1a content hashing, anchor format/parse (no deps)
src/render.ts       Read windowing, byte caps, tagged envelope (no deps)
src/edit-engine.ts  Op resolution, strict line#hash validation, bottom-up apply (no deps)
src/edit-lock.ts    Per-file in-process edit lock; rejects concurrent edits (no deps)
src/grep-engine.ts  rg argv, NDJSON parsing, region + card rendering (no deps)
src/read.ts         read tool (ctx.fs + fs/observed) + web read-card projection
src/edit.ts         edit tool (fs/edit-intent + version-CAS write + per-file lock)
src/grep.ts         grep tool (ctx.subprocess + packaged rg) + web search-card projection
src/prompts/*.ts    Model guidance sections (the "prompt injection")
src/index.ts        Plugin contract: name/inject/Config/apply
preset/             Drop-in `hashline` preset template
tests/              Unit + integration over real fs-local, policy, and ripgrep
```

## Limits

- **Stale anchors fail, they don't self-heal.** pi-hashline-edit's 3-way snapshot-merge recovery (ADRs 0004/0005) is deliberately deferred; the tool returns clear re-read guidance instead. Snapshots and merge recovery are the natural v2.
- **2-char hashes are 256 buckets.** A same-line content collision (old vs new content hashing alike) would let a stale anchor pass; context-free hashing also can't tell two *identical* lines apart — the line number is what disambiguates them, and the per-file version CAS catches unknown shifts. `hashLength: 3` or `4` is there for very large or very uniform files.
- **Dev preview churn.** Built against DSH v0.1 (source @ `47f943`, npm `@deepseek-ai/dsh-*` rc.1/rc.5). DeepSeek warns the preview will break compatibility — pin and re-verify on upgrade.

## Development

```sh
npm install
npm run check    # typecheck + tests
npm run build    # lib/index.js — what the npm package ships
```

## Credits

[pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) for the protocol (hash anchoring, op set, strict anchors, grep-anchor loop), [oh-my-pi](https://github.com/can1357/oh-my-pi) for the hashline technique, [Can Balioglu](https://blog.can.ac/2026/02/12/the-harness-problem/) for proving the harness problem.

## License

MIT
