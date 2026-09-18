import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { githubAuthorizeUrl, githubExchange, LOCAL_USER_ID, TokenSigner, type Auth, type GithubOAuthConfig } from "./auth.js";
import { createMcpServer } from "./mcp.js";
import { adminLoginPage, adminPage, applyPage, dashboardPage, guidePage, guidesIndexPage, keyPage, loginPage, messagePage, pendingPage } from "./pages.js";
import { KoncordiaError, type Store } from "./store.js";

export interface HttpOptions {
  store: Store;
  auth: Auth;
  /** Disable bearer auth: every request acts as the local user. Dev only. */
  noAuth?: boolean;
  /** Path the MCP endpoint listens on. Default "/mcp". */
  path?: string;
  /** Hosts allowed in the Host header (DNS-rebinding protection). Empty = no check (put nginx in front). */
  allowedHosts?: string[];
  /** Absolute public URL of this API (for OAuth callback and snippets). Default http://127.0.0.1:<port>. */
  publicUrl?: string;
  /** Absolute URL of the marketing site (CORS for the waitlist form, links). */
  siteUrl?: string;
  /** HMAC secret for OAuth state and dashboard sessions. Required when github is set. */
  secret?: string;
  github?: Omit<GithubOAuthConfig, "callbackUrl"> & { callbackUrl?: string };
  /** Requests per minute per client (IP, or key on /mcp). Default 120. */
  rateLimitPerMinute?: number;
  /** Trust X-Forwarded-For (behind nginx). Default: true unless noAuth. */
  trustProxy?: boolean;
  log?: (msg: string) => void;
}

const MAX_BODY = 1_000_000;
const SESSION_COOKIE = "kc_session";
const SESSION_TTL = 7 * 86400;

// ---------- small helpers ----------

async function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const raw = await readRaw(req);
  if (!raw) return undefined;
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("invalid JSON body");
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Fixed-window counter per client key. Good enough behind one nginx; not distributed. */
class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();
  constructor(private readonly perMinute: number) {
    setInterval(() => {
      const cutoff = Date.now() - 120_000;
      for (const [k, v] of this.hits) if (v.windowStart < cutoff) this.hits.delete(k);
    }, 60_000).unref();
  }
  /** Returns seconds to wait, or 0 if allowed. */
  check(key: string, weight = 1): number {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || now - cur.windowStart >= 60_000) {
      this.hits.set(key, { count: weight, windowStart: now });
      return 0;
    }
    cur.count += weight;
    if (cur.count > this.perMinute) return Math.ceil((cur.windowStart + 60_000 - now) / 1000);
    return 0;
  }
}

/**
 * Plain Node HTTP server. Stateless Streamable HTTP on `path` (a fresh McpServer + transport per
 * request), plus GitHub sign-in, a minimal dashboard, public guide pages and the waitlist endpoint.
 */
