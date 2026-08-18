/**
 * Model-facing guidance for the hashline read tool. Shipped as data so the
 * prompt-consistency tests can assert examples match the schema.
 * @module dsh-tool-hashline/prompts/read
 */

export const READ_GUIDANCE = `Use the read tool — not shell commands like cat — to inspect text files. Each line is shown as \`LINE#HASH: text\`: the 1-based line NUMBER is the line's position in the WHOLE file (absolute, independent of any offset), and the HASH is a content-stable check of that line's own text. The line number is what locates a line for edit; the hash verifies its content. Identical lines at different positions share a hash — the line number, never the hash, tells them apart. Use offset and limit to continue reading large files. Pass raw: true when you need plain content without anchors.

Anchors are verified on every edit: copy the line number and hash verbatim into edit calls and never guess or invent either. A line whose content is unchanged keeps the same hash forever — after your edits shift lines, continue with \`newLineNumber#sameHash\` without re-reading. If a line you anchored changed content, the edit fails and tells you to re-read.`
