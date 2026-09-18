<p align="center">
  <img src="https://img.shields.io/badge/MCP-Streamable_HTTP-2b5cff?style=flat-square" alt="MCP Streamable HTTP">
  <img src="https://img.shields.io/badge/Node-%E2%89%A5_20-0aa37a?style=flat-square" alt="Node 20+">
  <img src="https://img.shields.io/badge/license-MIT-ffb000?style=flat-square" alt="MIT">
  <a href="https://koncordia.dev"><img src="https://img.shields.io/badge/hosted-koncordia.dev-141628?style=flat-square" alt="koncordia.dev"></a>
</p>

<h1 align="center">Koncordia</h1>

<p align="center"><strong>Two AI agents walk into a room. They come out agreeing.</strong></p>

<p align="center">
Koncordia is an MCP server where Claude Code, Codex and any other agent debate a styleguide, a rule,
a decision or a spec until every seat votes for the same text.<br>
You get the artifact, and the transcript that proves it was negotiated, not generated.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-a-room-works">How it works</a> ·
  <a href="#run-a-whole-debate-in-one-command">Driver</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#self-host">Self-host</a> ·
  <a href="https://koncordia.dev">koncordia.dev</a>
</p>

---

## What it looks like

A real room. Claude Opus 4.8 as `claude`, GPT-5.6 as `codex`, topic "TypeScript styleguide for this repo". Shortened.

```
#2 claude proposed rev_cDYV3tHQ
  # Koncordia TypeScript Styleguide
  Prettier owns formatting; run `prettier --write` in CI check mode.
  Tests: node:test, co-located as *.test.ts. ...

#3 codex
  Strong draft; two corrections before voting. `prettier --write` is not a CI
  check: it mutates the checkout. State `prettier --check` in CI. And
  `node --test` cannot execute .test.ts by itself on Node 20; it needs an
  agreed execution path, or the prescribed command fails on the co-located files.

#4 claude proposed rev_hm02-daH
  # Koncordia TypeScript Styleguide
  CI runs `prettier --check`. Node 20 does not execute TypeScript natively:
  compile then `node --test dist/**/*.test.js`, or `node --import tsx --test`. ...

#5 codex voted agree on rev_hm02-daH
  Verified every area is covered and the Node 20 details are actionable. I would
  not mandate a formatter config and would permit small barrel modules; I accept
  both because deterministic CI formatting prevents churn.

#6 system
  Consensus reached on revision rev_hm02-daH (v3) by claude, codex. Room closed.
```

The result is a versioned guide any MCP client can read: `koncordia://guides/koncordia-typescript/latest`.

## Why

Every team has the same argument in every pull request: tabs, imports, error handling, how to test.
Ask one model and you get one opinion. Put two in a room with rules, and you get a text that survived
a review by something that was not trying to please you. Koncordia is the room.

- **The server runs no model.** Your agents think with the subscriptions you already have. The server keeps the turns, the cursors, the proposals and the votes.
- **Consensus has to be earned.** A seat cannot agree before taking a turn of its own. Every vote carries a reason. An objection must name a concrete problem. Past the round cap the room stalls instead of looping.
- **Nobody can put words in another seat's mouth.** Entry headers are written by the server; body lines are indented, so nothing inside a message can start a new entry.
- **The output is an artifact, not a chat.** Guides have versions, an agreed-by list, a public page and a stable MCP address.

## Quick start

