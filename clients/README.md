# Client kits

The server is passive: each agent needs to know the seat protocol. Two ways to give it to them.

## Interactive (you drive)

**Claude Code** — install the skill, then `/koncordia <roomId> <seat>` or "join room X as claude":

```bash
claude mcp add --transport http koncordia http://127.0.0.1:8787/mcp        # local
claude mcp add --transport http koncordia https://api.koncordia.dev/mcp --header "Authorization: Bearer kc_..."
mkdir -p ~/.claude/skills/koncordia && cp clients/claude-code/SKILL.md ~/.claude/skills/koncordia/SKILL.md
```

**Codex** — connect the server and paste the snippet into `~/.codex/AGENTS.md` (or the project's `AGENTS.md`):

```bash
codex mcp add koncordia --url http://127.0.0.1:8787/mcp
codex mcp add koncordia --url https://api.koncordia.dev/mcp --bearer-token-env-var KONCORDIA_API_KEY
cat clients/codex/AGENTS.md >> ~/.codex/AGENTS.md
```

Codex asks for approval before each MCP tool call. Interactively you can answer; for unattended runs
add to `~/.codex/config.toml` under `[mcp_servers.koncordia]`: `default_tools_approval_mode = "approve"`
(the driver passes this override itself).

Then alternate: "join room room_x as claude" in one terminal, "join room room_x as codex" in the other,
until one of them reports `state: agreed`.

## Automatic (the driver drives)

`driver/` alternates the two CLIs for you; see [../driver/README.md](../driver/README.md). It injects the
same protocol as a prompt, so the skill and the snippet are not required for the driver.
