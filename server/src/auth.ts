import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import { newId } from "./store.js";

export const LOCAL_USER_ID = "local";

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export interface ApiKeyInfo {
  id: string;
  userId: string;
  label: string | null;
}

export type UserStatus = "pending" | "approved" | "rejected" | "banned";
export type UserRole = "user" | "admin";

export interface Application {
  name: string;
  organization: string;
  useCase: string;
  agents: string;
  link: string;
}

export interface UserInfo {
  id: string;
  email: string | null;
  githubLogin: string | null;
  status: UserStatus;
  role: UserRole;
  hasPassword: boolean;
  application: Application | null;
  appliedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
}

const USER_COLS = `id, email, github_login, status, role, password_hash, application_json, applied_at, approved_at, created_at`;
interface UserRow {
  id: string;
  email: string | null;
  github_login: string | null;
  status: UserStatus;
  role: UserRole;
  password_hash: string | null;
  application_json: string | null;
  applied_at: string | null;
  approved_at: string | null;
  created_at: string;
}
const rowToUser = (r: UserRow): UserInfo => ({
  id: r.id,
  email: r.email,
  githubLogin: r.github_login,
  status: r.status,
  role: r.role,
  hasPassword: Boolean(r.password_hash),
  application: r.application_json ? (JSON.parse(r.application_json) as Application) : null,
  appliedAt: r.applied_at,
  approvedAt: r.approved_at,
  createdAt: r.created_at,
});

/**
 * Bearer API keys (stored hashed, plaintext shown once) plus GitHub-backed users.
 * Early access is gated: a GitHub user starts `pending`, submits an application and only an
 * `approved` user can hold keys. Logins listed in `autoApproveLogins` skip the queue (the owner).
 */
export class Auth {
  constructor(
    private readonly db: Db,
    private readonly opts: { autoApproveLogins?: string[] } = {},
  ) {}

