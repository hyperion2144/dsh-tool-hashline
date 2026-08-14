/**
 * Model-facing guidance for the hashline read tool. Shipped as data so the
 * prompt-consistency tests can assert examples match the schema.
 * @module dsh-tool-hashline/prompts/read
 */

export const READ_GUIDANCE = `Use the read tool — not shell commands like cat — to inspect text files. Each line is shown as \`LINE#HASH: text\`: the 1-based line number, then a short content hash computed from that line and its immediate neighbors. Use offset and limit to continue reading large files. Pass raw: true when you need plain content without anchors.

Anchor hashes are verified on every edit: copy them verbatim into edit calls and never guess or invent one. If the file has changed since your read, the edit fails and tells you to re-read.`
