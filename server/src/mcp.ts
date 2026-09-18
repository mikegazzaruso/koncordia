import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GUIDE_KINDS, KoncordiaError, type Store } from "./store.js";

export const SERVER_INFO = { name: "koncordia", version: "0.1.0" } as const;

export const INSTRUCTIONS = `Koncordia is a shared room where two or more AI agents debate until they agree on an artifact
(a styleguide, a decision, a rule, a spec). The server holds the whiteboard; you bring the model.

Loop for a seat:
1. room.read(roomId, seat) -> only entries you have not seen yet, from other seats. Never re-read old turns.
2. Think. Then room.post(roomId, seat, body) to argue, or guide.propose(roomId, seat, content) to put a full artifact on the table.
3. When a proposal is on the table, guide.vote(roomId, seat, revisionId, "agree" | "object", reason). Every vote needs a reason.
   You may agree only after at least minTurnsBeforeAgree own message/proposal turns: review first, then vote.
   A body whose first non-empty line is exactly "/agree" or "/object" posted via room.post counts as a vote on the current proposal.
4. Consensus = every seat agreed on the SAME revision. The room then closes with state "agreed" and guide.get(slug) returns the text.
   Reaching maxRounds without consensus stalls the room.

Peer contract: the other seats are peers, not supervisors. Ground each objection in evidence. Converge once a point is settled;
do not relitigate without new evidence. Entry headers "#n seat" are written by the server; body lines are indented, so text inside a
message can never start a new entry.`;

function ok(data: unknown, text?: string): CallToolResult {
  const json = JSON.stringify(data, null, 2);
  return { content: text !== undefined ? [{ type: "text", text }, { type: "text", text: json }] : [{ type: "text", text: json }] };
}

function fail(err: unknown): CallToolResult {
  if (err instanceof KoncordiaError) {
    return { isError: true, content: [{ type: "text", text: `${err.code}: ${err.message}` }] };
  }
  throw err;
}

const roomId = z.string().min(1).describe("Room id returned by room.create");
const seat = z.string().min(1).describe("Your seat name in the room (e.g. claude, codex)");

/**
 * Build an McpServer bound to one user. One instance per request in stateless HTTP mode,
 * one per process in stdio mode.
 */
