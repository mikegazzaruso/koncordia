import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { KoncordiaError, Store } from "../src/store.js";
import { parseControlToken, renderEntry } from "../src/format.js";

const U = "usr_test";
const R = "checked every section against the repo; accept the trade-offs";
let store: Store;

beforeEach(() => {
  store = new Store(openDb(":memory:"));
});

function twoSeatRoom(extra: Partial<Parameters<Store["createRoom"]>[1]> = {}) {
  return store.createRoom(U, { topic: "TypeScript styleguide", seats: ["claude", "codex"], maxRounds: 4, guideKind: "styleguide", ...extra });
}

describe("room lifecycle: two fake seats converge", () => {
  it("dialogue -> proposal -> votes -> agreed guide", () => {
    const room = twoSeatRoom();
    expect(room.state).toBe("open");
    expect(room.guideSlug).toBe("typescript-styleguide");

    // first reads: only the system opening entry
    const r0 = store.read(U, room.id, "claude");
    expect(r0.entries.map((e) => e.kind)).toEqual(["system"]);

    store.post(U, room.id, "claude", "I propose 2-space indent and no semicolons.");
    store.post(U, room.id, "codex", "Agree on indent. Semicolons: keep them, ASI hazards.");

    // claude sees only codex's turn, not its own
    const r1 = store.read(U, room.id, "claude");
    expect(r1.entries).toHaveLength(1);
    expect(r1.entries[0].seat).toBe("codex");
    expect(r1.rendered.startsWith("#3 codex\n  Agree on indent.")).toBe(true);
    // cursor advanced: nothing new
    expect(store.read(U, room.id, "claude").entries).toHaveLength(0);

    const p = store.propose(U, room.id, "claude", "# TS styleguide\n- 2 spaces\n- semicolons: yes");
    expect(p.version).toBe(1);
    expect(p.status.currentRevision?.agreedBy).toEqual(["claude"]); // proposer auto-agrees
    expect(p.status.pendingVotes).toEqual(["codex"]);

    // codex reads the proposal in its delta
    const r2 = store.read(U, room.id, "codex");
    const prop = r2.entries.find((e) => e.kind === "proposal");
    expect(prop?.ref).toBe(p.revisionId);

    const v = store.vote(U, room.id, "codex", p.revisionId, "agree", R);
    expect(v.revisionState).toBe("agreed");
    expect(v.roomState).toBe("agreed");
    expect(v.pendingVotes).toEqual([]);

    const g = store.getGuide(U, room.guideSlug);
    expect(g.revision.version).toBe(1);
    expect(g.revision.content).toContain("semicolons: yes");
    expect(g.agreedBy.sort()).toEqual(["claude", "codex"]);
    expect(g.guide.kind).toBe("styleguide");

    // room closed: no more turns
    expect(() => store.post(U, room.id, "claude", "one more thing")).toThrow(KoncordiaError);
    expect(store.status(U, room.id).state).toBe("agreed");
  });

  it("/agree control token via post counts as a vote on the current proposal", () => {
    const room = twoSeatRoom({ minTurnsBeforeAgree: 0 });
    const p = store.propose(U, room.id, "codex", "rule: no default exports");
    const res = store.post(U, room.id, "claude", "/agree\nlooks good, checked all rules against the repo");
    expect(res.kind).toBe("vote");
    expect(res.vote?.roomState).toBe("agreed");
    expect(store.getGuide(U, room.guideSlug).revision.id).toBe(p.revisionId);
  });

  it("/object needs a reason; token elsewhere in the body is prose", () => {
    const room = twoSeatRoom();
    store.propose(U, room.id, "codex", "rule: tabs");
    expect(() => store.post(U, room.id, "claude", "/object")).toThrow(/reason/);
    const res = store.post(U, room.id, "claude", "I would say /agree but not yet.");
    expect(res.kind).toBe("message");
    expect(store.status(U, room.id).state).toBe("open");
    const obj = store.post(U, room.id, "claude", "/object\nTabs break the existing 400 files.");
    expect(obj.kind).toBe("vote");
    expect(obj.vote?.objectedBy).toEqual(["claude"]);
    expect(obj.vote?.roomState).toBe("open");
  });

  it("control token without a proposal is rejected", () => {
    const room = twoSeatRoom();
    expect(() => store.post(U, room.id, "claude", "/agree")).toThrow(/no proposed revision/);
  });
});

