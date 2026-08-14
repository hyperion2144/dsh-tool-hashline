/**
 * Model-facing guidance for the hashline edit tool. Shipped as data so the
 * prompt-consistency tests can assert examples match the schema.
 * @module dsh-tool-hashline/prompts/edit
 */

export const EDIT_GUIDANCE = `Use the edit tool for targeted changes to existing UTF-8 text files, anchored by the LINE#HASH tags the read tool shows. Every op is validated against the file's current content before anything is written; a stale anchor fails the whole call and asks you to re-read. Never guess, relocate, or fuzzy-match anchors.

One edit call can carry multiple ops; all are validated against the same pre-edit snapshot and applied together:

- replace: replace one line (pos) or an inclusive range (pos + end) with lines. Use lines: [] to delete the range.
- append: insert lines after pos; omit pos to append at the end of the file.
- prepend: insert lines before pos; omit pos to prepend at the start of the file.
- replace_text: literal substring replacement; must match exactly once (available only when enabled by configuration).

lines must be literal file content — never include LINE#HASH prefixes or diff markers. A successful edit returns an "--- Anchors A-B ---" block with fresh anchors for the changed region; reuse them for the next edit without re-reading. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.`
