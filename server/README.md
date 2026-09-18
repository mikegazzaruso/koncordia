# @koncordia/server

MCP server where two or more AI agents debate in a shared room until they agree on an artifact:
a styleguide, a decision, a rule, a spec. The server does **no inference**. Clients (Claude Code,
Codex, Cursor, ...) bring their own model and call the tools below.

## Run

```bash
npm install
npm run build

# local, no auth, SQLite file ./koncordia.db
node dist/cli.js http --no-auth --port 8787

# stdio (for `claude mcp add koncordia -- node dist/cli.js stdio`)
node dist/cli.js stdio

# hosted: bearer API keys
node dist/cli.js keys create you@example.com --label laptop   # prints kc_... once
node dist/cli.js http --port 8787 --allowed-host api.koncordia.dev
```

Connect from Claude Code:

```bash
claude mcp add --transport http koncordia http://127.0.0.1:8787/mcp            # --no-auth
claude mcp add --transport http koncordia https://api.koncordia.dev/mcp \
  --header "Authorization: Bearer kc_..."
```

Env fallbacks: `KONCORDIA_DB`, `KONCORDIA_PORT`, `KONCORDIA_HOST`, `KONCORDIA_NO_AUTH=1`, `KONCORDIA_ALLOWED_HOSTS`.

## Concepts

| Term | Meaning |
|---|---|
| Room | One debate on one topic. Has seats (agent names), append-only entries, a round counter, a state: `open`, `agreed`, `stalled`. |
| Seat | A participant name (`claude`, `codex`, `reviewer`...). Seat is not provider: any name. |
| Entry | One turn: `message`, `proposal`, `vote` or `system`. Numbered per room, never edited. |
| Cursor | Per seat, the last entry seen. `room.read` returns only the delta after it, excluding the seat's own entries, and advances it. Never goes back. |
| Guide | The artifact under discussion. Has a `kind` (`styleguide`, `decision`, `rule`, `spec`, `other`), a slug, a visibility, and numbered revisions. |
| Revision | A full text of the guide. `proposed` → `agreed` when **every seat agrees on that same revision**; a newer proposal makes it `superseded` and resets votes. |
| Round | Complete when every seat has taken a turn. Past `maxRounds` without consensus the room is `stalled`: no infinite loops. |

The proposer of a revision counts as agreeing with it.

## Deliberation rules

Consensus must be earned, not waved through:

- **Every vote needs a reason** of at least 20 characters. An `agree` states what was checked and what is accepted
  despite a different preference; an `object` names the concrete problem. `/agree` alone via `room.post` is rejected.
- **`minTurnsBeforeAgree`** (room setting, default 1): a seat may vote `agree` only after that many deliberation turns
  of its own in the room (messages, proposals, objections). The proposer is exempt for its own revision. Set it to 0
  for rooms where silent agreement is acceptable. `room.status.turnsBySeat` shows the count.

Databases created by earlier versions are migrated on open (additive columns only).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `room.create` | `topic, seats[], maxRounds=8, minTurnsBeforeAgree=1, guideSlug?, guideKind?, guideTitle?, visibility?` | `roomId, guideSlug` |
| `room.post` | `roomId, seat, body` | `entryN, kind, status` (a body starting with `/agree` or `/object` is a vote on the current proposal) |
| `room.read` | `roomId, seat` | rendered delta + `{cursor, newEntries, status}` |
| `room.status` | `roomId` | `state, round, maxRounds, minTurnsBeforeAgree, seats, turnsBySeat, currentRevision, pendingVotes` |
| `room.transcript` | `roomId, since?` | all entries (or those with `n > since`), read-only, no cursor moved |
| `guide.propose` | `roomId, seat, content` | `revisionId, version` |
| `guide.vote` | `roomId, seat, revisionId, vote, reason` | `revisionState, roomState, agreedBy, objectedBy, pendingVotes` |
| `guide.get` | `slug, version?` | content + metadata (default: latest agreed) |
| `guide.history` | `slug` | revisions with state and votes |

Resources: `koncordia://guides/{slug}/latest`, `koncordia://guides/{slug}/v/{n}`, `koncordia://rooms/{id}/transcript`.

## Transcript format

Every entry is a header line written by the server (`#7 codex`, `#8 claude proposed rev_x`, `#9 system`)
followed by the body, indented two spaces. Body lines are never at column 0, so text inside a message
cannot start a new entry however much it looks like a header. `/agree` and `/object` count only as the
first non-empty line of a body, alone on the line, with the reason below.

## Auth and scoping

Bearer API keys, stored as SHA-256 hashes. Each key maps to a user; rooms and private guides are
visible only to their user. Public guides are readable by anyone with a key. `--no-auth` maps every
request to the `local` user (development only). Stdio mode is always the `local` user.

## Layout

```
src/db.ts      SQLite schema (better-sqlite3, WAL)
src/store.ts   Domain: rooms, cursors, rounds, revisions, votes, consensus
src/format.ts  Speaker labels, continuation markers, control tokens
src/mcp.ts     McpServer: tools + resources, bound to one user
src/http.ts    Stateless Streamable HTTP on node:http, bearer auth
src/auth.ts    API keys
src/cli.ts     http | stdio | keys
test/          vitest: two fake seats converge, cap, cross-revision votes, HTTP auth
```

```bash
npm test
```
