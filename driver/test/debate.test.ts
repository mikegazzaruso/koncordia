import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Auth, createHttpServer, openDb, Store } from "@koncordia/server";
import { runDebate } from "../src/debate.js";
import { KoncordiaClient } from "../src/mcp.js";
import { turnPrompt } from "../src/prompt.js";
import type { Provider, RunOptions } from "../src/providers.js";

let srv: Server;
let url: string;
let store: Store;
let client: KoncordiaClient;

beforeEach(async () => {
  const db = openDb(":memory:");
  store = new Store(db);
  srv = createHttpServer({ store, auth: new Auth(db), noAuth: true });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
  client = await KoncordiaClient.connect(url);
});
afterEach(async () => {
  await client.close();
  await new Promise((r) => srv.close(r));
});

/** A scripted "model": each call runs the next step directly against the store, like a CLI would via MCP. */
function scripted(name: string, steps: Array<(o: RunOptions) => string | void>): Provider & { calls: RunOptions[] } {
  const calls: RunOptions[] = [];
  return {
    name,
    calls,
    async run(o) {
      calls.push(o);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      const text = step(o) ?? "PASS";
      return { text, sessionId: o.sessionId ?? `${name}-session` };
    },
  };
}

describe("runDebate", () => {
  it("alternates seats until consensus and returns the agreed guide", async () => {
    const room = store.createRoom("local", { topic: "Tabs vs spaces", seats: ["claude", "codex"], guideKind: "rule", maxRounds: 4 });
    const claude = scripted("claude", [
      () => {
        store.post("local", room.id, "claude", "Spaces, two of them.");
        return "posted my position";
      },
      () => {
        const rev = store.status("local", room.id).currentRevision!;
        store.vote("local", room.id, "claude", rev.id, "agree", "reviewed the rule; two spaces matches the repo");
        return "agreed";
      },
    ]);
    const codex = scripted("codex", [
      () => {
        store.propose("local", room.id, "codex", "# Rule\nTwo spaces.");
        return "proposed";
      },
    ]);
    const entries: string[] = [];
    const res = await runDebate({
      client,
      mcp: { url },
      roomId: room.id,
      seats: [
        { seat: "claude", provider: claude },
        { seat: "codex", provider: codex },
      ],
      onEntry: (r) => entries.push(r),
    });
    expect(res.stoppedBecause).toBe("agreed");
    expect(res.turns).toBe(3);
    expect(res.status.state).toBe("agreed");
    expect(res.guide?.content).toContain("Two spaces.");
    // sessions are threaded: second claude call resumes the first
    expect(claude.calls[0].sessionId).toBeUndefined();
    expect(claude.calls[1].sessionId).toBe("claude-session");
    // first prompt carries the contract, the resumed one is short
    expect(claude.calls[0].prompt).toContain("Peer contract");
    expect(claude.calls[1].prompt).not.toContain("Peer contract");
    expect(claude.calls[1].prompt).toContain("Your turn again");
    // live transcript was streamed
    expect(entries.join("\n")).toContain("#3 codex proposed");
    expect(entries.join("\n")).toContain("Consensus reached");
  });

  it("stops with no_progress when every seat passes", async () => {
    const room = store.createRoom("local", { topic: "t", seats: ["a", "b"] });
    const pass = scripted("claude", [() => "PASS"]);
    const res = await runDebate({ client, mcp: { url }, roomId: room.id, seats: [{ seat: "a", provider: pass }, { seat: "b", provider: pass }] });
    expect(res.stoppedBecause).toBe("no_progress");
    expect(res.turns).toBe(2);
    expect(res.status.state).toBe("open");
  });

  it("stops when the room stalls at the round cap", async () => {
    const room = store.createRoom("local", { topic: "t", seats: ["a", "b"], maxRounds: 1 });
    const talker = (seat: string) => scripted("claude", [() => void store.post("local", room.id, seat, "still disagree")]);
    const res = await runDebate({ client, mcp: { url }, roomId: room.id, seats: [{ seat: "a", provider: talker("a") }, { seat: "b", provider: talker("b") }] });
    expect(res.stoppedBecause).toBe("stalled");
    expect(res.turns).toBe(2);
    expect(res.guide).toBeUndefined();
  });

  it("surfaces CLI failures and stops", async () => {
    const room = store.createRoom("local", { topic: "t", seats: ["a", "b"] });
    const boom: Provider = { name: "claude", run: async () => { throw new Error("claude exited 1: no auth"); } };
    const res = await runDebate({ client, mcp: { url }, roomId: room.id, seats: [{ seat: "a", provider: boom }, { seat: "b", provider: boom }] });
    expect(res.stoppedBecause).toBe("error");
    expect(res.error).toMatch(/no auth/);
  });

  it("rejects a seat that is not in the room", async () => {
    const room = store.createRoom("local", { topic: "t", seats: ["a", "b"] });
    const p = scripted("claude", [() => "PASS"]);
    await expect(runDebate({ client, mcp: { url }, roomId: room.id, seats: [{ seat: "zed", provider: p }] })).rejects.toThrow(/not in room/);
  });
});

describe("turnPrompt", () => {
  it("names the tools, the seat and the one-action rule", () => {
    const p = turnPrompt({ roomId: "room_x", seat: "codex", topic: "T", guideKind: "spec", seats: ["claude", "codex"], round: 1, maxRounds: 8, first: true });
    expect(p).toContain('seat "codex"');
    expect(p).toContain("room_read");
    expect(p).toContain("guide_propose");
    expect(p).toContain("exactly ONE action");
    expect(p).toContain("PASS");
  });
});
