import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface RoomStatus {
  roomId: string;
  topic: string;
  state: "open" | "agreed" | "stalled";
  round: number;
  maxRounds: number;
  seats: string[];
  guideSlug: string;
  guideKind: string;
  entryCount: number;
  currentRevision: { id: string; version: number; proposedBy: string; agreedBy: string[]; objectedBy: string[] } | null;
  pendingVotes: string[];
}

export interface TranscriptEntry {
  n: number;
  seat: string;
  kind: string;
  body: string;
  ref: string | null;
  ts: string;
}

/** Thin typed wrapper over the Koncordia tools, for the driver's own bookkeeping (never for reasoning). */
export class KoncordiaClient {
  private constructor(private readonly client: Client) {}

  static async connect(url: string, key?: string): Promise<KoncordiaClient> {
    const client = new Client({ name: "koncordia-driver", version: "0.1.0" });
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Bearer ${key}`;
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return new KoncordiaClient(client);
  }

  async close() {
    await this.client.close();
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<{ data: T; text: string }> {
    const r = (await this.client.callTool({ name, arguments: args })) as CallToolResult;
    const blocks = r.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
    if (r.isError) throw new Error(`${name}: ${blocks.map((b) => b.text).join(" ")}`);
    const last = blocks[blocks.length - 1]?.text ?? "{}";
    return { data: JSON.parse(last) as T, text: blocks.length > 1 ? blocks[0].text : "" };
  }

  async createRoom(input: { topic: string; seats: string[]; maxRounds?: number; guideKind?: string; guideSlug?: string; visibility?: string }) {
    return (await this.call<{ roomId: string; guideSlug: string; seats: string[]; maxRounds: number }>("room.create", input)).data;
  }

  async status(roomId: string): Promise<RoomStatus> {
    return (await this.call<RoomStatus>("room.status", { roomId })).data;
  }

  async transcript(roomId: string, since = 0): Promise<{ entries: TranscriptEntry[]; rendered: string }> {
    const r = await this.call<{ entries: TranscriptEntry[] }>("room.transcript", { roomId, since });
    return { entries: r.data.entries, rendered: r.text };
  }

  async guide(slug: string, version?: number): Promise<{ content: string; meta: Record<string, unknown> }> {
    const r = await this.call<Record<string, unknown>>("guide.get", version ? { slug, version } : { slug });
    return { content: r.text, meta: r.data };
  }
}