export function createHttpServer(opts: HttpOptions): Server {
  const path = opts.path ?? "/mcp";
  const log = opts.log ?? (() => {});
  const siteUrl = (opts.siteUrl ?? "https://koncordia.dev").replace(/\/$/, "");
  const trustProxy = opts.trustProxy ?? !opts.noAuth;
  const limiter = new RateLimiter(opts.rateLimitPerMinute ?? 120);
  const signer = opts.secret ? new TokenSigner(opts.secret) : null;
  if (opts.github && !signer) throw new Error("github sign-in needs `secret` (KONCORDIA_SECRET)");
  let publicUrl = (opts.publicUrl ?? "").replace(/\/$/, "");
  // publicUrl may only be known from the first request's Host header, so resolve the callback lazily.
  const github = (): GithubOAuthConfig | null =>
    opts.github ? { ...opts.github, callbackUrl: opts.github.callbackUrl ?? `${publicUrl}/auth/github/callback` } : null;
  const secure = publicUrl.startsWith("https://");

  const clientIp = (req: IncomingMessage): string => {
    const xff = trustProxy ? (req.headers["x-forwarded-for"] as string | undefined) : undefined;
    return (xff?.split(",")[0].trim() || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  };

  const sessionUser = (req: IncomingMessage): string | null => {
    if (!signer) return null;
    const v = signer.verify(cookies(req)[SESSION_COOKIE]);
    return v?.startsWith("s:") ? v.slice(2) : null;
  };
  const setSession = (userId: string) =>
    `${SESSION_COOKIE}=${encodeURIComponent(signer!.sign(`s:${userId}`, SESSION_TTL))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secure ? "; Secure" : ""}`;
  const clearSession = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  const csrfFor = (userId: string) => signer!.sign(`c:${userId}`, 3600);
  const csrfOk = (userId: string, token: unknown) => signer!.verify(typeof token === "string" ? token : "") === `c:${userId}`;

  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (!origin || origin !== siteUrl) return {};
    return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" };
  };

  return createServer(async (req, res) => {
    if (!publicUrl) publicUrl = `http://${req.headers.host ?? "127.0.0.1"}`;
    const url = new URL(req.url ?? "/", publicUrl || "http://localhost");
    const ip = clientIp(req);
    const wait = limiter.check(`ip:${ip}`);
    if (wait) return json(res, 429, { error: "rate limited" }, { "retry-after": String(wait) });

    try {
      // ---------- health ----------
      if (url.pathname === "/healthz") return json(res, 200, { ok: true, name: "koncordia" });

      // ---------- MCP ----------
      if (url.pathname === path) return handleMcp(req, res, ip);

      // ---------- waitlist ----------
      if (url.pathname === "/waitlist") {
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders(req));
          return res.end();
        }
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        if (limiter.check(`wl:${ip}`, 12)) return json(res, 429, { error: "rate limited" }, corsHeaders(req));
        const body = (await readBody(req)) ?? {};
        try {
          const r = opts.store.waitlistAdd(String(body.email ?? ""), String(body.tier ?? "managed"), ip);
          return json(res, 200, { ok: true, added: r.added }, corsHeaders(req));
        } catch (e) {
          if (e instanceof KoncordiaError) return json(res, 400, { ok: false, error: e.message }, corsHeaders(req));
          throw e;
        }
      }

      // ---------- public guides ----------
      if (url.pathname === "/g" || url.pathname === "/g/") {
        return html(res, 200, guidesIndexPage(siteUrl, opts.store.listPublicGuides()), { "cache-control": "public, max-age=60" });
      }
      const gm = /^\/g\/([a-z0-9][a-z0-9-]{0,63})(?:\/(raw|v\/(\d+)))?$/.exec(url.pathname);
      if (gm) {
        const slug = gm[1];
        try {
          if (gm[2] === "raw") {
            const g = opts.store.getGuide(null, slug);
            res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=60" });
            return res.end(g.revision.content);
          }
          if (gm[3]) {
            const g = opts.store.getGuide(null, slug, Number(gm[3]));
            res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=60" });
            return res.end(g.revision.content);
          }
          const p = opts.store.publicGuide(slug);
          return html(res, 200, guidePage({ siteUrl, publicUrl, ...p }), { "cache-control": "public, max-age=60" });
        } catch (e) {
          if (e instanceof KoncordiaError) return html(res, 404, messagePage(siteUrl, "Not found", "No public guide with that slug."));
          throw e;
        }
      }

      // ---------- sign-in / dashboard ----------
      if (url.pathname === "/auth/github") {
        const gh = github();
        if (!gh) return html(res, 404, messagePage(siteUrl, "Sign-in disabled", "This server has no GitHub OAuth configured."));
        const state = signer!.sign(`st:${ip}`, 600);
        return redirect(res, githubAuthorizeUrl(gh, state));
      }
      if (url.pathname === "/auth/github/callback") {
        const gh = github();
        if (!gh) return html(res, 404, messagePage(siteUrl, "Sign-in disabled", "This server has no GitHub OAuth configured."));
        const st = signer!.verify(url.searchParams.get("state"));
        const code = url.searchParams.get("code");
        if (!st?.startsWith("st:") || !code) return html(res, 400, messagePage(siteUrl, "Sign-in failed", "Invalid or expired state. Try again.", `<p><a class="btn" href="/auth/github">Retry</a></p>`));
        let ghUser;
        try {
          ghUser = await githubExchange(gh, code);
        } catch (e) {
          log(`github exchange failed: ${(e as Error).message}`);
          return html(res, 502, messagePage(siteUrl, "Sign-in failed", "GitHub did not accept the code. Try again.", `<p><a class="btn" href="/auth/github">Retry</a></p>`));
        }
        const userId = opts.auth.upsertGithubUser(ghUser);
        const user = opts.auth.getUser(userId)!;
        if (user.status !== "approved") return redirect(res, "/apply", { "set-cookie": setSession(userId) });
        const hasKey = opts.auth.listKeys(userId).some((k) => !k.revokedAt);
        if (!hasKey) {
          const k = opts.auth.createKeyForUser(userId, "first");
          return html(res, 200, keyPage({ siteUrl, publicUrl, key: k.key, keyId: k.keyId, label: "first", first: true }), { "set-cookie": setSession(userId), "cache-control": "no-store" });
        }
        return redirect(res, "/dashboard", { "set-cookie": setSession(userId) });
      }
      if (url.pathname === "/apply") {
        const userId = sessionUser(req);
        if (!userId) return html(res, 200, loginPage(siteUrl), { "cache-control": "no-store" });
        const user = opts.auth.getUser(userId);
        if (!user) return html(res, 200, loginPage(siteUrl), { "set-cookie": clearSession() });
        if (user.status === "approved") return redirect(res, "/dashboard");
        if (req.method === "POST") {
          const body = (await readBody(req)) ?? {};
          if (!csrfOk(userId, body.csrf)) return html(res, 403, messagePage(siteUrl, "Expired form", "Reload the page and try again."));
          const str = (k: string, max: number) => String(body[k] ?? "").trim().slice(0, max);
          const app = { name: str("name", 200), organization: str("organization", 200), useCase: str("useCase", 2000), agents: str("agents", 200), link: str("link", 200) };
          if (!app.name || !app.organization || app.useCase.length < 20 || !app.agents) {
            return html(res, 400, applyPage({ siteUrl, user, csrf: csrfFor(userId), values: app, error: "Please fill in who you are, where you work, at least a couple of sentences on the use case, and which agents you will connect." }), { "cache-control": "no-store" });
          }
          opts.auth.apply(userId, app);
          log(`early-access application from ${user.githubLogin ?? userId} (${app.organization})`);
          return redirect(res, "/apply");
        }
        if (user.application && user.status !== "pending") return html(res, 200, pendingPage({ siteUrl, user, csrf: csrfFor(userId) }), { "cache-control": "no-store" });
        if (user.application) return html(res, 200, pendingPage({ siteUrl, user, csrf: csrfFor(userId) }), { "cache-control": "no-store" });
        return html(res, 200, applyPage({ siteUrl, user, csrf: csrfFor(userId) }), { "cache-control": "no-store" });
      }
      if (url.pathname === "/dashboard") {
        const userId = sessionUser(req);
        if (!userId) return html(res, 200, loginPage(siteUrl), { "cache-control": "no-store" });
        const user = opts.auth.getUser(userId);
        if (!user) return html(res, 200, loginPage(siteUrl), { "set-cookie": clearSession() });
        if (user.status !== "approved") return redirect(res, "/apply");
        return html(
          res,
          200,
          dashboardPage({
            siteUrl,
            publicUrl,
            user,
            keys: opts.auth.listKeys(userId),
            rooms: opts.store.listRooms(userId),
            guides: opts.store.listGuides(userId),
            usage: opts.store.usageThisMonth(userId),
            quotas: opts.store.quotas,
            csrf: csrfFor(userId),
          }),
          { "cache-control": "no-store" },
        );
      }
      if (url.pathname === "/dashboard/keys" && req.method === "POST") {
        const userId = sessionUser(req);
        if (!userId) return redirect(res, "/dashboard");
        if (opts.auth.getUser(userId)?.status !== "approved") return redirect(res, "/apply");
        const body = (await readBody(req)) ?? {};
        if (!csrfOk(userId, body.csrf)) return html(res, 403, messagePage(siteUrl, "Expired form", "Reload the dashboard and try again."));
        if (body.action === "create") {
          const active = opts.auth.listKeys(userId).filter((k) => !k.revokedAt).length;
          if (active >= 10) return html(res, 400, messagePage(siteUrl, "Too many keys", "Revoke an old key first (max 10 active)."));
          const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
          const k = opts.auth.createKeyForUser(userId, label ?? undefined);
          return html(res, 200, keyPage({ siteUrl, publicUrl, key: k.key, keyId: k.keyId, label, first: false }), { "cache-control": "no-store" });
        }
        if (body.action === "revoke" && typeof body.keyId === "string") {
          opts.auth.revokeKey(body.keyId, userId);
          return redirect(res, "/dashboard");
        }
        return html(res, 400, messagePage(siteUrl, "Bad request", "Unknown action."));
      }
      if (url.pathname === "/logout" && req.method === "POST") {
        return redirect(res, siteUrl, { "set-cookie": clearSession() });
      }

      // ---------- admin (email + password, role admin) ----------
      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        if (!signer) return json(res, 404, { error: "not found" });
        const userId = sessionUser(req);
        const admin = userId ? opts.auth.getUser(userId) : null;
        if (!admin || admin.role !== "admin") return html(res, 200, adminLoginPage(siteUrl), { "cache-control": "no-store" });
        const notice = url.searchParams.get("done") ?? undefined;
        return html(res, 200, adminPage({ siteUrl, admin, pending: opts.auth.listApplications("pending"), decided: opts.auth.listDecided(), csrf: csrfFor(userId!), notice }), { "cache-control": "no-store" });
      }
      if (url.pathname === "/admin/login" && req.method === "POST") {
        if (!signer) return json(res, 404, { error: "not found" });
        if (limiter.check(`login:${ip}`, 10)) return html(res, 429, adminLoginPage(siteUrl, "Too many attempts. Wait a minute."));
        const body = (await readBody(req)) ?? {};
        const user = opts.auth.verifyPassword(String(body.email ?? ""), String(body.password ?? ""));
        if (!user || user.role !== "admin") {
          log(`admin login failed for ${String(body.email ?? "").slice(0, 80)} from ${ip}`);
          return html(res, 401, adminLoginPage(siteUrl, "Wrong email or password."), { "cache-control": "no-store" });
        }
        return redirect(res, "/admin", { "set-cookie": setSession(user.id) });
      }
      if (url.pathname === "/admin/users" && req.method === "POST") {
        const userId = sessionUser(req);
        if (!userId || !opts.auth.isAdmin(userId)) return redirect(res, "/admin");
        const body = (await readBody(req)) ?? {};
        if (!csrfOk(userId, body.csrf)) return html(res, 403, messagePage(siteUrl, "Expired form", "Reload the page and try again."));
        const target = typeof body.userId === "string" ? opts.auth.getUser(body.userId) : null;
        if (!target) return redirect(res, "/admin?done=" + encodeURIComponent("No such user."));
        if (body.action === "approve") {
          opts.auth.setStatus(target.id, "approved");
          log(`admin ${userId} approved ${target.githubLogin ?? target.id}`);
          return redirect(res, "/admin?done=" + encodeURIComponent(`Approved ${target.githubLogin ?? target.id}. They get their key at next sign-in.`));
        }
        if (body.action === "reject") {
          opts.auth.setStatus(target.id, "rejected");
          opts.auth.revokeAllKeys(target.id);
          log(`admin ${userId} rejected ${target.githubLogin ?? target.id}`);
          return redirect(res, "/admin?done=" + encodeURIComponent(`Rejected ${target.githubLogin ?? target.id}; any keys revoked.`));
        }
        return redirect(res, "/admin");
      }
      if (url.pathname === "/admin/logout" && req.method === "POST") {
        return redirect(res, "/admin", { "set-cookie": clearSession() });
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      log(`http error ${req.method} ${url.pathname}: ${(e as Error).message}`);
      if (!res.headersSent) json(res, (e as Error).message === "body too large" ? 413 : 500, { error: (e as Error).message === "body too large" ? "body too large" : "internal error" });
    }
  });

  async function handleMcp(req: IncomingMessage, res: ServerResponse, ip: string) {
    let userId = LOCAL_USER_ID;
    let authInfo: AuthInfo | undefined;
    if (!opts.noAuth) {
      const h = req.headers.authorization ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(h);
      const key = m ? opts.auth.resolve(m[1].trim()) : null;
      if (!key) {
        limiter.check(`ip:${ip}`, 5); // failed auth costs more
        return json(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="koncordia"' });
      }
      if (limiter.check(`key:${key.id}`)) return json(res, 429, { error: "rate limited" }, { "retry-after": "10" });
      userId = key.userId;
      authInfo = { token: m![1], clientId: key.id, scopes: ["mcp"], extra: { userId } };
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") return json(res, 405, { error: "method not allowed" });

    let body: unknown;
    if (req.method === "POST") {
      const raw = await readRaw(req);
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: "invalid JSON body" });
        }
      }
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      allowedHosts: opts.allowedHosts?.length ? opts.allowedHosts : undefined,
      enableDnsRebindingProtection: Boolean(opts.allowedHosts?.length),
    });
    const server = createMcpServer(opts.store, userId);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(Object.assign(req, { auth: authInfo }), res, body);
    } catch (e) {
      log(`mcp error: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  }
}
