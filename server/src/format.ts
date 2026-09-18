/**
 * Transcript format.
 *
 * Every entry is rendered as one header line at column 0 followed by the body,
 * every line of which is indented by two spaces:
 *
 *   #3 codex
 *     Strong draft; two corrections before voting. ...
 *
 *   #4 claude proposed rev_hm02-daH
 *     # Koncordia TypeScript Styleguide
 *     ...
 *
 *   #5 codex voted agree on rev_hm02-daH
 *     Verified every area is covered ...
 *
 * The header is written by the server, never by the client. Because body lines are
 * always indented, nothing inside a message can start a new header, however much
 * it looks like one. That is what makes the delta safe to hand to a model verbatim.
 */

export type EntryKind = "message" | "proposal" | "vote" | "system";

export interface Entry {
  n: number;
  seat: string;
  kind: EntryKind;
  body: string;
  ref: string | null;
  ts: string;
}

export type ControlToken = "agree" | "object";

const CONTROL_RE = /^\/(agree|object)\s*$/i;

/**
 * `/agree` or `/object` counts as a vote only when it is the first non-empty line of the
 * body, alone on that line. Anywhere else it is ordinary text.
 * Returns the token and the remaining text (the reason), or null.
 */
export function parseControlToken(body: string): { token: ControlToken; rest: string } | null {
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return null;
  const m = CONTROL_RE.exec(lines[i].trim());
  if (!m) return null;
  const rest = lines
    .slice(i + 1)
    .join("\n")
    .trim();
  return { token: m[1].toLowerCase() as ControlToken, rest };
}

/** Header line for an entry: `#n seat`, plus what happened for proposals and votes. */
export function headerFor(e: Entry): string {
  switch (e.kind) {
    case "proposal":
      return `#${e.n} ${e.seat} proposed ${e.ref ?? "?"}`;
    case "vote": {
      const first = e.body.split("\n")[0]?.trim().toLowerCase();
      const verb = first === "/object" ? "objected to" : "voted agree on";
      return `#${e.n} ${e.seat} ${verb} ${e.ref ?? "?"}`;
    }
    case "system":
      return `#${e.n} system`;
    default:
      return `#${e.n} ${e.seat}`;
  }
}

/** Body as shown in a transcript: for votes the control line is dropped, the reason stays. */
export function displayBody(e: Entry): string {
  const text = e.body.replace(/\r\n/g, "\n");
  if (e.kind !== "vote") return text;
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  return first >= 0 && CONTROL_RE.test(lines[first].trim()) ? lines.slice(first + 1).join("\n").trim() : text;
}

export function renderEntry(e: Entry): string {
  const body = displayBody(e);
  const lines = body ? body.split("\n").map((l) => `  ${l}`) : [];
  return [headerFor(e), ...lines].join("\n");
}

export function renderEntries(entries: Entry[]): string {
  return entries.map(renderEntry).join("\n\n");
}
