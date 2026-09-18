import type { KoncordiaClient, RoomStatus } from "./mcp.js";
import { turnPrompt } from "./prompt.js";
import type { McpTarget, Provider } from "./providers.js";

export interface SeatConfig {
  seat: string;
  provider: Provider;
  model?: string;
}

export interface DebateOptions {
  client: KoncordiaClient;
  mcp: McpTarget;
  roomId: string;
  seats: SeatConfig[];
  /** Hard cap on CLI invocations, independent of the room's round cap. Default 40. */
  maxTurns?: number;
  cwd?: string;
  log?: (line: string) => void;
  /** Called with each new transcript block as it appears (for live display). */
  onEntry?: (rendered: string) => void;
  verbose?: boolean;
}

export interface DebateResult {
  status: RoomStatus;
  turns: number;
  guide?: { content: string; meta: Record<string, unknown> };
  stoppedBecause: "agreed" | "stalled" | "max_turns" | "no_progress" | "error";
  error?: string;
}

/**
 * Alternate seats in order. Each turn: hand the seat's CLI a prompt that tells it to
 * room_read and take one action through the MCP server, then check whether the room moved.
 * The driver never reasons about content; it only sequences and watches for progress.
 */
export async function runDebate(o: DebateOptions): Promise<DebateResult> {
  const log = o.log ?? (() => {});
  const maxTurns = o.maxTurns ?? 40;
  const cwd = o.cwd ?? process.cwd();
  const sessions = new Map<string, string>();
  let printed = 0;

  const printNew = async () => {
    const t = await o.client.transcript(o.roomId, printed);
    if (t.entries.length) {
      o.onEntry?.(t.rendered);
      printed = t.entries[t.entries.length - 1].n;
    }
  };

  let status = await o.client.status(o.roomId);
  const roomSeats = new Set(status.seats);
  for (const s of o.seats) {
    if (!roomSeats.has(s.seat)) throw new Error(`seat "${s.seat}" is not in room ${o.roomId} (room seats: ${status.seats.join(", ")})`);
  }
  const unassigned = status.seats.filter((s) => !o.seats.some((c) => c.seat === s));
  if (unassigned.length) log(`warning: no provider for seat(s) ${unassigned.join(", ")}; they will never take a turn`);

  await printNew();
  let turns = 0;
  let idle = 0;
  let stoppedBecause: DebateResult["stoppedBecause"] = "max_turns";
  let error: string | undefined;

  while (turns < maxTurns) {
    if (status.state !== "open") break;
    const cfg = o.seats[turns % o.seats.length];
    turns++;
    const before = status.entryCount;
    const first = !sessions.has(cfg.seat);
    log(`— turn ${turns} · ${cfg.seat} (${cfg.provider.name}${cfg.model ? `/${cfg.model}` : ""}) · round ${status.round}/${status.maxRounds}`);
    const prompt = turnPrompt({
      roomId: o.roomId,
      seat: cfg.seat,
      topic: status.topic,
      guideKind: status.guideKind,
      seats: status.seats,
      round: status.round,
      maxRounds: status.maxRounds,
      first,
    });
    try {
      const res = await cfg.provider.run({
        prompt,
        sessionId: sessions.get(cfg.seat),
        model: cfg.model,
        mcp: o.mcp,
        cwd,
        onStderr: o.verbose ? (s) => log(`  [${cfg.seat} stderr] ${s.trimEnd()}`) : undefined,
      });
      if (res.sessionId) sessions.set(cfg.seat, res.sessionId);
      const summary = res.text.trim().split("\n").slice(-1)[0] ?? "";
      if (summary) log(`  ${cfg.seat}: ${summary.slice(0, 300)}`);
    } catch (e) {
      error = (e as Error).message;
      log(`  ${cfg.seat} failed: ${error}`);
      stoppedBecause = "error";
      break;
    }
    await printNew();
    status = await o.client.status(o.roomId);
    if (status.entryCount === before) {
      idle++;
      if (idle >= o.seats.length) {
        log(`no seat made progress for ${idle} consecutive turns; stopping`);
        stoppedBecause = "no_progress";
        break;
      }
    } else {
      idle = 0;
    }
  }

  status = await o.client.status(o.roomId);
  if (status.state === "agreed") stoppedBecause = "agreed";
  else if (status.state === "stalled") stoppedBecause = "stalled";

  const result: DebateResult = { status, turns, stoppedBecause, error };
  if (status.state === "agreed") result.guide = await o.client.guide(status.guideSlug);
  return result;
}
