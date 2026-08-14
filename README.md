# dsh-tool-hashline

Hash-anchored `read`, `edit`, and `grep` tool plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Every line carries a short content hash; edits reference `LINE#HASH` anchors that are validated against the file's current content before anything is written. Stale anchors are rejected — never relocated, never fuzzy-matched.

Protocol adopted from [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) (MIT), inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi). See `PLAN.md` for the full design, the verified integration model, and the test plan.

## Status

Working: hash core, hashline `read`, hashline `edit` (replace/append/prepend/replace_text), hashline `grep` (anchored ripgrep search feeding edit), and prompt guidance — 105 tests green, including end-to-end integration over the real `fs-local` backend, observation policy, and packaged ripgrep binary. Live-session E2E smoke on the published `dsh` verified the full read/edit/grep schemas and guidance assembled into the model request (execution blocked only on a real API key).

## How it works

Reading a file returns hash-tagged lines:

```text
 8#VR:function hello() {
 9#KT:  console.log("world");
10#BH:}
```

`LINE` is the 1-based line number (left-padded); `HASH` is a 2-char content hash (configurable 2-4) from the alphabet `ZPMQVRWSNKTXJBYH`, computed over the line's context triple (`prev + curr + next`). Identical lines in different contexts hash differently, and editing line N invalidates anchors only for N-1, N, N+1.

Edits reference those anchors:

```json
{
  "file_path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "9#KT", "lines": ["  console.log('hashline');"] }
  ]
}
```

| Op | Anchor | Effect |
|---|---|---|
| `replace` | `pos` (or `pos` + `end` range) | Replace line/range with `lines`; `lines: []` deletes |
| `append` | `pos` (omit → EOF) | Insert `lines` after `pos` |
| `prepend` | `pos` (omit → BOF) | Insert `lines` before `pos` |
| `replace_text` | unique `old_text` | Literal substring replace (disabled by default) |
| `grep` | — | Search file contents; matched lines return `LINE#HASH` anchors usable in edit (opt-in) |

All ops in one call validate against the same pre-edit snapshot and apply together. A successful edit returns an `--- Anchors A-B ---` block with fresh anchors for the changed region — consecutive edits chain without a re-read. A no-op edit warns instead of failing; three consecutive identical no-ops raise `HASHLINE_NOOP_LOOP`.

`grep` (opt-in via `grep: true`) runs the **packaged** ripgrep binary through the subprocess seam — no system rg install needed — and returns the same `LINE#HASH` anchors. Matched files are recorded as read, so anchors from grep feed `edit` directly without a prior read. Args: `pattern` (regex unless `literal: true`), `path`, `glob`, `ignore_case`, `context` (0-5), `limit` (default 50, max 200). Results respect `.gitignore`.

Errors carry stable `{name, code}` metadata:

| Code | Trigger |
|---|---|
| `HASHLINE_STALE_ANCHOR` | Anchor hash no longer matches its line |
| `HASHLINE_AMBIGUOUS` | Hash matches multiple lines (candidates listed) |
| `HASHLINE_INVALID_PATCH` | Overlapping ops, or `lines` containing display prefixes/diff markers |
| `HASHLINE_NOOP_LOOP` | Three consecutive identical no-op edits |
| `FS_NOT_OBSERVED` / `FS_STALE_VERSION` | Policy gate (unchanged from `tool-fs`, with re-read remedies) |

## Install

### 1. Get the plugin into the profile

Development (absolute path, no publish):

```sh
# preset/agent.cordis.yml row:
- id: tool-hashline
  name: 'file:///C:/absolute/path/to/dsh-tool-hashline/src/index.ts'
```

Published (npm):

```sh
dsh plugin --profile web add dsh-tool-hashline
# preset/agent.cordis.yml row:
- id: tool-hashline
  name: '@deepseek-ai/dsh-tool-hashline'
```

### 2. Author the `hashline` preset

Either drop the shipped files into the user preset root (discovery scans it live — verified: hand-created presets are discovered, no copy() marker needed):

```sh
mkdir -p "$DSH_HOME/.agent-presets/hashline"
cp preset/agent.cordis.yml "$DSH_HOME/.agent-presets/hashline/"
cp preset/preset.yml "$DSH_HOME/.agent-presets/hashline/"
```

…or use the Web UI flow (Settings → presets → copy `standard` as `hashline`) and replace the copied composition with the shipped template.

### 3. Select the preset

Settings → presets → `hashline`, or set it as the default in `$DSH_HOME/settings.yaml`:

```yaml
agent-presets:
  default: hashline
```

### What the swap changes

On the `hashline` preset, `read`/`edit` (and `grep` when enabled) are the hashline versions — the preset scope layer shadows the global `tool-fs`/`tool-fs-search` tools by name. `write`, `read_image`, `glob`, `bash`, and everything else keep working from the host composition. Subagents inherit the preset.

## Config

All optional (set on the preset row's `config`):

| Key | Default | Meaning |
|---|---|---|
| `hashLength` | 2 | Hash characters per line (2-4) |
| `replaceText` | false | Allow the literal `replace_text` op |
| `grep` | false | Register the hash-anchored `grep` tool |
| `readLimit` | 2000 | Max lines per `read` |
| `readMaxLineLength` | 2000 | Chars per line before truncation |
| `readMaxBytes` | 51200 | Byte cap per `read` window |
| `readStreamMinSize` | 10485760 | Files at/above this size stream |

## Composition gotchas (verified against the published dsh)

- Id-targeted overrides in a profile `cordis.patch.yml` are BARE top-level entries (`- id: tool-fs` + `disabled: true`, no `name`); restating `name` inside an `insert:` list creates a NEW row and the loader fails with `duplicate loader entry id`.
- Absolute plugin paths in patch rows must be `file:///` URLs on Windows; a bare drive path fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- The `headless` profile composes no preset roster by default — presets are a web-plane feature there unless the profile patch adds `@deepseek-ai/dsh-agent-presets`.

## Compatibility

Built against DeepSeek Harness developer preview v0.1 (source @ `47f943`, npm `@deepseek-ai/dsh-*` 0.0.1-rc.1/rc.5 generation). **DeepSeek warns the preview will break compatibility** — pin accordingly and re-verify on upgrade. The plugin touches only public seams (`defineTool`, `ctx.fs`, `fs/*` events, `ctx.subprocess`, presets).

## Development

```sh
npm install
npm run check   # typecheck + 105 tests
```

## Credits

[pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) for the protocol (context hashing, op set, strict-anchor rules, grep-anchor loop), [oh-my-pi](https://github.com/can1357/oh-my-pi) for the hashline technique.

## License

MIT