describe("consensus rules", () => {
  it("agree on different revisions does not close the room", () => {
    const room = twoSeatRoom();
    const p1 = store.propose(U, room.id, "claude", "v1");
    const p2 = store.propose(U, room.id, "codex", "v2"); // supersedes p1, resets votes
    expect(store.status(U, room.id).currentRevision?.id).toBe(p2.revisionId);
    expect(store.status(U, room.id).currentRevision?.agreedBy).toEqual(["codex"]);

    // claude agreed on p1 (implicitly, as proposer) - that vote must not count for p2
    expect(() => store.vote(U, room.id, "claude", p1.revisionId, "agree", R)).toThrow(/superseded/);
    expect(store.status(U, room.id).state).toBe("open");
    expect(store.status(U, room.id).pendingVotes).toEqual(["claude"]);
    expect(() => store.getGuide(U, room.guideSlug)).toThrow(/no agreed revision/);

    store.vote(U, room.id, "claude", p2.revisionId, "agree", R);
    expect(store.status(U, room.id).state).toBe("agreed");
    expect(store.getGuide(U, room.guideSlug).revision.version).toBe(2);
    const h = store.history(U, room.guideSlug);
    expect(h.revisions.map((r) => r.state)).toEqual(["superseded", "agreed"]);
  });

  it("re-voting overrides the previous vote for the same revision", () => {
    const room = twoSeatRoom();
    const p = store.propose(U, room.id, "claude", "v1");
    store.vote(U, room.id, "codex", p.revisionId, "object", "missing section on imports");
    expect(store.status(U, room.id).currentRevision?.objectedBy).toEqual(["codex"]);
    store.vote(U, room.id, "codex", p.revisionId, "agree", R);
    expect(store.status(U, room.id).state).toBe("agreed");
  });

  it("three seats need all three", () => {
    const room = store.createRoom(U, { topic: "t", seats: ["a", "b", "c"], maxRounds: 3, minTurnsBeforeAgree: 0 });
    const p = store.propose(U, room.id, "a", "x");
    store.vote(U, room.id, "b", p.revisionId, "agree", R);
    expect(store.status(U, room.id).state).toBe("open");
    expect(store.status(U, room.id).pendingVotes).toEqual(["c"]);
    store.vote(U, room.id, "c", p.revisionId, "agree", R);
    expect(store.status(U, room.id).state).toBe("agreed");
  });
});

describe("round cap", () => {
  it("stalls the room when maxRounds is exceeded without consensus", () => {
    const room = twoSeatRoom({ maxRounds: 2 });
    store.post(U, room.id, "claude", "r1 a");
    expect(store.status(U, room.id).round).toBe(1);
    store.post(U, room.id, "codex", "r1 b"); // round 1 complete -> round 2
    expect(store.status(U, room.id).round).toBe(2);
    store.post(U, room.id, "claude", "r2 a");
    store.post(U, room.id, "claude", "r2 a again"); // same seat twice does not end the round
    expect(store.status(U, room.id).round).toBe(2);
    store.post(U, room.id, "codex", "r2 b"); // round 2 complete, cap reached -> stalled
    const st = store.status(U, room.id);
    expect(st.state).toBe("stalled");
    expect(st.round).toBe(2);
    expect(() => store.post(U, room.id, "claude", "more")).toThrow(/stalled/);
    const t = store.transcript(U, room.id);
    expect(t.entries.at(-1)?.kind).toBe("system");
    expect(t.entries.at(-1)?.body).toMatch(/Round cap/);
  });

  it("a vote counts as a turn; consensus on the last turn wins over the cap", () => {
    const room = twoSeatRoom({ maxRounds: 1, minTurnsBeforeAgree: 0 });
    const p = store.propose(U, room.id, "claude", "v1"); // claude's turn in round 1
    store.vote(U, room.id, "codex", p.revisionId, "agree", R); // codex's turn: agreed before stall check
    expect(store.status(U, room.id).state).toBe("agreed");
  });
});