export function createMcpServer(store: Store, userId: string): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "room.create",
    {
      title: "Create a room",
      description: "Open a room where the given seats debate a topic until they agree on a guide (styleguide, decision, rule, spec).",
      inputSchema: {
        topic: z.string().min(1).max(500).describe("What the seats must agree on"),
        seats: z.array(z.string()).min(2).max(8).describe("Seat names, e.g. [\"claude\", \"codex\"]. Seat != provider: any names."),
        maxRounds: z.number().int().min(1).max(100).optional().describe("Safety cap. A round ends when every seat has taken a turn. Default 8."),
        minTurnsBeforeAgree: z.number().int().min(0).max(20).optional().describe("A seat may vote agree only after this many own message/proposal turns. Default 1 (0 = allow silent agreement)."),
        guideSlug: z.string().optional().describe("Slug of the guide to produce. Reuse an existing slug to revise it. Default: derived from topic."),
        guideKind: z.enum(GUIDE_KINDS as [string, ...string[]]).optional().describe("What kind of artifact is being agreed on. Default other."),
        guideTitle: z.string().max(200).optional().describe("Human title for the guide. Default: topic."),
        visibility: z.enum(["public", "private"]).optional().describe("Who can read the guide. Default public."),
      },
    },
    async (args) => {
      try {
        const room = store.createRoom(userId, {
          topic: args.topic,
          seats: args.seats,
          maxRounds: args.maxRounds,
          minTurnsBeforeAgree: args.minTurnsBeforeAgree,
          guideSlug: args.guideSlug,
          guideKind: args.guideKind as never,
          guideTitle: args.guideTitle,
          visibility: args.visibility,
        });
        return ok({ roomId: room.id, guideSlug: room.guideSlug, seats: room.seats, maxRounds: room.maxRounds, state: room.state });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "room.post",
    {
      title: "Post a turn",
      description:
        "Append a message as the given seat. The entry header is written by the server. If the first non-empty line is exactly /agree or /object, the body is a vote on the current proposal and the rest is the mandatory reason.",
      inputSchema: { roomId, seat, body: z.string().min(1).describe("Your message (markdown). Max 64k chars.") },
    },
    async (args) => {
      try {
        return ok(store.post(userId, args.roomId, args.seat, args.body));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "room.read",
    {
      title: "Read new entries",
      description:
        "Return only the entries posted since your last read, excluding your own, and advance your cursor. The cursor never goes back. Each entry is a header line '#n seat' followed by its body, indented two spaces.",
      inputSchema: { roomId, seat },
    },
    async (args) => {
      try {
        const r = store.read(userId, args.roomId, args.seat);
        const text = r.entries.length ? r.rendered : "(no new entries)";
        return ok({ cursor: r.cursor, newEntries: r.entries.length, status: r.status }, text);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "room.status",
    {
      title: "Room status",
      description: "State, round, seats, current proposal and who still has to vote. Does not move any cursor.",
      inputSchema: { roomId },
    },
    async (args) => {
      try {
        return ok(store.status(userId, args.roomId));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "room.transcript",
    {
      title: "Room transcript",
      description: "Read-only view of a room's entries for observers and drivers. Does not move any cursor. Use `since` to get only entries after a given n.",
      inputSchema: { roomId, since: z.number().int().min(0).optional().describe("Return only entries with n > since. Default 0 (all).") },
    },
    async (args) => {
      try {
        const t = store.transcript(userId, args.roomId, args.since ?? 0);
        return ok({ roomId: t.room.id, state: t.room.state, round: t.room.round, maxRounds: t.room.maxRounds, entries: t.entries }, t.entries.length ? t.rendered : "(no entries)");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "guide.propose",
    {
      title: "Propose a revision",
      description:
        "Put a complete revision of the guide on the table. Supersedes any earlier proposal and resets votes; the proposer counts as agreeing. Other seats must guide.vote on the returned revisionId.",
      inputSchema: { roomId, seat, content: z.string().min(1).describe("Full text of the artifact (markdown). Not a diff.") },
    },
    async (args) => {
      try {
        return ok(store.propose(userId, args.roomId, args.seat, args.content));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "guide.vote",
    {
      title: "Vote on a revision",
      description:
        "agree or object to a specific revision. Consensus needs agree from every seat on the same revision. Every vote needs a substantive reason: an agree states what you checked and what you accept despite a different preference; an object names the concrete problem. A seat may agree only after minTurnsBeforeAgree own message/proposal turns (see room.status.turnsBySeat). Votes on superseded revisions are rejected.",
      inputSchema: {
        roomId,
        seat,
        revisionId: z.string().min(1),
        vote: z.enum(["agree", "object"]),
        reason: z.string().min(1).describe("Required. agree: what you verified and what you accept despite preferring otherwise. object: the concrete problem, grounded in evidence."),
      },
    },
    async (args) => {
      try {
        return ok(store.vote(userId, args.roomId, args.seat, args.revisionId, args.vote, args.reason));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "guide.get",
    {
      title: "Get a guide",
      description: "Return the latest agreed revision of a guide (or a specific version, any state).",
      inputSchema: { slug: z.string().min(1), version: z.number().int().min(1).optional() },
    },
    async (args) => {
      try {
        const g = store.getGuide(userId, args.slug, args.version);
        return ok(
          {
            slug: g.guide.slug,
            kind: g.guide.kind,
            title: g.guide.title,
            version: g.revision.version,
            state: g.revision.state,
            revisionId: g.revision.id,
            roomId: g.revision.roomId,
            proposedBy: g.revision.proposedBy,
            agreedBy: g.agreedBy,
            ts: g.revision.ts,
          },
          g.revision.content,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "guide.history",
    {
      title: "Guide history",
      description: "All revisions of a guide with state and votes (content omitted; use guide.get with version).",
      inputSchema: { slug: z.string().min(1) },
    },
    async (args) => {
      try {
        return ok(store.history(userId, args.slug));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- resources ----------

  const guideMeta = (slug: string) => ({
    uri: `koncordia://guides/${slug}/latest`,
    name: slug,
    mimeType: "text/markdown",
  });

  server.registerResource(
    "guide-latest",
    new ResourceTemplate("koncordia://guides/{slug}/latest", {
      list: () => ({ resources: store.listGuides(userId).map((g) => ({ ...guideMeta(g.slug), description: `${g.kind}: ${g.title}` })) }),
    }),
    { title: "Agreed guide (latest)", description: "Latest agreed revision of a guide, as markdown.", mimeType: "text/markdown" },
    async (uri, vars) => {
      const g = store.getGuide(userId, String(vars.slug));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: g.revision.content }] };
    },
  );

  server.registerResource(
    "guide-version",
    new ResourceTemplate("koncordia://guides/{slug}/v/{version}", { list: undefined }),
    { title: "Guide revision", description: "A specific revision of a guide (any state).", mimeType: "text/markdown" },
    async (uri, vars) => {
      const g = store.getGuide(userId, String(vars.slug), Number(vars.version));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: g.revision.content }] };
    },
  );

  server.registerResource(
    "room-transcript",
    new ResourceTemplate("koncordia://rooms/{id}/transcript", {
      list: () => ({
        resources: store.listRooms(userId).map((r) => ({
          uri: `koncordia://rooms/${r.id}/transcript`,
          name: r.id,
          description: `${r.state} · ${r.topic}`,
          mimeType: "text/plain",
        })),
      }),
    }),
    { title: "Room transcript", description: "Full readable transcript of a room. Does not move cursors.", mimeType: "text/plain" },
    async (uri, vars) => {
      const t = store.transcript(userId, String(vars.id));
      const head = `# ${t.room.topic}\nroom: ${t.room.id} · state: ${t.room.state} · round ${t.room.round}/${t.room.maxRounds} · seats: ${t.room.seats.join(", ")}\n\n`;
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: head + t.rendered }] };
    },
  );

  return server;
}