  /** CLI-created users (local dev, manual keys) are approved by construction. */
  ensureUser(email: string | null, id?: string): string {
    const now = new Date().toISOString();
    if (id) {
      this.db.prepare(`INSERT OR IGNORE INTO users (id, email, status, approved_at, created_at) VALUES (?, ?, 'approved', ?, ?)`).run(id, email, now, now);
      return id;
    }
    if (email) {
      const row = this.db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string } | undefined;
      if (row) return row.id;
    }
    const uid = newId("usr");
    this.db.prepare(`INSERT INTO users (id, email, status, approved_at, created_at) VALUES (?, ?, 'approved', ?, ?)`).run(uid, email, now, now);
    return uid;
  }

  private autoApproved(login: string): boolean {
    return (this.opts.autoApproveLogins ?? []).some((l) => l.toLowerCase() === login.toLowerCase());
  }

  /** Store the early-access application and mark the user pending review. */
  apply(userId: string, app: Application): void {
    this.db
      .prepare(`UPDATE users SET application_json = ?, applied_at = ?, status = CASE WHEN status = 'approved' THEN status ELSE 'pending' END WHERE id = ?`)
      .run(JSON.stringify(app), new Date().toISOString(), userId);
  }

  // ---------- password login (admins) ----------

  setPassword(userId: string, password: string): void {
    if (password.length < 10) throw new Error("password must be at least 10 characters");
    const salt = randomBytes(16).toString("base64url");
    const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64url");
    this.db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(`scrypt$${salt}$${hash}`, userId);
  }

  /** Verify email + password. Returns the user or null; constant-time compare on the hash. */
  verifyPassword(email: string, password: string): UserInfo | null {
    const r = this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).get(email.trim().toLowerCase()) as UserRow | undefined;
    if (!r?.password_hash) return null;
    const [, salt, stored] = r.password_hash.split("$");
    const calc = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64url");
    if (calc.length !== stored.length || !timingSafeEqual(Buffer.from(calc), Buffer.from(stored))) return null;
    return rowToUser(r);
  }

  setRole(userId: string, role: UserRole): boolean {
    return this.db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, userId).changes > 0;
  }

  isAdmin(userId: string): boolean {
    return this.getUser(userId)?.role === "admin";
  }

  setStatus(userId: string, status: UserStatus): boolean {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE users SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END WHERE id = ?`).run(status, status, now, userId).changes > 0;
  }

  listApplications(status: UserStatus = "pending"): UserInfo[] {
    return (this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE status = ? AND application_json IS NOT NULL ORDER BY applied_at`).all(status) as UserRow[]).map(rowToUser);
  }

  /** Most recent decided applications (approved / rejected / banned), newest first. */
  listDecided(limit = 50): UserInfo[] {
    return (this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE status != 'pending' AND application_json IS NOT NULL ORDER BY COALESCE(approved_at, applied_at) DESC LIMIT ?`).all(limit) as UserRow[]).map(rowToUser);
  }

  /** Find or create the user for a GitHub account. Email is optional (GitHub may hide it). */
  upsertGithubUser(gh: { id: string; login: string; email: string | null }): string {
    const existing = this.db.prepare(`SELECT id, status FROM users WHERE github_id = ?`).get(gh.id) as { id: string; status: UserStatus } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.db.prepare(`UPDATE users SET github_login = ?, email = COALESCE(?, email) WHERE id = ?`).run(gh.login, gh.email, existing.id);
      if (existing.status === "pending" && this.autoApproved(gh.login)) this.setStatus(existing.id, "approved");
      return existing.id;
    }
    // A user created by email (CLI / admin) with the same verified address: attach the GitHub identity to it.
    const byEmail = gh.email ? (this.db.prepare(`SELECT id, status FROM users WHERE email = ? AND github_id IS NULL`).get(gh.email) as { id: string; status: UserStatus } | undefined) : undefined;
    if (byEmail) {
      this.db.prepare(`UPDATE users SET github_id = ?, github_login = ? WHERE id = ?`).run(gh.id, gh.login, byEmail.id);
      if (byEmail.status === "pending" && this.autoApproved(gh.login)) this.setStatus(byEmail.id, "approved");
      return byEmail.id;
    }
    const uid = newId("usr");
    // An email may already belong to a CLI-created user; keep the email unique by falling back to null.
    const emailTaken = gh.email ? this.db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(gh.email) : undefined;
    const auto = this.autoApproved(gh.login);
    this.db
      .prepare(`INSERT INTO users (id, email, github_id, github_login, status, approved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(uid, emailTaken ? null : gh.email, gh.id, gh.login, auto ? "approved" : "pending", auto ? now : null, now);
    return uid;
  }

  getUser(id: string): UserInfo | null {
    const r = this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return r ? rowToUser(r) : null;
  }

  /** Create a key for a user (by email; CLI use). Returns the plaintext key exactly once. */
  createKey(email: string, label?: string): { key: string; userId: string; keyId: string } {
    return this.createKeyForUser(this.ensureUser(email), label);
  }

  createKeyForUser(userId: string, label?: string): { key: string; userId: string; keyId: string } {
    const u = this.getUser(userId);
    if (!u) throw new Error(`no user ${userId}`);
    if (u.status !== "approved") throw new Error(`user ${userId} is ${u.status}; only approved users get keys`);
    const key = `kc_${randomBytes(24).toString("base64url")}`;
    const keyId = newId("key");
    this.db
      .prepare(`INSERT INTO api_keys (id, user_id, hash, label, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(keyId, userId, hashKey(key), label?.trim().slice(0, 60) || null, new Date().toISOString());
    return { key, userId, keyId };
  }

  /** Revoke a key; when userId is given the key must belong to that user. */
  revokeKey(keyId: string, userId?: string): boolean {
    const r = userId
      ? this.db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), keyId, userId)
      : this.db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), keyId);
    return r.changes > 0;
  }

  revokeAllKeys(userId: string): number {
    return this.db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), userId).changes;
  }

  findUser(loginOrId: string): UserInfo | null {
    const r = this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ? OR github_login = ? OR email = ?`).get(loginOrId, loginOrId, loginOrId) as UserRow | undefined;
    return r ? rowToUser(r) : null;
  }

  listUsers(): UserInfo[] {
    return (this.db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY created_at`).all() as UserRow[]).map(rowToUser);
  }

  listKeys(userId?: string): Array<ApiKeyInfo & { email: string | null; createdAt: string; revokedAt: string | null }> {
    const sql = `SELECT k.id, k.user_id, k.label, k.created_at, k.revoked_at, u.email FROM api_keys k JOIN users u ON u.id = k.user_id ${userId ? "WHERE k.user_id = ?" : ""} ORDER BY k.created_at`;
    const rows = (userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()) as Array<{
      id: string;
      user_id: string;
      label: string | null;
      created_at: string;
      revoked_at: string | null;
      email: string | null;
    }>;
    return rows.map((r) => ({ id: r.id, userId: r.user_id, label: r.label, email: r.email, createdAt: r.created_at, revokedAt: r.revoked_at }));
  }

  /** Resolve a bearer token to a key. Null if unknown, revoked, or the user is no longer approved. */
  resolve(token: string): ApiKeyInfo | null {
    const row = this.db
      .prepare(`SELECT k.id, k.user_id, k.label FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.hash = ? AND k.revoked_at IS NULL AND u.status = 'approved'`)
      .get(hashKey(token)) as { id: string; user_id: string; label: string | null } | undefined;
    return row ? { id: row.id, userId: row.user_id, label: row.label } : null;
  }
}

// ---------- signed tokens (OAuth state, browser sessions) ----------

/** HMAC-signed, expiring tokens: `<payload>.<exp>.<sig>`. Used for the OAuth state and the dashboard cookie. */
export class TokenSigner {
  constructor(private readonly secret: string) {
    if (!secret || secret.length < 16) throw new Error("KONCORDIA_SECRET must be at least 16 characters");
  }

  sign(payload: string, ttlSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = `${Buffer.from(payload).toString("base64url")}.${exp}`;
    return `${body}.${this.mac(body)}`;
  }

  verify(token: string | undefined | null): string | null {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [p, exp, sig] = parts;
    const expected = this.mac(`${p}.${exp}`);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
    return Buffer.from(p, "base64url").toString();
  }

  private mac(s: string): string {
    return createHmac("sha256", this.secret).update(s).digest("base64url");
  }
}

// ---------- GitHub OAuth (web application flow) ----------

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Absolute callback URL registered in the GitHub OAuth App. */
  callbackUrl: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export interface GithubUser {
  id: string;
  login: string;
  email: string | null;
}

export function githubAuthorizeUrl(cfg: GithubOAuthConfig, state: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.callbackUrl);
  u.searchParams.set("scope", "read:user user:email");
  u.searchParams.set("state", state);
  return u.toString();
}

/** Exchange the code for a token and fetch the user's id, login and primary verified email. */
export async function githubExchange(cfg: GithubOAuthConfig, code: string): Promise<GithubUser> {
  const f = cfg.fetchImpl ?? fetch;
  const tokenRes = await f("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.callbackUrl }),
  });
  const tok = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tok.access_token) throw new Error(`github token exchange failed: ${tok.error_description ?? tok.error ?? tokenRes.status}`);
  const h = { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "koncordia" };
  const userRes = await f("https://api.github.com/user", { headers: h });
  if (!userRes.ok) throw new Error(`github /user failed: ${userRes.status}`);
  const user = (await userRes.json()) as { id: number; login: string; email: string | null };
  let email = user.email ?? null;
  if (!email) {
    const emailsRes = await f("https://api.github.com/user/emails", { headers: h });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
    }
  }
  return { id: String(user.id), login: user.login, email };
}
