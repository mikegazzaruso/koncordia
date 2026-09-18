import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Auth, TokenSigner } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { createHttpServer } from "../src/http.js";
import { EARLY_ACCESS_QUOTAS, KoncordiaError, Store } from "../src/store.js";

const R = "checked every section against the repo; accept the trade-offs";

describe("early-access quotas", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(openDb(":memory:"), { quotas: { activeRooms: 2, roomsPerMonth: 3, privateGuides: 1, retentionDays: 30 } });
  });

  it("caps open rooms, rooms per month and private guides", () => {
    store.createRoom("u", { topic: "a", seats: ["x", "y"] });
    store.createRoom("u", { topic: "b", seats: ["x", "y"] });
    expect(() => store.createRoom("u", { topic: "c", seats: ["x", "y"] })).toThrow(/2 open room/);
    // closing one frees a slot
    const r = store.createRoom("v", { topic: "other user", seats: ["x", "y"] });
    expect(r.state).toBe("open");
    const rooms = store.listRooms("u");
    const p = store.propose("u", rooms[0].id, "x", "v1");
    store.post("u", rooms[0].id, "y", "reviewed, fine by me really");
    store.vote("u", rooms[0].id, "y", p.revisionId, "agree", R);
    const c = store.createRoom("u", { topic: "c", seats: ["x", "y"] }); // 3rd this month
    expect(() => store.createRoom("u", { topic: "d", seats: ["x", "y"] })).toThrow(/open room/);
    // close both open rooms: the monthly cap is what remains
    for (const id of [rooms[1].id, c.id]) {
      const pr = store.propose("u", id, "x", "v1");
      store.post("u", id, "y", "reviewed, fine by me really");
      store.vote("u", id, "y", pr.revisionId, "agree", R);
    }
    expect(() => store.createRoom("u", { topic: "d", seats: ["x", "y"] })).toThrow(/this month/);
  });

  it("limits private guides but allows reusing an existing private slug", () => {
    store.createRoom("u", { topic: "secret one", seats: ["x", "y"], visibility: "private", guideSlug: "s1" });
    expect(() => store.createRoom("u", { topic: "secret two", seats: ["x", "y"], visibility: "private" })).toThrow(/private guide/);
    // revising s1 in a new room is fine (the first room must not count as open: close it)
    const first = store.listRooms("u")[0];
    const p = store.propose("u", first.id, "x", "v1");
    store.post("u", first.id, "y", "reviewed, fine by me really");
    store.vote("u", first.id, "y", p.revisionId, "agree", R);
    expect(store.createRoom("u", { topic: "secret one again", seats: ["x", "y"], visibility: "private", guideSlug: "s1" }).guideSlug).toBe("s1");
  });

  it("caps entries per room and per month", () => {
    const tight = new Store(openDb(":memory:"), { quotas: { ...EARLY_ACCESS_QUOTAS, entriesPerRoom: 4, entriesPerMonth: 5 } });
    const room = tight.createRoom("u", { topic: "t", seats: ["x", "y"] }); // entry 1 = system
    tight.post("u", room.id, "x", "one");
    tight.post("u", room.id, "y", "two");
    tight.post("u", room.id, "x", "three"); // entry 4
    expect(() => tight.post("u", room.id, "y", "four")).toThrow(/400|limit of 4 entries/);
    const room2 = tight.createRoom("u", { topic: "t2", seats: ["x", "y"] });
    tight.post("u", room2.id, "x", "four"); // 4th entry this month
    tight.post("u", room2.id, "y", "five"); // 5th
    expect(() => tight.post("u", room2.id, "x", "six")).toThrow(/this month/);
  });

  it("admin: ban revokes keys, stalls rooms, hides guides", () => {
    const db = openDb(":memory:");
    const s = new Store(db);
    const a = new Auth(db);
    const uid = a.upsertGithubUser({ id: "1", login: "mallory", email: null });
    a.setStatus(uid, "approved");
    a.createKeyForUser(uid);
    s.createRoom(uid, { topic: "spam", seats: ["x", "y"], guideSlug: "spam" });
    expect(a.findUser("mallory")?.id).toBe(uid);
    expect(a.revokeAllKeys(uid)).toBe(1);
    expect(s.banUser(uid)).toEqual({ rooms: 1, guides: 1 });
    expect(s.listPublicGuides()).toEqual([]);
    expect(s.setGuideVisibility("spam", "public")).toBe(true);
  });

  it("unlimited when quotas are null", () => {
    const free = new Store(openDb(":memory:"));
    for (let i = 0; i < 5; i++) free.createRoom("u", { topic: `t${i}`, seats: ["x", "y"], visibility: "private" });
    expect(free.listRooms("u")).toHaveLength(5);
  });
});

