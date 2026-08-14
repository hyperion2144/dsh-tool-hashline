# dsh-tool-hashline

Hash-anchored `read` and `edit` tool plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Every line carries a short content hash; edits reference `LINE#HASH` anchors that are validated against the file's current content before anything is written. Stale anchors are rejected — never relocated, never fuzzy-matched.

Protocol adopted from [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) (MIT), inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi). See `PLAN.md` for the full design, the verified integration model, and the test plan.

## Status

Working: hash core, hashline `read`, hashline `edit` (replace/append/prepend/replace_text), prompt guidance, and end-to-end integration tests against the real `fs-local` backend + observation policy — 80 tests green. Composition is verified at the registry level; a live-session smoke on a running `dsh` is the remaining acceptance step.

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

All ops in one call validate against the same pre-edit snapshot and apply together. A successful edit returns an `--- Anchors A-B ---` block with fresh anchors for the changed region — consecutive edits chain without a re-read. A no-op edit warns instead of failing; three consecutive identical no-ops raise `HASHLINE_NOOP_LOOP`.

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
  name: 'C:/absolute/path/to/dsh-tool-hashline/src/index.ts'
```

Published (npm):

```sh
dsh plugin --profile web add dsh-tool-hashline
# preset/agent.cordis.yml row:
- id: tool-hashline
  name: '@deepseek-ai/dsh-tool-hashline'
```

### 2. Author the `hashline` preset

Either drop the shipped files into the user preset root (discovery scans it live):

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

On the `hashline` preset, `read`/`edit` are the hashline versions (preset scope layer shadows the global `tool-fs` tools by name); `write`, `read_image`, `glob`, `grep`, `bash`, and everything else keep working from the host composition. Subagents inherit the preset.

## Config

All optional (set on the preset row's `config`):

| Key | Default | Meaning |
|---|---|---|
| `hashLength` | 2 | Hash characters per line (2-4) |
| `replaceText` | false | Allow the literal `replace_text` op |
| `readLimit` | 2000 | Max lines per `read` |
| `readMaxLineLength` | 2000 | Chars per line before truncation |
| `readMaxBytes` | 51200 | Byte cap per `read` window |
| `readStreamMinSize` | 10485760 | Files at/above this size stream |

## Compatibility

Built against DeepSeek Harness developer preview v0.1 (source @ `47f943`, npm `@deepseek-ai/dsh-*` 0.0.1-rc.1/rc.5 generation). **DeepSeek warns the preview will break compatibility** — pin accordingly and re-verify on upgrade. The plugin touches only public seams (`defineTool`, `ctx.fs`, `fs/*` events, presets).

## Development

```sh
npm install
npm run check   # typecheck + 80 tests
```

## Credits

[pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) for the protocol (context hashing, op set, strict-anchor rules), [oh-my-pi](https://github.com/can1357/oh-my-pi) for the hashline technique.

## License

MIT
