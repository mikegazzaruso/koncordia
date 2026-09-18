#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Auth, LOCAL_USER_ID } from "./auth.js";
import { openDb } from "./db.js";
import { createHttpServer } from "./http.js";
import { createMcpServer } from "./mcp.js";
import { EARLY_ACCESS_QUOTAS, Store } from "./store.js";

const USAGE = `koncordia-server — MCP server for multi-agent consensus

Usage:
  koncordia-server http  [--port 8787] [--host 127.0.0.1] [--db koncordia.db] [--no-auth] [--allowed-host api.koncordia.dev]
  koncordia-server stdio [--db koncordia.db]
  koncordia-server keys create <email> [--label name] [--db koncordia.db]
  koncordia-server keys list   [--db koncordia.db]
  koncordia-server keys revoke <keyId> [--db koncordia.db]
  koncordia-server admin users | waitlist | ban <login|userId> | hide <guideSlug> | unhide <guideSlug>
  koncordia-server admin applications | approve <login|userId> | reject <login|userId>
  koncordia-server admin create <email>            # approved user (no key)
  koncordia-server admin set-password <email>      # reads the password from stdin
  koncordia-server admin role <email> admin|user

Env: KONCORDIA_DB, KONCORDIA_PORT, KONCORDIA_HOST, KONCORDIA_NO_AUTH=1, KONCORDIA_ALLOWED_HOSTS (comma-separated)
     KONCORDIA_PUBLIC_URL (https://api.koncordia.dev), KONCORDIA_SITE_URL (https://koncordia.dev)
     KONCORDIA_SECRET (>= 16 chars; sessions + OAuth state), GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
     KONCORDIA_QUOTAS=0 to disable early-access quotas and retention (default: on when auth is on)
     KONCORDIA_ADMIN_LOGINS=comma-separated GitHub logins approved automatically (the owner)
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      db: { type: "string" },
      label: { type: "string" },
      "no-auth": { type: "boolean" },
      "allowed-host": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0] ?? "http";
  if (values.help) return out(USAGE);

  const dbPath = values.db ?? process.env.KONCORDIA_DB ?? "koncordia.db";
  const db = openDb(dbPath);
  const noAuth = values["no-auth"] ?? process.env.KONCORDIA_NO_AUTH === "1";
  const quotasOn = cmd === "http" && !noAuth && process.env.KONCORDIA_QUOTAS !== "0";
  const store = new Store(db, { quotas: quotasOn ? EARLY_ACCESS_QUOTAS : null });
  const auth = new Auth(db, { autoApproveLogins: process.env.KONCORDIA_ADMIN_LOGINS?.split(",").map((s) => s.trim()).filter(Boolean) });
  auth.ensureUser(null, LOCAL_USER_ID);

  switch (cmd) {
    case "stdio": {
      const server = createMcpServer(store, LOCAL_USER_ID);
      await server.connect(new StdioServerTransport());
      return;
    }
    case "http": {
      const port = Number(values.port ?? process.env.KONCORDIA_PORT ?? 8787);
      const host = values.host ?? process.env.KONCORDIA_HOST ?? "127.0.0.1";
      const allowedHosts = values["allowed-host"] ?? process.env.KONCORDIA_ALLOWED_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean);
      const github =
        process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
          ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET }
          : undefined;
      const srv = createHttpServer({
        store,
        auth,
        noAuth,
        allowedHosts,
        publicUrl: process.env.KONCORDIA_PUBLIC_URL ?? `http://${host}:${port}`,
        siteUrl: process.env.KONCORDIA_SITE_URL,
        secret: process.env.KONCORDIA_SECRET,
        github,
        log: (m) => console.error(m),
      });
      srv.listen(port, host, () => {
        console.error(
          `koncordia listening on http://${host}:${port}/mcp (db: ${dbPath}, auth: ${noAuth ? "OFF" : "bearer"}, github: ${github ? "on" : "off"}, quotas: ${quotasOn ? "early-access" : "off"})`,
        );
      });
      if (quotasOn) {
        const sweep = () => {
          const n = store.archiveOldRooms(EARLY_ACCESS_QUOTAS.retentionDays);
          if (n) console.error(`retention: archived ${n} room(s)`);
        };
        sweep();
        setInterval(sweep, 6 * 3600 * 1000).unref();
      }
      const stop = () => srv.close(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "admin": {
      const sub = positionals[1];
      if (sub === "users") {
        for (const u of auth.listUsers()) out(`${u.id}\t${u.status}\t${u.githubLogin ?? "-"}\t${u.email ?? "-"}\t${u.createdAt}`);
        return;
      }
      if (sub === "applications") {
        const apps = auth.listApplications("pending");
        if (!apps.length) return out("no pending applications");
        for (const u of apps) {
          const a = u.application!;
          out(`--- ${u.githubLogin ?? u.id} (${u.id}) · ${u.email ?? "no email"} · applied ${u.appliedAt}`);
          out(`  name:  ${a.name}`);
          out(`  org:   ${a.organization}`);
          out(`  use:   ${a.useCase.replace(/\n/g, "\n         ")}`);
          out(`  agents:${a.agents}`);
          if (a.link) out(`  link:  ${a.link}`);
        }
        return;
      }
      if (sub === "create") {
        const email = positionals[2]?.trim().toLowerCase();
        if (!email) return die("admin create needs <email>");
        return out(`user ${auth.ensureUser(email)} (${email}) approved`);
      }
      if (sub === "set-password") {
        const email = positionals[2]?.trim().toLowerCase();
        if (!email) return die("admin set-password needs <email>; password on stdin");
        const u = auth.findUser(email);
        if (!u) return die(`no user ${email}; run admin create first`);
        const pw = (await new Promise<string>((r) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => r(d)); })).replace(/\r?\n$/, "");
        auth.setPassword(u.id, pw);
        return out(`password set for ${email}`);
      }
      if (sub === "role") {
        const u = auth.findUser(positionals[2] ?? "");
        const role = positionals[3];
        if (!u || (role !== "admin" && role !== "user")) return die("admin role <email|login> admin|user");
        auth.setRole(u.id, role);
        return out(`${u.email ?? u.githubLogin ?? u.id} is now ${role}`);
      }
      if (sub === "approve" || sub === "reject") {
        const u = auth.findUser(positionals[2] ?? "");
        if (!u) return die(`no user "${positionals[2]}"`);
        auth.setStatus(u.id, sub === "approve" ? "approved" : "rejected");
        return out(`${sub === "approve" ? "approved" : "rejected"} ${u.id} (${u.githubLogin ?? u.email ?? "-"})`);
      }
      if (sub === "waitlist") {
        for (const w of store.listWaitlist()) out(`${w.ts}\t${w.tier}\t${w.email}`);
        return;
      }
      if (sub === "ban") {
        const u = auth.findUser(positionals[2] ?? "");
        if (!u) return die(`no user "${positionals[2]}"`);
        auth.setStatus(u.id, "banned");
        const keys = auth.revokeAllKeys(u.id);
        const r = store.banUser(u.id);
        return out(`banned ${u.id} (${u.githubLogin ?? u.email ?? "-"}): ${keys} key(s) revoked, ${r.rooms} room(s) stalled, ${r.guides} guide(s) hidden`);
      }
      if (sub === "hide" || sub === "unhide") {
        const slug = positionals[2];
        if (!slug) return die(`admin ${sub} needs <guideSlug>`);
        return out(store.setGuideVisibility(slug, sub === "hide" ? "private" : "public") ? `${sub}: ${slug}` : `no guide ${slug}`);
      }
      return die(USAGE);
    }
    case "keys": {
      const sub = positionals[1];
      if (sub === "create") {
        const email = positionals[2];
        if (!email) return die("keys create needs <email>");
        const k = auth.createKey(email, values.label);
        return out(`${k.key}\n(keyId ${k.keyId}, user ${k.userId}) — shown once, store it now.`);
      }
      if (sub === "list") {
        for (const k of auth.listKeys()) out(`${k.id}\t${k.email ?? "-"}\t${k.label ?? "-"}\t${k.revokedAt ? "revoked" : "active"}\t${k.createdAt}`);
        return;
      }
      if (sub === "revoke") {
        const id = positionals[2];
        if (!id) return die("keys revoke needs <keyId>");
        return out(auth.revokeKey(id) ? `revoked ${id}` : `no active key ${id}`);
      }
      return die(USAGE);
    }
    default:
      return die(USAGE);
  }
}

function out(s: string) {
  process.stdout.write(s + "\n");
}
function die(s: string): never {
  process.stderr.write(s + "\n");
  process.exit(1);
}

main().catch((e) => die(`fatal: ${(e as Error).stack ?? e}`));
