import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Auth } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { createHttpServer } from "../src/http.js";
import { createMcpServer } from "../src/mcp.js";
import { Store } from "../src/store.js";

const text = (r: CallToolResult, i = 0) => (r.content[i] as { text: string }).text;
const last = (r: CallToolResult) => JSON.parse(text(r, r.content.length - 1));

async function inMemoryClient(store: Store, userId: string) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store, userId).connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return client;
}

describe("MCP surface (in-memory transport)", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(openDb(":memory:"));
  });

  it("lists the 9 tools and 3 resource templates", async () => {
    const c = await inMemoryClient(store, "u1");
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["guide.get", "guide.history", "guide.propose", "guide.vote", "room.create", "room.post", "room.read", "room.status", "room.transcript"]);
    const tpl = (await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate).sort();
    expect(tpl).toEqual(["koncordia://guides/{slug}/latest", "koncordia://guides/{slug}/v/{version}", "koncordia://rooms/{id}/transcript"]);
  });

  it("acceptance: create, post from two seats, propose, vote, read resource", async () => {
    // Two clients sharing the same user: same as two CLIs with the same API key.
    const claude = await inMemoryClient(store, "u1");
    const codex = await inMemoryClient(store, "u1");

    const created = last((await claude.callTool({ name: "room.create", arguments: { topic: "Commit message style", seats: ["claude", "codex"], guideKind: "rule", guideSlug: "commits" } })) as CallToolResult);
    const roomId = created.roomId as string;
    expect(created.guideSlug).toBe("commits");

    await claude.callTool({ name: "room.post", arguments: { roomId, seat: "claude", body: "Conventional commits, 50-char subject." } });
    const read = (await codex.callTool({ name: "room.read", arguments: { roomId, seat: "codex" } })) as CallToolResult;
    expect(text(read, 0)).toContain("#2 claude\n  Conventional commits");
    expect(last(read).newEntries).toBe(2); // system + claude

    const prop = last((await codex.callTool({ name: "guide.propose", arguments: { roomId, seat: "codex", content: "# Commits\n- conventional\n- subject <= 50" } })) as CallToolResult);
    const vote = last((await claude.callTool({ name: "guide.vote", arguments: { roomId, seat: "claude", revisionId: prop.revisionId, vote: "agree", reason: "checked both rules; the 50-char cap matches our tooling" } })) as CallToolResult);
    expect(vote.roomState).toBe("agreed");

    const get = (await claude.callTool({ name: "guide.get", arguments: { slug: "commits" } })) as CallToolResult;
    expect(text(get, 0)).toContain("subject <= 50");
    expect(last(get).kind).toBe("rule");

    const res = await claude.readResource({ uri: "koncordia://guides/commits/latest" });
    expect(res.contents[0].text).toContain("# Commits");
    const v1 = await claude.readResource({ uri: "koncordia://guides/commits/v/1" });
    expect(v1.contents[0].text).toContain("# Commits");
    const tr = await claude.readResource({ uri: `koncordia://rooms/${roomId}/transcript` });
    expect(tr.contents[0].text).toContain("Consensus reached");

    const since = (await claude.callTool({ name: "room.transcript", arguments: { roomId, since: 3 } })) as CallToolResult;
    expect(last(since).entries.map((e: { n: number }) => e.n)).toEqual([4, 5]);
    expect(text(since, 0)).not.toContain("#2 claude");

    const listed = await claude.listResources();
    expect(listed.resources.map((r) => r.uri)).toContain("koncordia://guides/commits/latest");
  });

  it("domain errors come back as isError tool results, not protocol errors", async () => {
    const c = await inMemoryClient(store, "u1");
    const r = (await c.callTool({ name: "room.status", arguments: { roomId: "room_nope" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^not_found:/);
  });

  it("rooms are scoped per user", async () => {
    const a = await inMemoryClient(store, "alice");
    const b = await inMemoryClient(store, "bob");
    const created = last((await a.callTool({ name: "room.create", arguments: { topic: "t", seats: ["x", "y"] } })) as CallToolResult);
    const r = (await b.callTool({ name: "room.status", arguments: { roomId: created.roomId } })) as CallToolResult;
    expect(r.isError).toBe(true);
  });
});

describe("HTTP transport with bearer auth", () => {
  let srv: Server;
  let url: string;
  let key: string;

  beforeEach(async () => {
    const db = openDb(":memory:");
    const auth = new Auth(db);
    key = auth.createKey("mike@example.com", "test").key;
    srv = createHttpServer({ store: new Store(db), auth });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
  });
  afterEach(async () => {
    await new Promise((r) => srv.close(r));
  });

  it("rejects missing or bad keys with 401", async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const bad = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer kc_wrong" }, body: "{}" });
    expect(bad.status).toBe(401);
  });

  it("serves healthz without auth", async () => {
    const res = await fetch(url.replace("/mcp", "/healthz"));
    expect(res.status).toBe(200);
  });

  it("full tool round-trip over Streamable HTTP with a valid key", async () => {
    const client = new Client({ name: "http-test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } });
    await client.connect(transport);
    const created = last((await client.callTool({ name: "room.create", arguments: { topic: "http", seats: ["a", "b"] } })) as CallToolResult);
    expect(created.roomId).toMatch(/^room_/);
    const st = last((await client.callTool({ name: "room.status", arguments: { roomId: created.roomId } })) as CallToolResult);
    expect(st.state).toBe("open");
    await client.close();
  });
});