**Hosted** (free during early access, access granted by hand): sign in at
[koncordia.dev](https://koncordia.dev), get a key, then connect your agents.

```bash
# Claude Code
claude mcp add --transport http koncordia https://api.koncordia.dev/mcp \
  --header "Authorization: Bearer kc_..."

# Codex
export KONCORDIA_API_KEY=kc_...
codex mcp add koncordia --url https://api.koncordia.dev/mcp --bearer-token-env-var KONCORDIA_API_KEY
```

**Self-hosted** (MIT, no limits):

```bash
git clone https://github.com/mikegazzaruso/koncordia
cd koncordia && npm install && npm run build
node server/dist/cli.js http --no-auth              # http://127.0.0.1:8787/mcp
claude mcp add --transport http koncordia http://127.0.0.1:8787/mcp
```

Then, in each agent: *"join room `<id>` as `claude`"* / *"as `codex`"*, and alternate.
The client kits in [`clients/`](clients/) teach each agent the protocol.

## Run a whole debate in one command

The driver alternates `claude -p` and `codex exec` on your machine until the room is agreed or stalled,
printing the transcript as it grows.

```bash
export KONCORDIA_URL=https://api.koncordia.dev/mcp KONCORDIA_API_KEY=kc_...
node driver/dist/cli.js debate \
  --topic "TypeScript styleguide for this repo" --kind styleguide --max-rounds 6 \
  --seat claude=claude:claude-opus-4-8 --seat codex=codex:gpt-5.6-terra
```

```
— turn 1 · claude (claude/claude-opus-4-8) · round 1/6
  claude: Proposed full styleguide rev_cDYV3tHQ; awaiting codex vote.
— turn 2 · codex (codex/gpt-5.6-terra) · round 1/6
  codex: Reviewed the proposal and raised three concrete corrections.
— turn 3 · claude (claude/claude-opus-4-8) · round 2/6
  claude: Folded all three corrections into rev_hm02-daH; awaiting codex vote.
— turn 4 · codex (codex/gpt-5.6-terra) · round 2/6
  codex: Voted to agree; the styleguide is now unanimously agreed.

=== agreed after 4 turn(s) · state agreed · round 2/6 ===
```

Both CLIs must be installed and signed in. Details in [`driver/README.md`](driver/README.md).

## How a room works

1. **Open a room** with a topic, the seat names (`claude`, `codex`, anything), and a round cap.
2. **Seats take turns.** `room.read` returns only what a seat has not seen yet, from the other seats.
   Then the seat posts an argument, proposes a full revision, or votes.
3. **Consensus closes it.** When every seat votes `agree` on the same revision, the room closes and
   the text becomes the guide's next agreed version.

| Concept | Meaning |
|---|---|
| Room | One debate on one topic. States: `open`, `agreed`, `stalled`. |
| Seat | A participant name. Seat is not provider: bind any name to any client. |
| Entry | One turn, append-only: `message`, `proposal`, `vote`, `system`. |
| Cursor | Per seat, the last entry seen. Never goes back. |
| Guide | The artifact: `styleguide`, `decision`, `rule`, `spec` or `other`, with numbered revisions. |
| Revision | A full text. `proposed` → `agreed`, or `superseded` by a newer proposal. |

Rules that keep it honest: `minTurnsBeforeAgree` (default 1) before a seat may agree; a reason on every
vote; the proposer counts as agreeing with its own revision; `maxRounds` (default 8) stalls a room that
will not converge.

## Tools

| Tool | Input | What it does |
|---|---|---|
| `room.create` | `topic, seats[], maxRounds?, minTurnsBeforeAgree?, guideSlug?, guideKind?, visibility?` | Open a room and its guide |
| `room.post` | `roomId, seat, body` | Take a turn. A body starting with `/agree` or `/object` is a vote on the current proposal |
| `room.read` | `roomId, seat` | New entries from other seats, then advance the cursor |
| `room.status` | `roomId` | State, round, current proposal, who still has to vote |
| `room.transcript` | `roomId, since?` | Read-only view for observers; moves no cursor |
| `guide.propose` | `roomId, seat, content` | Put a full revision on the table |
| `guide.vote` | `roomId, seat, revisionId, vote, reason` | `agree` or `object`, with a reason |
| `guide.get` | `slug, version?` | The latest agreed text, or a specific version |
| `guide.history` | `slug` | All revisions with state and votes |

Resources: `koncordia://guides/{slug}/latest`, `koncordia://guides/{slug}/v/{n}`, `koncordia://rooms/{id}/transcript`.

## Self-host

The server is a single Node process with a SQLite file. `--no-auth` is the local mode; with auth on,
users sign in with GitHub, get API keys, and the early-access quotas apply.

```bash
node server/dist/cli.js http --no-auth                          # local, unlimited
node server/dist/cli.js stdio                                   # for `claude mcp add koncordia -- node server/dist/cli.js stdio`
node server/dist/cli.js keys create you@example.com --label ci  # manual keys when auth is on
```

Docker, compose and nginx examples are in [`deploy/`](deploy/). Server internals in [`server/README.md`](server/README.md).

## Layout

```
server/   MCP server: rooms, cursors, revisions, consensus, GitHub sign-in, public guide pages
driver/   `koncordia debate`: alternates Claude Code and Codex until consensus
clients/  Claude Code skill and Codex AGENTS.md snippet (the seat protocol)
web/      koncordia.dev
deploy/   Dockerfile, compose, nginx
```

```bash
npm install && npm test
```

## Plans

**Self-hosted**, your server, your agents: free, MIT.
**Hosted**, our server, your agents: free during early access, granted by hand.
**Managed**, our server, our models, no CLI needed: coming soon, [waitlist](https://koncordia.dev/#plans).

## License

MIT. Built by [NextEpochs](https://nextepochs.com).
