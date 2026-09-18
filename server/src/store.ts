import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { parseControlToken, renderEntries, type Entry, type EntryKind } from "./format.js";

export class KoncordiaError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "forbidden"
      | "invalid"
      | "room_closed"
      | "no_proposal"
      | "revision_not_votable"
      | "too_early"
      | "quota",
    message: string,
  ) {
    super(message);
    this.name = "KoncordiaError";
  }
}

export type RoomState = "open" | "agreed" | "stalled" | "archived";

/** Limits for the hosted early-access tier. Null = unlimited (self-hosted, stdio, --no-auth). */
export interface Quotas {
  activeRooms: number;
  roomsPerMonth: number;
  privateGuides: number;
  /** Transcripts of rooms older than this are deleted; agreed guides stay. */
  retentionDays: number;
  /** Hard cap on entries in one room (messages, proposals, votes, system). */
  entriesPerRoom: number;
  /** Entries a user may post per calendar month across all rooms. */
  entriesPerMonth: number;
}

export const EARLY_ACCESS_QUOTAS: Quotas = { activeRooms: 3, roomsPerMonth: 20, privateGuides: 1, retentionDays: 30, entriesPerRoom: 400, entriesPerMonth: 3000 };
export type RevisionState = "proposed" | "superseded" | "agreed";
export type GuideKind = "styleguide" | "decision" | "rule" | "spec" | "other";
export type Visibility = "public" | "private";
export type Vote = "agree" | "object";

export const GUIDE_KINDS: GuideKind[] = ["styleguide", "decision", "rule", "spec", "other"];

