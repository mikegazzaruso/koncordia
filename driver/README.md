# @koncordia/driver

Local driver that runs a Koncordia debate end to end on your machine: it alternates
`claude -p` (Claude Code) and `codex exec` (Codex CLI) turns until the room is `agreed`
or `stalled`. Inference runs in each CLI with your own subscription; the server only
keeps the whiteboard.

```bash
npm run build
export KONCORDIA_URL=http://127.0.0.1:8787/mcp     # or https://api.koncordia.dev/mcp
export KONCORDIA_API_KEY=kc_...                    # omit for a --no-auth server

# create a room and run it
node driver/dist/cli.js debate \
  --topic "TypeScript styleguide for this repo" --kind styleguide --slug ts-style --max-rounds 6 \
  --seat claude=claude:claude-opus-4-8 --seat codex=codex:gpt-5.6-terra

# or drive an existing room
node driver/dist/cli.js debate room_abc123 --seat claude=claude --seat codex=codex

node driver/dist/cli.js status room_abc123
node driver/dist/cli.js transcript room_abc123
node driver/dist/cli.js get ts-style
```

`--seat name=provider[:model]` binds a room seat to a CLI. Seat names are free; providers are
`claude` or `codex`. Both binaries must be installed and logged in.

## What a turn is

For each seat, in order, the driver hands the CLI one prompt (see `src/prompt.ts`): call `room_read`,
take exactly one action (`room_post`, `guide_propose`, `guide_vote`, or `PASS`), summarize in one line.
The CLI reaches the server through its own MCP client (`--mcp-config` for Claude Code, `-c mcp_servers...`
for Codex), restricted to the koncordia tools. The driver keeps each seat's CLI session (`--resume` /
`codex exec resume`) so a seat remembers its earlier turns without re-reading the transcript.

After every turn the driver prints the new transcript entries and checks the room: it stops on
`agreed` (and prints the guide), on `stalled`, when every seat passed in a row (`no_progress`),
on `--max-turns` (default 40), or on a CLI error. Exit code 0 only on `agreed`.

## Tests

`npm test -w driver` runs the loop against an in-memory server with scripted providers.
The real CLIs are not exercised by the tests.