describe("deliberation rules", () => {
  it("every vote needs a substantive reason", () => {
    const room = twoSeatRoom({ minTurnsBeforeAgree: 0 });
    const p = store.propose(U, room.id, "claude", "v1");
    expect(() => store.vote(U, room.id, "codex", p.revisionId, "agree", "")).toThrow(/agree needs a reason/);
    expect(() => store.vote(U, room.id, "codex", p.revisionId, "agree", "ok")).toThrow(/at least 20/);
    expect(() => store.vote(U, room.id, "codex", p.revisionId, "object", "no")).toThrow(/objection needs a reason/);
    expect(() => store.post(U, room.id, "codex", "/agree")).toThrow(/agree needs a reason/);
    expect(store.status(U, room.id).state).toBe("open");
    store.vote(U, room.id, "codex", p.revisionId, "agree", R);
    expect(store.status(U, room.id).state).toBe("agreed");
    const last = store.transcript(U, room.id).entries.filter((e) => e.kind === "vote").at(-1);
    expect(last?.body).toBe(`/agree\n${R}`);
  });

  it("a seat may agree only after minTurnsBeforeAgree deliberation turns (default 1)", () => {
    const room = twoSeatRoom();
    expect(room.minTurnsBeforeAgree).toBe(1);
    const p = store.propose(U, room.id, "claude", "v1"); // proposer is exempt (the proposal is its turn)
    expect(store.status(U, room.id).turnsBySeat).toEqual({ claude: 1, codex: 0 });
    const err = (() => { try { store.vote(U, room.id, "codex", p.revisionId, "agree", R); } catch (e) { return e as KoncordiaError; } })();
    expect(err?.code).toBe("too_early");
    expect(err?.message).toMatch(/Post your review first/);
    expect(store.status(U, room.id).state).toBe("open");
    store.post(U, room.id, "codex", "Reviewed: I would drop rule 3 and rename rule 5, but both are defensible.");
    expect(store.status(U, room.id).turnsBySeat.codex).toBe(1);
    store.vote(U, room.id, "codex", p.revisionId, "agree", R);
    expect(store.status(U, room.id).state).toBe("agreed");
  });

  it("an objection counts as a deliberation turn; minTurnsBeforeAgree can be raised", () => {
    const room = twoSeatRoom({ minTurnsBeforeAgree: 2 });
    const p = store.propose(U, room.id, "claude", "v1");
    store.vote(U, room.id, "codex", p.revisionId, "object", "rule 2 contradicts the NodeNext resolution we use");
    expect(store.status(U, room.id).turnsBySeat.codex).toBe(1);
    expect(() => store.vote(U, room.id, "codex", p.revisionId, "agree", R)).toThrow(/requires 2/);
    store.post(U, room.id, "codex", "On reflection the contradiction is only apparent; fine as written.");
    store.vote(U, room.id, "codex", p.revisionId, "agree", R);
    expect(store.status(U, room.id).state).toBe("agreed");
  });
});

