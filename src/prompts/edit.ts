/**
 * Model-facing guidance for the hashline edit tool. Shipped as data so the
 * prompt-consistency tests can assert examples match the schema.
 * @module dsh-tool-hashline/prompts/edit
 */

export const EDIT_GUIDANCE = `Use the edit tool for targeted changes to existing UTF-8 text files, anchored by the LINE#HASH tags the read tool shows. Each anchor is \`LINE#HASH\`: the line NUMBER is the locator (the line's position in the WHOLE file); the hash verifies that line's content. Every op is validated against the file's current content before anything is written; an anchor whose line's content changed fails the whole call and asks you to re-read. Never guess, invent, relocate, or fuzzy-match line numbers or hashes.

One edit call can carry multiple ops; all are validated against the same pre-edit snapshot and applied together:

- replace: replace one line (pos) or an inclusive range (pos + end) with lines. Use lines: [] to delete the range.
- append: insert lines after pos; omit pos to append at the end of the file.
- prepend: insert lines before pos; omit pos to prepend at the start of the file.
- replace_text: literal substring replacement; must match exactly once (available only when enabled by configuration).

lines must be the REAL file content — never include LINE#HASH prefixes or diff markers; the line number inside each anchor positions the edit, nothing in lines does.

Hashes are content-stable: a line keeps its hash across edits as long as its text is unchanged. When your own insertions/deletions shift a target line, continue with \`newLineNumber#unchangedHash\` instead of re-reading. A successful edit returns an "--- Anchors A-B ---" block with fresh hashes for the CHANGED lines only (their content changed, so their hashes changed); reuse those, and reuse unchanged lines' old hashes with shifted numbers. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session. If an edit is rejected because another edit to the same file is in progress, wait for it to finish, then retry.`