export interface Room {
  id: string;
  userId: string;
  topic: string;
  seats: string[];
  maxRounds: number;
  /** A seat may vote agree only after this many own message/proposal turns in the room. */
  minTurnsBeforeAgree: number;
  round: number;
  roundSeats: string[];
  state: RoomState;
  guideSlug: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface Revision {
  id: string;
  guideSlug: string;
  roomId: string;
  version: number;
  state: RevisionState;
  content: string;
  proposedBy: string;
  ts: string;
}

export interface Guide {
  slug: string;
  userId: string;
  kind: GuideKind;
  title: string;
  visibility: Visibility;
  createdAt: string;
}

export interface RoomStatus {
  roomId: string;
  topic: string;
  state: RoomState;
  round: number;
  maxRounds: number;
  minTurnsBeforeAgree: number;
  seats: string[];
  /** Deliberation turns per seat so far: messages, proposals and objections (agree votes do not count). */
  turnsBySeat: Record<string, number>;
  guideSlug: string;
  guideKind: GuideKind;
  entryCount: number;
  currentRevision: { id: string; version: number; proposedBy: string; agreedBy: string[]; objectedBy: string[] } | null;
  pendingVotes: string[];
}

export interface ReadResult {
  entries: Entry[];
  rendered: string;
  cursor: number;
  status: RoomStatus;
}

export interface VoteResult {
  revisionId: string;
  revisionState: RevisionState;
  roomState: RoomState;
  agreedBy: string[];
  objectedBy: string[];
  pendingVotes: string[];
}

const SEAT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MIN_REASON_CHARS = 20;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("base64url")}`;
}

export function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "guide";
}

const now = () => new Date().toISOString();
const monthOf = (iso: string) => iso.slice(0, 7);

/**
 * All domain logic. The server has no model: it is a shared whiteboard with
 * append-only entries, per-seat cursors, guide revisions and a consensus rule.
 * Every method takes the acting userId first; rooms and private guides are scoped to it.
 */
export class Store {
  readonly quotas: Quotas | null;

  constructor(
    private readonly db: Db,
    opts: { quotas?: Quotas | null } = {},
  ) {
    this.quotas = opts.quotas ?? null;
  }

  // ---------- rooms ----------

  createRoom(
    userId: string,
    input: {
      topic: string;
      seats: string[];
      maxRounds?: number;
      minTurnsBeforeAgree?: number;
      guideSlug?: string;
      guideKind?: GuideKind;
      guideTitle?: string;
      visibility?: Visibility;
    },
  ): Room {
    const topic = input.topic.trim();
    if (!topic) throw new KoncordiaError("invalid", "topic must not be empty");
    const seats = input.seats.map((s) => s.trim().toLowerCase());
    if (seats.length < 2) throw new KoncordiaError("invalid", "a room needs at least 2 seats");
    if (seats.length > 8) throw new KoncordiaError("invalid", "a room supports at most 8 seats");
    if (new Set(seats).size !== seats.length) throw new KoncordiaError("invalid", "seat names must be unique");
    for (const s of seats) {
      if (!SEAT_RE.test(s)) throw new KoncordiaError("invalid", `invalid seat name "${s}" (a-z 0-9 _ -, max 32)`);
      if (s === "system") throw new KoncordiaError("invalid", `"system" is a reserved seat name`);
    }
    const maxRounds = input.maxRounds ?? 8;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) {
      throw new KoncordiaError("invalid", "maxRounds must be an integer between 1 and 100");
    }
    const minTurns = input.minTurnsBeforeAgree ?? 1;
    if (!Number.isInteger(minTurns) || minTurns < 0 || minTurns > 20) {
      throw new KoncordiaError("invalid", "minTurnsBeforeAgree must be an integer between 0 and 20");
    }
    const guideKind = input.guideKind ?? "other";
    if (!GUIDE_KINDS.includes(guideKind)) throw new KoncordiaError("invalid", `invalid guideKind "${guideKind}"`);
    const visibility = input.visibility ?? "public";

    const ts = now();
    const id = newId("room");
    this.enforceRoomQuota(userId, ts, visibility, input.guideSlug);
    const slug = this.resolveGuideSlug(userId, input.guideSlug, topic, guideKind, input.guideTitle ?? topic, visibility, ts);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO rooms (id, user_id, topic, seats_json, max_rounds, min_turns_before_agree, round, round_seats_json, state, guide_slug, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, '[]', 'open', ?, ?)`,
        )
        .run(id, userId, topic, JSON.stringify(seats), maxRounds, minTurns, slug, ts);
      const ins = this.db.prepare(`INSERT INTO cursors (room_id, seat, n) VALUES (?, ?, 0)`);
      for (const s of seats) ins.run(id, s);
      this.bumpUsage(userId, ts, "rooms_created");
      this.appendEntry(id, "system", "system", `Room opened. Topic: ${topic}. Seats: ${seats.join(", ")}. Max rounds: ${maxRounds}. Guide: ${slug} (${guideKind}).`, null, ts);
    });
    tx();
    return this.getRoom(userId, id);
  }

  private enforceRoomQuota(userId: string, ts: string, visibility: Visibility, requestedSlug: string | undefined) {
    const q = this.quotas;
    if (!q) return;
    const open = (this.db.prepare(`SELECT COUNT(*) AS c FROM rooms WHERE user_id = ? AND state = 'open'`).get(userId) as { c: number }).c;
    if (open >= q.activeRooms) {
      throw new KoncordiaError("quota", `you have ${open} open room(s); the early-access limit is ${q.activeRooms}. Finish or let one stall first.`);
    }
    const used = this.usageThisMonth(userId, ts).roomsCreated;
    if (used >= q.roomsPerMonth) {
      throw new KoncordiaError("quota", `you created ${used} room(s) this month; the early-access limit is ${q.roomsPerMonth}.`);
    }
    if (visibility === "private") {
      const existing = requestedSlug ? this.db.prepare(`SELECT 1 FROM guides WHERE slug = ? AND user_id = ?`).get(requestedSlug.trim().toLowerCase(), userId) : undefined;
      if (!existing) {
        const priv = (this.db.prepare(`SELECT COUNT(*) AS c FROM guides WHERE user_id = ? AND visibility = 'private'`).get(userId) as { c: number }).c;
        if (priv >= q.privateGuides) {
          throw new KoncordiaError("quota", `you have ${priv} private guide(s); the early-access limit is ${q.privateGuides}. Make it public or reuse an existing private slug.`);
        }
      }
    }
  }

  usageThisMonth(userId: string, ts = now()): { month: string; roomsCreated: number; entriesPosted: number } {
    const month = monthOf(ts);
    const row = this.db.prepare(`SELECT rooms_created, entries_posted FROM usage WHERE user_id = ? AND month = ?`).get(userId, month) as
      | { rooms_created: number; entries_posted: number }
      | undefined;
    return { month, roomsCreated: row?.rooms_created ?? 0, entriesPosted: row?.entries_posted ?? 0 };
  }

  /**
   * Retention: rooms older than `days` lose their transcript (entries, cursors) and become
   * "archived". Guides and agreed revisions are kept. Returns the number of rooms archived.
   */
  archiveOldRooms(days: number, ref = new Date()): number {
    const cutoff = new Date(ref.getTime() - days * 86_400_000).toISOString();
    const rows = this.db.prepare(`SELECT id FROM rooms WHERE created_at < ? AND state != 'archived'`).all(cutoff) as { id: string }[];
    const ts = now();
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        this.db.prepare(`DELETE FROM entries WHERE room_id = ?`).run(r.id);
        this.db.prepare(`DELETE FROM cursors WHERE room_id = ?`).run(r.id);
        this.db.prepare(`UPDATE rooms SET state = 'archived', archived_at = ? WHERE id = ?`).run(ts, r.id);
      }
    });
    tx();
    return rows.length;
  }

  // ---------- waitlist ----------

  waitlistAdd(email: string, tier: string, ip: string | null): { added: boolean } {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 254) throw new KoncordiaError("invalid", "invalid email address");
    const t = tier.trim().toLowerCase();
    if (!/^[a-z][a-z-]{1,30}$/.test(t)) throw new KoncordiaError("invalid", "invalid tier");
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO waitlist (id, email, tier, ip, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(newId("wl"), e, t, ip, now());
    return { added: r.changes > 0 };
  }

  waitlistCount(tier?: string): number {
    return tier
      ? (this.db.prepare(`SELECT COUNT(*) AS c FROM waitlist WHERE tier = ?`).get(tier) as { c: number }).c
      : (this.db.prepare(`SELECT COUNT(*) AS c FROM waitlist`).get() as { c: number }).c;
  }

  private resolveGuideSlug(
    userId: string,
    requested: string | undefined,
    topic: string,
    kind: GuideKind,
    title: string,
    visibility: Visibility,
    ts: string,
  ): string {
    if (requested !== undefined) {
      const slug = requested.trim().toLowerCase();
      if (!SLUG_RE.test(slug)) throw new KoncordiaError("invalid", `invalid guideSlug "${requested}" (a-z 0-9 -, max 64)`);
      const existing = this.db.prepare(`SELECT user_id FROM guides WHERE slug = ?`).get(slug) as { user_id: string } | undefined;
      if (existing) {
        if (existing.user_id !== userId) throw new KoncordiaError("forbidden", `guide "${slug}" belongs to another user`);
        return slug; // new room revises an existing guide
      }
      this.insertGuide(slug, userId, kind, title, visibility, ts);
      return slug;
    }
    const base = slugify(topic);
    let slug = base;
    while (this.db.prepare(`SELECT 1 FROM guides WHERE slug = ?`).get(slug)) {
      slug = `${base}-${randomBytes(2).toString("hex")}`;
    }
    this.insertGuide(slug, userId, kind, title, visibility, ts);
    return slug;
  }

  private insertGuide(slug: string, userId: string, kind: GuideKind, title: string, visibility: Visibility, ts: string) {
    this.db
      .prepare(`INSERT INTO guides (slug, user_id, kind, title, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(slug, userId, kind, title.trim().slice(0, 200), visibility, ts);
  }

  getRoom(userId: string, roomId: string): Room {
    const row = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId) as RoomRow | undefined;
    if (!row || row.user_id !== userId) throw new KoncordiaError("not_found", `room "${roomId}" not found`);
    return rowToRoom(row);
  }

  listRooms(userId: string): Room[] {
    const rows = this.db.prepare(`SELECT * FROM rooms WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as RoomRow[];
    return rows.map(rowToRoom);
  }

  private assertSeat(room: Room, seat: string): string {
    const s = seat.trim().toLowerCase();
    if (!room.seats.includes(s)) {
      throw new KoncordiaError("invalid", `seat "${seat}" is not in room ${room.id} (seats: ${room.seats.join(", ")})`);
    }
    return s;
  }

  private assertOpen(room: Room) {
    if (room.state !== "open") throw new KoncordiaError("room_closed", `room ${room.id} is ${room.state}; no further turns accepted`);
  }

  /** Storage guard for the hosted tier: bounded entries per room and per user per month. */
  private enforceEntryQuota(userId: string, room: Room) {
    const q = this.quotas;
    if (!q) return;
    if (this.lastN(room.id) >= q.entriesPerRoom) {
      throw new KoncordiaError("quota", `room ${room.id} reached the limit of ${q.entriesPerRoom} entries; propose and vote, or open a new room.`);
    }
    const used = this.usageThisMonth(userId).entriesPosted;
    if (used >= q.entriesPerMonth) {
      throw new KoncordiaError("quota", `you posted ${used} entries this month; the early-access limit is ${q.entriesPerMonth}.`);
    }
  }

  // ---------- admin (CLI only) ----------

  /** Make a guide private (hidden from public pages and from other users). */
  setGuideVisibility(slug: string, visibility: Visibility): boolean {
    return this.db.prepare(`UPDATE guides SET visibility = ? WHERE slug = ?`).run(visibility, slug).changes > 0;
  }

  /** Stall a user's open rooms and hide their guides; used together with Auth.revokeAllKeys. */
  banUser(userId: string): { rooms: number; guides: number } {
    const rooms = this.db.prepare(`UPDATE rooms SET state = 'stalled' WHERE user_id = ? AND state = 'open'`).run(userId).changes;
    const guides = this.db.prepare(`UPDATE guides SET visibility = 'private' WHERE user_id = ?`).run(userId).changes;
    return { rooms, guides };
  }

  listWaitlist(): Array<{ email: string; tier: string; ts: string }> {
    return this.db.prepare(`SELECT email, tier, ts FROM waitlist ORDER BY ts`).all() as Array<{ email: string; tier: string; ts: string }>;
  }

  /** Read-only view of a public guide plus its room transcript, for the public web page. No user scoping. */
  publicGuide(slug: string): { guide: Guide; revision: Revision; agreedBy: string[]; transcript: Entry[]; room: Room | null; history: Array<{ version: number; state: RevisionState; proposedBy: string; ts: string }> } {
    const g = this.getGuide(null, slug);
    const roomRow = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(g.revision.roomId) as RoomRow | undefined;
    const room = roomRow ? rowToRoom(roomRow) : null;
    const rows = room ? (this.db.prepare(`SELECT * FROM entries WHERE room_id = ? ORDER BY n`).all(room.id) as EntryRow[]) : [];
    const hist = this.db.prepare(`SELECT version, state, proposed_by, ts FROM revisions WHERE guide_slug = ? ORDER BY version`).all(slug) as { version: number; state: RevisionState; proposed_by: string; ts: string }[];
    return { ...g, transcript: rows.map(rowToEntry), room, history: hist.map((h) => ({ version: h.version, state: h.state, proposedBy: h.proposed_by, ts: h.ts })) };
  }

  /** Newest public guides with an agreed revision, for the public index. */
  listPublicGuides(limit = 50): Array<Guide & { version: number; agreedAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT g.*, r.version, r.ts AS agreed_at FROM guides g
         JOIN revisions r ON r.guide_slug = g.slug AND r.state = 'agreed'
         WHERE g.visibility = 'public'
           AND r.version = (SELECT MAX(version) FROM revisions WHERE guide_slug = g.slug AND state = 'agreed')
         ORDER BY r.ts DESC LIMIT ?`,
      )
      .all(limit) as Array<GuideRow & { version: number; agreed_at: string }>;
    return rows.map((r) => ({ ...rowToGuide(r), version: r.version, agreedAt: r.agreed_at }));
  }

  /**
   * Post a turn. If the body starts with a control token (/agree or /object) on its
   * first non-empty line, it is a vote on the current proposed revision.
   */
  post(userId: string, roomId: string, seat: string, body: string): { entryN: number; kind: EntryKind; vote?: VoteResult; status: RoomStatus } {
    const room = this.getRoom(userId, roomId);
    const s = this.assertSeat(room, seat);
    this.assertOpen(room);
    this.enforceEntryQuota(userId, room);
    const text = body.replace(/\r\n/g, "\n").trim();
    if (!text) throw new KoncordiaError("invalid", "body must not be empty");
    if (text.length > 64_000) throw new KoncordiaError("invalid", "body exceeds 64k characters");

    const ctl = parseControlToken(text);
    if (ctl) {
      const current = this.currentRevision(room.id);
      if (!current) throw new KoncordiaError("no_proposal", "no proposed revision to vote on; use guide.propose first");
      const res = this.vote(userId, roomId, s, current.id, ctl.token, ctl.rest);
      const n = this.lastN(room.id);
      return { entryN: n, kind: "vote", vote: res, status: this.status(userId, roomId) };
    }

    const ts = now();
    let n = 0;
    this.db.transaction(() => {
      n = this.appendEntry(room.id, s, "message", text, null, ts);
      this.bumpUsage(userId, ts, "entries_posted");
      this.advanceRound(room, s);
    })();
    return { entryN: n, kind: "message", status: this.status(userId, roomId) };
  }

  /** Delta since this seat's cursor, excluding the seat's own entries. Advances the cursor. */
  read(userId: string, roomId: string, seat: string): ReadResult {
    const room = this.getRoom(userId, roomId);
    const s = this.assertSeat(room, seat);
    const cur = (this.db.prepare(`SELECT n FROM cursors WHERE room_id = ? AND seat = ?`).get(room.id, s) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM entries WHERE room_id = ? AND n > ? AND seat != ? ORDER BY n`)
      .all(room.id, cur, s) as EntryRow[];
    const last = this.lastN(room.id);
    if (last > cur) this.db.prepare(`UPDATE cursors SET n = ? WHERE room_id = ? AND seat = ?`).run(last, room.id, s);
    const entries = rows.map(rowToEntry);
    return { entries, rendered: renderEntries(entries), cursor: last, status: this.status(userId, roomId) };
  }

  /** Transcript (optionally only entries with n > since), read-only; does not move any cursor. */
  transcript(userId: string, roomId: string, since = 0): { room: Room; entries: Entry[]; rendered: string } {
    const room = this.getRoom(userId, roomId);
    const rows = this.db.prepare(`SELECT * FROM entries WHERE room_id = ? AND n > ? ORDER BY n`).all(room.id, since) as EntryRow[];
    const entries = rows.map(rowToEntry);
    return { room, entries, rendered: renderEntries(entries) };
  }

  status(userId: string, roomId: string): RoomStatus {
    const room = this.getRoom(userId, roomId);
    const guide = this.getGuideRow(room.guideSlug);
    const current = this.currentRevision(room.id);
    let currentRevision: RoomStatus["currentRevision"] = null;
    let pendingVotes: string[] = [];
    if (current) {
      const { agreedBy, objectedBy } = this.tally(current.id);
      currentRevision = { id: current.id, version: current.version, proposedBy: current.proposedBy, agreedBy, objectedBy };
      pendingVotes = room.seats.filter((x) => !agreedBy.includes(x));
    }
    return {
      roomId: room.id,
      topic: room.topic,
      state: room.state,
      round: room.round,
      maxRounds: room.maxRounds,
      minTurnsBeforeAgree: room.minTurnsBeforeAgree,
      seats: room.seats,
      turnsBySeat: this.turnsBySeat(room),
      guideSlug: room.guideSlug,
      guideKind: guide.kind,
      entryCount: this.lastN(room.id),
      currentRevision,
      pendingVotes,
    };
  }

  // ---------- guides ----------

  propose(userId: string, roomId: string, seat: string, content: string): { revisionId: string; version: number; guideSlug: string; entryN: number; status: RoomStatus } {
    const room = this.getRoom(userId, roomId);
    const s = this.assertSeat(room, seat);
    this.assertOpen(room);
    this.enforceEntryQuota(userId, room);
    const text = content.replace(/\r\n/g, "\n").trim();
    if (!text) throw new KoncordiaError("invalid", "content must not be empty");
    if (text.length > 256_000) throw new KoncordiaError("invalid", "content exceeds 256k characters");

    const ts = now();
    const id = newId("rev");
    let version = 0;
    let n = 0;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE revisions SET state = 'superseded' WHERE room_id = ? AND state = 'proposed'`).run(room.id);
      const maxV = this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM revisions WHERE guide_slug = ?`).get(room.guideSlug) as { v: number };
      version = maxV.v + 1;
      this.db
        .prepare(
          `INSERT INTO revisions (id, guide_slug, room_id, version, state, content, proposed_by, ts) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?)`,
        )
        .run(id, room.guideSlug, room.id, version, text, s, ts);
      // The proposer implicitly agrees with their own proposal.
      this.db.prepare(`INSERT INTO votes (revision_id, seat, vote, reason, ts) VALUES (?, ?, 'agree', NULL, ?)`).run(id, s, ts);
      n = this.appendEntry(room.id, s, "proposal", text, id, ts);
      this.bumpUsage(userId, ts, "entries_posted");
      this.advanceRound(room, s);
    })();
    return { revisionId: id, version, guideSlug: room.guideSlug, entryN: n, status: this.status(userId, roomId) };
  }

  /**
   * Every vote needs a substantive reason: an agree must say what was checked and what is
   * accepted despite a different preference; an object must name the problem.
   */
  vote(userId: string, roomId: string, seat: string, revisionId: string, vote: Vote, reason: string): VoteResult {
    const room = this.getRoom(userId, roomId);
    const s = this.assertSeat(room, seat);
    this.assertOpen(room);
    this.enforceEntryQuota(userId, room);
    if (vote !== "agree" && vote !== "object") throw new KoncordiaError("invalid", `vote must be "agree" or "object"`);
    const rev = this.db.prepare(`SELECT * FROM revisions WHERE id = ?`).get(revisionId) as RevisionRow | undefined;
    if (!rev || rev.room_id !== room.id) throw new KoncordiaError("not_found", `revision "${revisionId}" not found in room ${room.id}`);
    if (rev.state !== "proposed") {
      const current = this.currentRevision(room.id);
      throw new KoncordiaError(
        "revision_not_votable",
        `revision ${revisionId} is ${rev.state}; ${current ? `the current proposal is ${current.id} (v${current.version})` : "there is no current proposal"}`,
      );
    }
    const cleanReason = (reason ?? "").trim();
    if (cleanReason.length < MIN_REASON_CHARS) {
      throw new KoncordiaError(
        "invalid",
        vote === "agree"
          ? `an agree needs a reason of at least ${MIN_REASON_CHARS} characters: what you checked, and what you accept despite preferring otherwise`
          : `an objection needs a reason of at least ${MIN_REASON_CHARS} characters naming the concrete problem`,
      );
    }
    if (vote === "agree" && s !== rev.proposed_by) {
      const taken = this.turnsBySeat(room)[s] ?? 0;
      if (taken < room.minTurnsBeforeAgree) {
        throw new KoncordiaError(
          "too_early",
          `seat "${s}" has taken ${taken} turn(s) in this room; this room requires ${room.minTurnsBeforeAgree} message or proposal turn(s) before voting agree. Post your review first.`,
        );
      }
    }
    const ts = now();
    let result!: VoteResult;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO votes (revision_id, seat, vote, reason, ts) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(revision_id, seat) DO UPDATE SET vote = excluded.vote, reason = excluded.reason, ts = excluded.ts`,
        )
        .run(rev.id, s, vote, cleanReason, ts);
      const body = `/${vote}\n${cleanReason}`;
      this.appendEntry(room.id, s, "vote", body, rev.id, ts);
      this.bumpUsage(userId, ts, "entries_posted");
      const { agreedBy, objectedBy } = this.tally(rev.id);
      const pending = room.seats.filter((x) => !agreedBy.includes(x));
      let revisionState: RevisionState = "proposed";
      let roomState: RoomState = room.state;
      if (pending.length === 0) {
        revisionState = "agreed";
        roomState = "agreed";
        this.db.prepare(`UPDATE revisions SET state = 'agreed' WHERE id = ?`).run(rev.id);
        this.db.prepare(`UPDATE rooms SET state = 'agreed' WHERE id = ?`).run(room.id);
        this.appendEntry(room.id, "system", "system", `Consensus reached on revision ${rev.id} (v${rev.version}) by ${agreedBy.join(", ")}. Room closed.`, rev.id, ts);
      } else {
        this.advanceRound(room, s);
        roomState = (this.db.prepare(`SELECT state FROM rooms WHERE id = ?`).get(room.id) as { state: RoomState }).state;
      }
      result = { revisionId: rev.id, revisionState, roomState, agreedBy, objectedBy, pendingVotes: pending };
    })();
    return result;
  }

  /** Latest agreed revision by default; a specific version if requested (any state). */
  getGuide(userId: string | null, slug: string, version?: number): { guide: Guide; revision: Revision; agreedBy: string[] } {
    const guide = this.getGuideRow(slug);
    this.assertGuideReadable(userId, guide);
    let rev: RevisionRow | undefined;
    if (version !== undefined) {
      rev = this.db.prepare(`SELECT * FROM revisions WHERE guide_slug = ? AND version = ?`).get(slug, version) as RevisionRow | undefined;
      if (!rev) throw new KoncordiaError("not_found", `guide "${slug}" has no version ${version}`);
    } else {
      rev = this.db
        .prepare(`SELECT * FROM revisions WHERE guide_slug = ? AND state = 'agreed' ORDER BY version DESC LIMIT 1`)
        .get(slug) as RevisionRow | undefined;
      if (!rev) throw new KoncordiaError("not_found", `guide "${slug}" has no agreed revision yet`);
    }
    return { guide, revision: rowToRevision(rev), agreedBy: this.tally(rev.id).agreedBy };
  }

  history(userId: string | null, slug: string): { guide: Guide; revisions: Array<Omit<Revision, "content"> & { contentLength: number; agreedBy: string[]; objectedBy: string[] }> } {
    const guide = this.getGuideRow(slug);
    this.assertGuideReadable(userId, guide);
    const rows = this.db.prepare(`SELECT * FROM revisions WHERE guide_slug = ? ORDER BY version`).all(slug) as RevisionRow[];
    return {
      guide,
      revisions: rows.map((r) => {
        const { content, ...rest } = rowToRevision(r);
        const t = this.tally(r.id);
        return { ...rest, contentLength: content.length, agreedBy: t.agreedBy, objectedBy: t.objectedBy };
      }),
    };
  }

  listGuides(userId: string): Guide[] {
    const rows = this.db.prepare(`SELECT * FROM guides WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as GuideRow[];
    return rows.map(rowToGuide);
  }

  // ---------- internals ----------

  private getGuideRow(slug: string): Guide {
    const row = this.db.prepare(`SELECT * FROM guides WHERE slug = ?`).get(slug) as GuideRow | undefined;
    if (!row) throw new KoncordiaError("not_found", `guide "${slug}" not found`);
    return rowToGuide(row);
  }

  private assertGuideReadable(userId: string | null, guide: Guide) {
    if (guide.visibility === "public") return;
    if (userId && guide.userId === userId) return;
    throw new KoncordiaError("not_found", `guide "${guide.slug}" not found`);
  }

  private currentRevision(roomId: string): Revision | null {
    const row = this.db
      .prepare(`SELECT * FROM revisions WHERE room_id = ? AND state = 'proposed' ORDER BY version DESC LIMIT 1`)
      .get(roomId) as RevisionRow | undefined;
    return row ? rowToRevision(row) : null;
  }

  private tally(revisionId: string): { agreedBy: string[]; objectedBy: string[] } {
    const rows = this.db.prepare(`SELECT seat, vote FROM votes WHERE revision_id = ? ORDER BY ts`).all(revisionId) as { seat: string; vote: Vote }[];
    return {
      agreedBy: rows.filter((r) => r.vote === "agree").map((r) => r.seat),
      objectedBy: rows.filter((r) => r.vote === "object").map((r) => r.seat),
    };
  }

  private turnsBySeat(room: Room): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT seat, COUNT(*) AS c FROM entries
         WHERE room_id = ? AND (kind IN ('message', 'proposal') OR (kind = 'vote' AND body LIKE '/object%'))
         GROUP BY seat`,
      )
      .all(room.id) as { seat: string; c: number }[];
    const out: Record<string, number> = Object.fromEntries(room.seats.map((x) => [x, 0]));
    for (const r of rows) if (r.seat in out) out[r.seat] = r.c;
    return out;
  }

  private lastN(roomId: string): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(n), 0) AS n FROM entries WHERE room_id = ?`).get(roomId) as { n: number }).n;
  }

  private appendEntry(roomId: string, seat: string, kind: EntryKind, body: string, ref: string | null, ts: string): number {
    const n = this.lastN(roomId) + 1;
    this.db.prepare(`INSERT INTO entries (room_id, n, seat, kind, body, ref, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(roomId, n, seat, kind, body, ref, ts);
    return n;
  }

  /**
   * A round is complete when every seat has taken a turn since the round started.
   * Exceeding maxRounds without consensus stalls the room (safety stop, no infinite loop).
   */
  private advanceRound(room: Room, seat: string) {
    const row = this.db.prepare(`SELECT round, round_seats_json, state FROM rooms WHERE id = ?`).get(room.id) as {
      round: number;
      round_seats_json: string;
      state: RoomState;
    };
    if (row.state !== "open") return;
    const spoken = new Set<string>(JSON.parse(row.round_seats_json));
    spoken.add(seat);
    if (room.seats.every((x) => spoken.has(x))) {
      const next = row.round + 1;
      if (next > room.maxRounds) {
        this.db.prepare(`UPDATE rooms SET round = ?, round_seats_json = '[]', state = 'stalled' WHERE id = ?`).run(room.maxRounds, room.id);
        this.appendEntry(room.id, "system", "system", `Round cap (${room.maxRounds}) reached without consensus. Room stalled.`, null, now());
      } else {
        this.db.prepare(`UPDATE rooms SET round = ?, round_seats_json = '[]' WHERE id = ?`).run(next, room.id);
      }
    } else {
      this.db.prepare(`UPDATE rooms SET round_seats_json = ? WHERE id = ?`).run(JSON.stringify([...spoken]), room.id);
    }
  }

  private bumpUsage(userId: string, ts: string, col: "rooms_created" | "entries_posted") {
    this.db
      .prepare(
        `INSERT INTO usage (user_id, month, ${col}) VALUES (?, ?, 1)
         ON CONFLICT(user_id, month) DO UPDATE SET ${col} = ${col} + 1`,
      )
      .run(userId, monthOf(ts));
  }
}

// ---------- row mappers ----------

interface RoomRow {
  id: string;
  user_id: string;
  topic: string;
  seats_json: string;
  max_rounds: number;
  min_turns_before_agree: number;
  round: number;
  round_seats_json: string;
  state: RoomState;
  guide_slug: string;
  created_at: string;
  archived_at: string | null;
}
interface EntryRow {
  room_id: string;
  n: number;
  seat: string;
  kind: EntryKind;
  body: string;
  ref: string | null;
  ts: string;
}
interface RevisionRow {
  id: string;
  guide_slug: string;
  room_id: string;
  version: number;
  state: RevisionState;
  content: string;
  proposed_by: string;
  ts: string;
}
interface GuideRow {
  slug: string;
  user_id: string;
  kind: GuideKind;
  title: string;
  visibility: Visibility;
  created_at: string;
}

const rowToRoom = (r: RoomRow): Room => ({
  id: r.id,
  userId: r.user_id,
  topic: r.topic,
  seats: JSON.parse(r.seats_json),
  maxRounds: r.max_rounds,
  minTurnsBeforeAgree: r.min_turns_before_agree,
  round: r.round,
  roundSeats: JSON.parse(r.round_seats_json),
  state: r.state,
  guideSlug: r.guide_slug,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});
const rowToEntry = (r: EntryRow): Entry => ({ n: r.n, seat: r.seat, kind: r.kind, body: r.body, ref: r.ref, ts: r.ts });
const rowToRevision = (r: RevisionRow): Revision => ({
  id: r.id,
  guideSlug: r.guide_slug,
  roomId: r.room_id,
  version: r.version,
  state: r.state,
  content: r.content,
  proposedBy: r.proposed_by,
  ts: r.ts,
});
const rowToGuide = (r: GuideRow): Guide => ({
  slug: r.slug,
  userId: r.user_id,
  kind: r.kind,
  title: r.title,
  visibility: r.visibility,
  createdAt: r.created_at,
});