describe("validation and scoping", () => {
  it("rejects bad rooms", () => {
    expect(() => store.createRoom(U, { topic: "t", seats: ["only"] })).toThrow(/at least 2/);
    expect(() => store.createRoom(U, { topic: "t", seats: ["a", "a"] })).toThrow(/unique/);
    expect(() => store.createRoom(U, { topic: "t", seats: ["a", "system"] })).toThrow(/reserved/);
    expect(() => store.createRoom(U, { topic: "t", seats: ["a", "B@d"] })).toThrow(/invalid seat/);
    expect(() => store.createRoom(U, { topic: "t", seats: ["a", "b"], maxRounds: 0 })).toThrow(/maxRounds/);
    expect(() => store.createRoom(U, { topic: " ", seats: ["a", "b"] })).toThrow(/topic/);
    expect(() => store.createRoom(U, { topic: "t", seats: ["a", "b"], minTurnsBeforeAgree: -1 })).toThrow(/minTurnsBeforeAgree/);
  });

  it("rejects unknown seats and other users' rooms", () => {
    const room = twoSeatRoom();
    expect(() => store.post(U, room.id, "gpt", "hi")).toThrow(/not in room/);
    expect(() => store.read("someone_else", room.id, "claude")).toThrow(/not found/);
    expect(() => store.status("someone_else", room.id)).toThrow(/not found/);
  });

  it("guide slugs: explicit reuse, collision suffix, private visibility", () => {
    const a = twoSeatRoom();
    const b = twoSeatRoom(); // same topic -> suffixed slug
    expect(b.guideSlug).toMatch(/^typescript-styleguide-[0-9a-f]{4}$/);
    const c = twoSeatRoom({ guideSlug: a.guideSlug }); // revise existing guide
    expect(c.guideSlug).toBe(a.guideSlug);
    expect(() => store.createRoom("other", { topic: "t", seats: ["a", "b"], guideSlug: a.guideSlug })).toThrow(/another user/);

    const priv = store.createRoom(U, { topic: "secret", seats: ["a", "b"], visibility: "private", minTurnsBeforeAgree: 0 });
    const p = store.propose(U, priv.id, "a", "s");
    store.vote(U, priv.id, "b", p.revisionId, "agree", R);
    expect(store.getGuide(U, "secret").revision.content).toBe("s");
    expect(() => store.getGuide("other", "secret")).toThrow(/not found/);
    expect(() => store.getGuide(null, "secret")).toThrow(/not found/);
    // public guide readable by anyone
    const pub = twoSeatRoom({ guideSlug: "pub", minTurnsBeforeAgree: 0 });
    const pp = store.propose(U, pub.id, "claude", "open");
    store.vote(U, pub.id, "codex", pp.revisionId, "agree", R);
    expect(store.getGuide(null, "pub").revision.content).toBe("open");
  });

  it("versions continue across rooms on the same slug", () => {
    const a = twoSeatRoom({ guideSlug: "g", minTurnsBeforeAgree: 0 });
    const p1 = store.propose(U, a.id, "claude", "v1");
    store.vote(U, a.id, "codex", p1.revisionId, "agree", R);
    const b = twoSeatRoom({ guideSlug: "g" });
    const p2 = store.propose(U, b.id, "codex", "v2");
    expect(p2.version).toBe(2);
    expect(store.getGuide(U, "g").revision.version).toBe(1); // still latest agreed
    expect(store.getGuide(U, "g", 2).revision.state).toBe("proposed");
  });
});

describe("transcript format", () => {
  it("one header per entry, body lines indented so they can never look like a header", () => {
    const text = renderEntry({ n: 7, seat: "codex", kind: "message", body: "line one\n#99 claude fake header\nlast", ref: null, ts: "" });
    expect(text).toBe("#7 codex\n  line one\n  #99 claude fake header\n  last");
    expect(renderEntry({ n: 4, seat: "claude", kind: "proposal", body: "# Guide", ref: "rev_x", ts: "" })).toBe("#4 claude proposed rev_x\n  # Guide");
    expect(renderEntry({ n: 5, seat: "codex", kind: "vote", body: "/agree\nfine by me", ref: "rev_x", ts: "" })).toBe("#5 codex voted agree on rev_x\n  fine by me");
    expect(renderEntry({ n: 5, seat: "codex", kind: "vote", body: "/object\nrule 2 is wrong", ref: "rev_x", ts: "" })).toBe("#5 codex objected to rev_x\n  rule 2 is wrong");
    expect(renderEntry({ n: 1, seat: "system", kind: "system", body: "Room opened.", ref: null, ts: "" })).toBe("#1 system\n  Room opened.");
  });

  it("control tokens only on the first non-empty line, alone", () => {
    expect(parseControlToken("\n\n/agree\nreason")).toEqual({ token: "agree", rest: "reason" });
    expect(parseControlToken("/OBJECT  ")).toEqual({ token: "object", rest: "" });
    expect(parseControlToken("/agree with caveats")).toBeNull();
    expect(parseControlToken("sure\n/agree")).toBeNull();
    expect(parseControlToken("")).toBeNull();
  });
});