describe("retention", () => {
  it("archives old rooms: transcript gone, guide kept", () => {
    const store = new Store(openDb(":memory:"));
    const room = store.createRoom("u", { topic: "old", seats: ["x", "y"], minTurnsBeforeAgree: 0 });
    const p = store.propose("u", room.id, "x", "keep me");
    store.vote("u", room.id, "y", p.revisionId, "agree", R);
    const fresh = store.createRoom("u", { topic: "new", seats: ["x", "y"] });
    const future = new Date(Date.now() + 40 * 86_400_000);
    expect(store.archiveOldRooms(30, future)).toBe(2);
    expect(store.archiveOldRooms(30, future)).toBe(0);
    expect(store.getRoom("u", room.id).state).toBe("archived");
    expect(store.transcript("u", room.id).entries).toEqual([]);
    expect(store.getGuide("u", room.guideSlug).revision.content).toBe("keep me");
    expect(() => store.post("u", fresh.id, "x", "hello")).toThrow(/archived/);
    expect(store.archiveOldRooms(30)).toBe(0); // nothing is old relative to now
  });
});

describe("waitlist", () => {
  it("dedupes per email+tier and validates", () => {
    const store = new Store(openDb(":memory:"));
    expect(store.waitlistAdd("A@Example.com", "managed", "1.2.3.4")).toEqual({ added: true });
    expect(store.waitlistAdd("a@example.com", "managed", null)).toEqual({ added: false });
    expect(store.waitlistAdd("a@example.com", "hosted", null)).toEqual({ added: true });
    expect(() => store.waitlistAdd("nope", "managed", null)).toThrow(KoncordiaError);
    expect(() => store.waitlistAdd("a@example.com", "x y", null)).toThrow(/tier/);
    expect(store.waitlistCount()).toBe(2);
    expect(store.waitlistCount("managed")).toBe(1);
  });
});

describe("TokenSigner", () => {
  it("round-trips, rejects tampering and expiry", () => {
    const s = new TokenSigner("0123456789abcdef0123");
    const t = s.sign("s:usr_1", 60);
    expect(s.verify(t)).toBe("s:usr_1");
    expect(s.verify(t.slice(0, -2) + "zz")).toBeNull();
    expect(s.verify(s.sign("x", -1))).toBeNull();
    expect(new TokenSigner("another-secret-value!").verify(t)).toBeNull();
    expect(() => new TokenSigner("short")).toThrow();
  });
});

