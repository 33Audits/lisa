/**
 * Marker blocks for markdown files lisa does not own.
 *
 * `AGENTS.md` is the user's file — it may already brief their agent on how to run the
 * test suite, which branch to work on, house style. lisa owns exactly the region between
 * its two markers and treats the rest as untouchable text, so re-running install is
 * idempotent rather than destructive.
 *
 * The failure mode this guards against is a *half* block: someone deletes the end marker
 * while editing, and a naive replace swallows the remainder of the file. That is a hard
 * stop, same as unparseable JSON in `merge.ts`.
 */

import { UserError } from "../paths.js";

export const MARKER_START = "<!-- lisa:start -->";
export const MARKER_END = "<!-- lisa:end -->";

function count(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Return the complete desired contents of `file` with `body` sitting inside lisa's
 * markers: replacing the existing block when there is one, appended after a blank line
 * when there isn't.
 */
export function applyMarkerBlock(before: string | null, body: string, file: string): string {
  const block = `${MARKER_START}\n${body.replace(/\s+$/, "")}\n${MARKER_END}`;
  const text = before ?? "";

  const starts = count(text, MARKER_START);
  const ends = count(text, MARKER_END);

  if (starts > 1 || ends > 1) {
    throw new UserError(
      `${file} contains more than one lisa marker block, so lisa can't tell which one it owns.\n` +
        `  Delete the extra \`${MARKER_START}\` … \`${MARKER_END}\` section, then re-run \`lisa install\`.`,
    );
  }

  const s = text.indexOf(MARKER_START);
  const e = text.indexOf(MARKER_END);

  if (s !== -1 && e > s) return text.slice(0, s) + block + text.slice(e + MARKER_END.length);

  if (s !== -1 || e !== -1) {
    const stray = s !== -1 ? MARKER_START : MARKER_END;
    throw new UserError(
      `${file} has a \`${stray}\` marker with no matching pair, so lisa can't tell where its section ends.\n` +
        `  Remove the stray marker (or the whole lisa section), then re-run \`lisa install\`.`,
    );
  }

  if (!text.trim()) return block + "\n";
  return text.replace(/\s*$/, "") + "\n\n" + block + "\n";
}
