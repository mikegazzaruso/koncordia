#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDebate, type SeatConfig } from "./debate.js";
import { KoncordiaClient } from "./mcp.js";
import { providerByName } from "./providers.js";

const USAGE = `koncordia — local driver for Koncordia rooms

Usage:
  koncordia debate <roomId> [--seat name=provider[:model]]... [options]
  koncordia debate --topic "..." [--kind styleguide|decision|rule|spec|other] [--slug s] [--max-rounds 8] [--seat ...]... [options]
  koncordia status <roomId>
  koncordia transcript <roomId>
  koncordia get <slug> [--version n]

Seats default to: --seat claude=claude --seat codex=codex
  provider: claude (Claude Code CLI) | codex (Codex CLI)
  model:    optional, e.g. claude=claude:claude-opus-4-8  codex=codex:gpt-5.6-terra

Options:
  --url <mcp url>       default $KONCORDIA_URL or http://127.0.0.1:8787/mcp
  --key <api key>       default $KONCORDIA_API_KEY (omit for a --no-auth server)
  --max-turns <n>       cap on CLI invocations (default 40)
  --claude-bin <path>   default "claude"
  --codex-bin <path>    default "codex"
  --quiet               only print the final result
  --verbose             also print CLI stderr
`;

function out(s: string) {
  process.stdout.write(s + "\n");
}
function die(s: string): never {
  process.stderr.write(s + "\n");
  process.exit(1);
}

function parseSeat(spec: string): { seat: string; provider: string; model?: string } {
  const m = /^([a-z0-9][a-z0-9_-]*)=([a-z]+)(?::(.+))?$/i.exec(spec.trim());
  if (!m) die(`bad --seat "${spec}"; expected name=provider[:model]`);
  return { seat: m[1].toLowerCase(), provider: m[2].toLowerCase(), model: m[3] };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      key: { type: "string" },
      seat: { type: "string", multiple: true },
      topic: { type: "string" },
      kind: { type: "string" },
      slug: { type: "string" },
      "max-rounds": { type: "string" },
      "max-turns": { type: "string" },
      "claude-bin": { type: "string" },
      "codex-bin": { type: "string" },
      version: { type: "string" },
      quiet: { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals[0]) return out(USAGE);

  const url = values.url ?? process.env.KONCORDIA_URL ?? "http://127.0.0.1:8787/mcp";
  const key = values.key ?? process.env.KONCORDIA_API_KEY;
  const client = await KoncordiaClient.connect(url, key).catch((e) => die(`cannot connect to ${url}: ${(e as Error).message}`));

  try {
    switch (positionals[0]) {
      case "status":
        return out(JSON.stringify(await client.status(need(positionals[1], "roomId")), null, 2));
      case "transcript":
        return out((await client.transcript(need(positionals[1], "roomId"))).rendered);
      case "get": {
        const g = await client.guide(need(positionals[1], "slug"), values.version ? Number(values.version) : undefined);
        out(g.content);
        process.stderr.write(JSON.stringify(g.meta) + "\n");
        return;
      }
      case "debate":
        return await debate();
      default:
        die(USAGE);
    }
  } finally {
    await client.close().catch(() => {});
  }

  async function debate() {
    const seatSpecs = (values.seat?.length ? values.seat : ["claude=claude", "codex=codex"]).map(parseSeat);
    const bins = { claude: values["claude-bin"], codex: values["codex-bin"] };
    const seats: SeatConfig[] = seatSpecs.map((s) => ({ seat: s.seat, provider: providerByName(s.provider, bins), model: s.model }));

    let roomId = positionals[1];
    if (!roomId) {
      if (!values.topic) die("debate needs a <roomId> or --topic to create a room");
      const created = await client.createRoom({
        topic: values.topic,
        seats: seats.map((s) => s.seat),
        guideKind: values.kind,
        guideSlug: values.slug,
        maxRounds: values["max-rounds"] ? Number(values["max-rounds"]) : undefined,
      });
      roomId = created.roomId;
      out(`room ${roomId} · guide ${created.guideSlug} · seats ${created.seats.join(", ")} · max rounds ${created.maxRounds}`);
    }

    const log = values.quiet ? () => {} : (l: string) => process.stderr.write(l + "\n");
    const res = await runDebate({
      client,
      mcp: { url, key },
      roomId,
      seats,
      maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
      log,
      verbose: values.verbose,
      onEntry: values.quiet ? undefined : (r) => out(r + "\n"),
    });

    out(`\n=== ${res.stoppedBecause} after ${res.turns} turn(s) · room ${roomId} · state ${res.status.state} · round ${res.status.round}/${res.status.maxRounds} ===`);
    if (res.guide) {
      out(`\n--- ${res.status.guideSlug} v${res.guide.meta.version} (${res.status.guideKind}) agreed by ${(res.guide.meta.agreedBy as string[]).join(", ")} ---\n`);
      out(res.guide.content);
    }
    if (res.error) die(res.error);
    if (res.stoppedBecause !== "agreed") process.exitCode = 2;
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) die(`missing <${what}>`);
  return v;
}

main().catch((e) => die(`fatal: ${(e as Error).stack ?? e}`));
