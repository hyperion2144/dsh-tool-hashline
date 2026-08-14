/**
 * Model-facing guidance for the hashline grep tool. Shipped as data so the
 * prompt-consistency tests can assert examples match the schema.
 * @module dsh-tool-hashline/prompts/grep
 */

export const GREP_GUIDANCE = `Use the grep tool — not shell grep or rg — to search file contents. Every matched line returns as \`LINE#HASH:content\`; copy those anchors verbatim into edit calls without a prior read — matched files are recorded as read for the edit gate.

The pattern is a regular expression unless literal: true. Results respect .gitignore. Use path to scope to a file or directory; use glob to filter by filename pattern (e.g. "**/*.ts"). Set ignore_case for case-insensitive matching.

Set context (0-5) to include surrounding lines around each match. Set limit to cap matched lines (default 50, max 200).

When results are too broad, narrow in this order: check the match count first, then scope with path/glob, then tighten the pattern, and only add context once the set is small.`