describe("hosted HTTP: sign-in, dashboard, public guides, waitlist, rate limit", () => {
  let srv: Server;
  let base: string;
  let store: Store;
  let auth: Auth;
  const site = "https://site.test";

  const fakeGithub: typeof fetch = async (input) => {
    const u = String(input);
    const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/login/oauth/access_token")) return j({ access_token: "gho_test" });
    if (u.endsWith("/user/emails")) return j([{ email: "octo@example.com", primary: true, verified: true }]);
    if (u.endsWith("/user")) return j({ id: 583231, login: "octocat", email: null });
    return new Response("nope", { status: 404 });
  };

  beforeEach(async () => {
    const db = openDb(":memory:");
    store = new Store(db, { quotas: EARLY_ACCESS_QUOTAS });
    auth = new Auth(db);
    auth = new Auth(db, { autoApproveLogins: ["owner"] });
    srv = createHttpServer({
      store,
      auth,
      siteUrl: site,
      secret: "test-secret-0123456789",
      github: { clientId: "cid", clientSecret: "csec", fetchImpl: fakeGithub },
      rateLimitPerMinute: 60,
      trustProxy: true,
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => srv.close(r));
  });

  const get = (p: string, init: RequestInit = {}) => fetch(base + p, { redirect: "manual", ...init });

  const login = async () => {
    const start = await get("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    return get(`/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`);
  };
  const form = (session: string, body: Record<string, string>, path: string) =>
    get(path, { method: "POST", headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

  it("early access is gated: sign-in leads to an application, keys only after approval", async () => {
    const cb = await login();
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/apply");
    const session = cb.headers.get("set-cookie")!.split(";")[0];
    const uid = auth.findUser("octocat")!.id;
    expect(auth.getUser(uid)!.status).toBe("pending");

    // dashboard and key creation are closed
    expect((await get("/dashboard", { headers: { cookie: session } })).headers.get("location")).toBe("/apply");
    const formPage = await (await get("/apply", { headers: { cookie: session } })).text();
    expect(formPage).toContain("Apply for early access");
    const csrf = /name="csrf" value="([^"]+)"/.exec(formPage)![1];
    expect(() => auth.createKeyForUser(uid)).toThrow(/pending/);

    // incomplete application is rejected with the form re-rendered
    const bad = await form(session, { csrf, name: "Octo", organization: "", useCase: "short", agents: "Claude Code" }, "/apply");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Please fill in");

    const ok = await form(session, { csrf, name: "Octo Cat", organization: "GitHub, platform team", useCase: "Agree on a TypeScript styleguide across four repos with Claude Code and Codex.", agents: "Claude Code, Codex", link: "https://github.com/octocat" }, "/apply");
    expect(ok.status).toBe(302);
    const pending = await (await get("/apply", { headers: { cookie: session } })).text();
    expect(pending).toContain("Application received");
    expect(pending).toContain("platform team");
    expect(auth.listApplications("pending").map((u) => u.githubLogin)).toEqual(["octocat"]);

    // approve from the CLI side, log in again: key issued once
    expect(auth.setStatus(uid, "approved")).toBe(true);
    const cb2 = await login();
    expect(cb2.status).toBe(200);
    const key = /kc_[A-Za-z0-9_-]{20,}/.exec(await cb2.text())![0];
    expect(auth.resolve(key)!.userId).toBe(uid);

    // rejecting or banning the user kills the key immediately
    auth.setStatus(uid, "banned");
    expect(auth.resolve(key)).toBeNull();
    const mcp = await get("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(mcp.status).toBe(401);
    auth.setStatus(uid, "rejected");
    const cb3 = await login();
    const rej = await (await get("/apply", { headers: { cookie: cb3.headers.get("set-cookie")!.split(";")[0] } })).text();
    expect(rej).toContain("Not approved this time");
  });

  it("an auto-approved login (the owner) gets a key on first sign-in and the dashboard manages keys", async () => {
    const cb = await login();
    expect(cb.status).toBe(302); // octocat is not auto-approved
    // simulate the owner: approve then continue with the classic flow
    auth.setStatus(auth.findUser("octocat")!.id, "approved");
    const start = await get("/auth/github");
    const loc = new URL(start.headers.get("location")!);
    expect(loc.host).toBe("github.com");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${base}/auth/github/callback`);
    const state = loc.searchParams.get("state")!;
    const cb1 = await get(`/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(cb1.status).toBe(200);
    const page = await cb1.text();
    const key = /kc_[A-Za-z0-9_-]{20,}/.exec(page)?.[0];
    expect(key).toBeDefined();
    expect(page).toContain("claude mcp add --transport http koncordia");
    const cookie = cb1.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^kc_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(auth.resolve(key!)?.userId).toBe(auth.getUser(auth.resolve(key!)!.userId)!.id);
    expect(auth.getUser(auth.resolve(key!)!.userId)!.githubLogin).toBe("octocat");

    // the key works on /mcp
    const mcp = await get("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(200);

    // dashboard with the cookie
    const session = cookie.split(";")[0];
    const dash = await get("/dashboard", { headers: { cookie: session } });
    expect(dash.status).toBe(200);
    const dashHtml = await dash.text();
    expect(dashHtml).toContain("octocat");
    expect(dashHtml).toContain("early access");
    const csrf = /name="csrf" value="([^"]+)"/.exec(dashHtml)![1];

    // create a second key, then revoke it
    const created = await get("/dashboard/keys", { method: "POST", headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "create", label: "ci" }) });
    expect(created.status).toBe(200);
    const key2 = /kc_[A-Za-z0-9_-]{20,}/.exec(await created.text())![0];
    const keyId2 = auth.resolve(key2)!.id;
    const revoked = await get("/dashboard/keys", { method: "POST", headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "revoke", keyId: keyId2 }) });
    expect(revoked.status).toBe(302);
    expect(auth.resolve(key2)).toBeNull();
    // wrong csrf
    const bad = await get("/dashboard/keys", { method: "POST", headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "x", action: "create" }) });
    expect(bad.status).toBe(403);

    // second login: no new key, straight to dashboard
    const start2 = await get("/auth/github");
    const state2 = new URL(start2.headers.get("location")!).searchParams.get("state")!;
    const cb2 = await get(`/auth/github/callback?code=abc&state=${encodeURIComponent(state2)}`);
    expect(cb2.status).toBe(302);
    expect(cb2.headers.get("location")).toBe("/dashboard");
    expect(auth.listKeys().length).toBe(2);

    // logout clears the cookie
    const out = await get("/logout", { method: "POST", headers: { cookie: session } });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("auto-approve list skips the queue", () => {
    const db = openDb(":memory:");
    const a = new Auth(db, { autoApproveLogins: ["MikeGazzaruso"] });
    const uid = a.upsertGithubUser({ id: "7", login: "mikegazzaruso", email: "m@x.io" });
    expect(a.getUser(uid)!.status).toBe("approved");
    const other = a.upsertGithubUser({ id: "8", login: "someone", email: null });
    expect(a.getUser(other)!.status).toBe("pending");
  });

  it("admin: password login, approve and reject applications from the web page", async () => {
    // an applicant
    const cb = await login();
    const applicant = cb.headers.get("set-cookie")!.split(";")[0];
    const fp = await (await get("/apply", { headers: { cookie: applicant } })).text();
    const acsrf = /name="csrf" value="([^"]+)"/.exec(fp)![1];
    await form(applicant, { csrf: acsrf, name: "Octo Cat", organization: "GitHub", useCase: "Agree on a styleguide across our monorepo with two agents.", agents: "Claude Code" }, "/apply");
    const applicantId = auth.findUser("octocat")!.id;

    // an admin created from the CLI side
    const adminId = auth.ensureUser("boss@example.com");
    auth.setPassword(adminId, "correct horse battery");
    expect(auth.verifyPassword("boss@example.com", "wrong password!")).toBeNull();
    expect(auth.verifyPassword("BOSS@example.com", "correct horse battery")?.id).toBe(adminId);
    expect(() => auth.setPassword(adminId, "short")).toThrow(/10 characters/);

    // not admin yet: login refused
    let r = await form("", { email: "boss@example.com", password: "correct horse battery" }, "/admin/login");
    expect(r.status).toBe(401);
    auth.setRole(adminId, "admin");
    r = await form("", { email: "boss@example.com", password: "nope nope nope" }, "/admin/login");
    expect(r.status).toBe(401);
    r = await form("", { email: "boss@example.com", password: "correct horse battery" }, "/admin/login");
    expect(r.status).toBe(302);
    const admin = r.headers.get("set-cookie")!.split(";")[0];

    // the applicant's session cannot open /admin
    expect(await (await get("/admin", { headers: { cookie: applicant } })).text()).toContain("Admin");
    expect(await (await get("/admin", { headers: { cookie: applicant } })).text()).not.toContain("Pending (");

    const page = await (await get("/admin", { headers: { cookie: admin } })).text();
    expect(page).toContain("Pending (1)");
    expect(page).toContain("Octo Cat");
    expect(page).toContain("monorepo");
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];

    r = await form(admin, { csrf, userId: applicantId, action: "approve" }, "/admin/users");
    expect(r.status).toBe(302);
    expect(auth.getUser(applicantId)!.status).toBe("approved");
    const after = await (await get("/admin", { headers: { cookie: admin } })).text();
    expect(after).toContain("Pending (0)");
    expect(after).toContain("approved");

    // approved applicant now gets a key at sign-in; rejecting revokes it
    const cb2 = await login();
    const key = /kc_[A-Za-z0-9_-]{20,}/.exec(await cb2.text())![0];
    expect(auth.resolve(key)).not.toBeNull();
    r = await form(admin, { csrf, userId: applicantId, action: "reject" }, "/admin/users");
    expect(auth.getUser(applicantId)!.status).toBe("rejected");
    expect(auth.resolve(key)).toBeNull();

    // csrf and non-admin posts are refused
    expect((await form(admin, { csrf: "x", userId: applicantId, action: "approve" }, "/admin/users")).status).toBe(403);
    expect((await form(applicant, { csrf, userId: applicantId, action: "approve" }, "/admin/users")).headers.get("location")).toBe("/admin");
  });

  it("GitHub sign-in attaches to an existing email-only user", () => {
    const db = openDb(":memory:");
    const a = new Auth(db);
    const id = a.ensureUser("octo@example.com");
    a.setRole(id, "admin");
    const linked = a.upsertGithubUser({ id: "583231", login: "octocat", email: "octo@example.com" });
    expect(linked).toBe(id);
    expect(a.getUser(id)!.githubLogin).toBe("octocat");
    expect(a.getUser(id)!.role).toBe("admin");
    expect(a.listUsers()).toHaveLength(1);
  });

  it("rejects a bad or expired OAuth state and shows login without a session", async () => {
    const cb = await get("/auth/github/callback?code=abc&state=bogus");
    expect(cb.status).toBe(400);
    const dash = await get("/dashboard");
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain("Continue with GitHub");
  });

  it("serves public guide pages and raw markdown without auth; private ones 404", async () => {
    const room = store.createRoom("u", { topic: "Commit rules", seats: ["claude", "codex"], guideSlug: "commits", guideKind: "rule", minTurnsBeforeAgree: 0 });
    const p = store.propose("u", room.id, "claude", "# Commits\n- conventional");
    store.vote("u", room.id, "codex", p.revisionId, "agree", R);
    const priv = store.createRoom("u", { topic: "Secret", seats: ["a", "b"], guideSlug: "secret", visibility: "private", minTurnsBeforeAgree: 0 });
    const pp = store.propose("u", priv.id, "a", "hidden");
    store.vote("u", priv.id, "b", pp.revisionId, "agree", R);

    const idx = await get("/g");
    expect(idx.status).toBe(200);
    const idxHtml = await idx.text();
    expect(idxHtml).toContain("Commit rules");
    expect(idxHtml).not.toContain("secret");

    const page = await get("/g/commits");
    expect(page.status).toBe(200);
    const h = await page.text();
    expect(h).toContain("# Commits");
    expect(h).toContain("Consensus reached");
    expect(h).toContain("koncordia://guides/commits/latest");

    const raw = await get("/g/commits/raw");
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toBe("# Commits\n- conventional");
    expect((await get("/g/commits/v/1")).status).toBe(200);
    expect((await get("/g/commits/v/2")).status).toBe(404);
    expect((await get("/g/secret")).status).toBe(404);
    expect((await get("/g/nope")).status).toBe(404);
  });

  it("waitlist accepts JSON and form posts with CORS for the site origin only", async () => {
    const pre = await get("/waitlist", { method: "OPTIONS", headers: { origin: site } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(site);
    const r1 = await get("/waitlist", { method: "POST", headers: { "content-type": "application/json", origin: site }, body: JSON.stringify({ email: "dev@example.com", tier: "managed" }) });
    expect(await r1.json()).toEqual({ ok: true, added: true });
    expect(r1.headers.get("access-control-allow-origin")).toBe(site);
    const r2 = await get("/waitlist", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" }, body: "email=dev%40example.com&tier=managed" });
    expect(await r2.json()).toEqual({ ok: true, added: false });
    expect(r2.headers.get("access-control-allow-origin")).toBeNull();
    const bad = await get("/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x" }) });
    expect(bad.status).toBe(400);
    expect(store.waitlistCount("managed")).toBe(1);
  });

  it("rate limits per client IP and charges failed auth more", async () => {
    // 60/min; 12 bad auth attempts x 6 (1 + 5 penalty) > 60
    let last = 0;
    for (let i = 0; i < 14; i++) {
      const r = await get("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer kc_wrong", "x-forwarded-for": "9.9.9.9" }, body: "{}" });
      last = r.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    // a different IP is unaffected
    const ok = await get("/healthz", { headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(ok.status).toBe(200);
  });
});
