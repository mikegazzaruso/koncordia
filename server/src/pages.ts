/**
 * Server-rendered HTML for the few pages the API host serves: key issuance, the
 * minimal dashboard, and public guide pages. No client JS beyond a copy button.
 */
import { renderEntries, type Entry } from "./format.js";
import type { Guide, Quotas, Revision, RevisionState, Room } from "./store.js";
import type { Application, UserInfo } from "./auth.js";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const CSS = `
:root{--bg:#0b0d10;--panel:#12151a;--line:#1f242c;--text:#e6e8eb;--muted:#8b949e;--accent:#f5c542;--accent2:#5ad1ff;--ok:#5fd18a;--bad:#ff6b6b;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
@media (prefers-color-scheme: light){:root{--bg:#fafaf7;--panel:#fff;--line:#e6e4dc;--text:#14171c;--muted:#5f6670;--accent:#b8860b;--accent2:#0b7fc2}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 var(--sans)}
a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:32px 16px 64px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0 24px;border-bottom:1px solid var(--line);margin-bottom:28px}
.brand{font-weight:700;letter-spacing:.02em;color:var(--text);font-size:18px}.brand span{color:var(--accent)}
nav a{margin-left:18px;color:var(--muted)}nav a:hover{color:var(--text)}
h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 10px}p{margin:8px 0}.muted{color:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:16px 0}
pre,code{font-family:var(--mono);font-size:13.5px}
pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:10px 0}
code.inline{background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.key{font-family:var(--mono);font-size:15px;background:#000;color:var(--accent);border:1px dashed var(--accent);border-radius:8px;padding:14px 16px;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:14.5px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.btn{display:inline-block;background:var(--accent);color:#111;font-weight:600;border:0;border-radius:8px;padding:9px 14px;cursor:pointer;font-size:14px}.btn:hover{filter:brightness(1.05);text-decoration:none}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}.btn.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}
form.inline{display:inline}input[type=text]{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:14px;min-width:220px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12.5px;color:var(--muted)}.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.warn{color:var(--accent);border-color:var(--accent)}
.transcript{font-family:var(--mono);font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.transcript .lbl{color:var(--accent2);font-weight:700}.transcript .sys{color:var(--muted)}.transcript .cont{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13.5px}
`;

export function layout(opts: { title: string; body: string; siteUrl: string; description?: string; nav?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>${opts.description ? `<meta name="description" content="${esc(opts.description)}">` : ""}
<meta name="color-scheme" content="dark light"><style>${CSS}</style></head>
<body><div class="wrap">
<header class="top"><a class="brand" href="${esc(opts.siteUrl)}">Koncordia<span>.</span></a><nav>${opts.nav ?? `<a href="${esc(opts.siteUrl)}/#how">How it works</a><a href="/g">Public guides</a><a href="/dashboard">Dashboard</a>`}</nav></header>
${opts.body}
<footer>Koncordia · agents debate, you get the agreed artifact · <a href="${esc(opts.siteUrl)}/privacy">Privacy</a> · <a href="${esc(opts.siteUrl)}/terms">Terms</a></footer>
</div></body></html>`;
}

export function messagePage(siteUrl: string, title: string, text: string, extra = ""): string {
  return layout({ title: `${title} · Koncordia`, siteUrl, body: `<h1>${esc(title)}</h1><p class="muted">${esc(text)}</p>${extra}` });
}

export function loginPage(siteUrl: string): string {
  return layout({
    title: "Sign in · Koncordia",
    siteUrl,
    body: `<h1>Sign in</h1><p class="muted">Hosted Koncordia is in early access: sign in with GitHub, tell us who you are and what you want to build, and we grant access by hand.</p>
<p><a class="btn" href="/auth/github">Continue with GitHub</a></p>
<p class="muted" style="font-size:13.5px">We store your GitHub id, login and primary email to identify your account. Nothing else. See <a href="${esc(siteUrl)}/privacy">Privacy</a>.</p>`,
  });
}

export function applyPage(o: { siteUrl: string; user: UserInfo; csrf: string; error?: string; values?: Partial<Application> }): string {
  const v = o.values ?? {};
  const field = (name: keyof Application, label: string, hint: string, textarea = false) => `
<label style="display:block;margin:14px 0 4px;font-weight:600">${esc(label)}</label>
<div class="muted" style="font-size:13px;margin-bottom:6px">${esc(hint)}</div>
${textarea ? `<textarea name="${name}" rows="5" maxlength="2000" required style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 12px;font:inherit;font-size:14px">${esc(v[name] ?? "")}</textarea>` : `<input type="text" name="${name}" maxlength="200" ${name === "link" ? "" : "required"} value="${esc(v[name] ?? "")}" style="width:100%">`}`;
  return layout({
    title: "Apply for early access · Koncordia",
    siteUrl: o.siteUrl,
    nav: `<a href="${esc(o.siteUrl)}/#how">How it works</a><a href="/g">Public guides</a>`,
    body: `<h1>Apply for early access</h1>
<p class="muted">Signed in as <strong>${esc(o.user.githubLogin ?? o.user.id)}</strong>. Hosted Koncordia is free during early access, and every account is approved by a person. Tell us a little about you; five lines are enough.</p>
${o.error ? `<div class="panel" style="border-color:var(--bad);color:var(--bad)">${esc(o.error)}</div>` : ""}
<form method="post" action="/apply" class="panel">
<input type="hidden" name="csrf" value="${esc(o.csrf)}">
${field("name", "Who are you?", "Your name, or how you want to be addressed.")}
${field("organization", "Where do you work, or what do you build?", "Company, team, open-source project, solo. Role if it matters.")}
${field("useCase", "What do you want to use Koncordia for?", "The concrete thing: which artifacts, which repo or team, what problem it solves for you.", true)}
${field("agents", "Which agents will you connect?", "Claude Code, Codex, Cursor, something else.")}
${field("link", "A link that tells us more (optional)", "GitHub profile, website, LinkedIn, the project.")}
<p style="margin-top:18px"><button class="btn">Send application</button></p>
</form>
<p class="muted" style="font-size:13.5px">We read every application. Once approved, sign in again and your API key is waiting. We only use these answers to decide on access; see <a href="${esc(o.siteUrl)}/privacy">Privacy</a>.</p>`,
  });
}

export function pendingPage(o: { siteUrl: string; user: UserInfo; csrf: string }): string {
  const a = o.user.application;
  const rejected = o.user.status === "rejected";
  return layout({
    title: (rejected ? "Not approved" : "Application received") + " · Koncordia",
    siteUrl: o.siteUrl,
    nav: `<a href="/g">Public guides</a><form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button class="btn ghost" style="padding:5px 10px">Sign out</button></form>`,
    body: rejected
      ? `<h1>Not approved this time</h1><p class="muted">We could not grant early access to <strong>${esc(o.user.githubLogin ?? o.user.id)}</strong> for now. You can still <a href="${esc(o.siteUrl)}/#install">self-host</a>, and write to <a href="mailto:hello@koncordia.dev">hello@koncordia.dev</a> if you think we got it wrong.</p>`
      : `<h1>Application received</h1>
<p class="muted">Thanks, <strong>${esc(a?.name ?? o.user.githubLogin ?? "")}</strong>. Access is granted by hand during early access; you will hear from us${o.user.email ? ` at <strong>${esc(o.user.email)}</strong>` : ""}. Once approved, sign in again and your API key will be waiting here.</p>
<div class="panel"><table>
<tr><th>Applied</th><td>${esc(o.user.appliedAt?.slice(0, 10) ?? "")}</td></tr>
<tr><th>Organization</th><td>${esc(a?.organization ?? "")}</td></tr>
<tr><th>Use case</th><td>${esc(a?.useCase ?? "")}</td></tr>
<tr><th>Agents</th><td>${esc(a?.agents ?? "")}</td></tr>
${a?.link ? `<tr><th>Link</th><td>${esc(a.link)}</td></tr>` : ""}
</table></div>
<p class="muted">Meanwhile the server is open source: <a href="${esc(o.siteUrl)}/#install">run it yourself</a> with no limits.</p>`,
  });
}

export function adminLoginPage(siteUrl: string, error?: string): string {
  return layout({
    title: "Admin sign-in · Koncordia",
    siteUrl,
    nav: `<a href="${esc(siteUrl)}/">Site</a>`,
    body: `<h1>Admin</h1><p class="muted">Sign in with your admin email and password.</p>
${error ? `<div class="panel" style="border-color:var(--bad);color:var(--bad)">${esc(error)}</div>` : ""}
<form method="post" action="/admin/login" class="panel" style="max-width:420px">
<label style="display:block;margin:6px 0 4px;font-weight:600">Email</label><input type="text" name="email" autocomplete="username" required style="width:100%">
<label style="display:block;margin:14px 0 4px;font-weight:600">Password</label><input type="password" name="password" autocomplete="current-password" required style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:14px">
<p style="margin-top:18px"><button class="btn">Sign in</button></p>
</form>`,
  });
}

export function adminPage(o: { siteUrl: string; admin: UserInfo; pending: UserInfo[]; decided: UserInfo[]; csrf: string; notice?: string }): string {
  const app = (u: UserInfo) => {
    const a = u.application!;
    return `<div class="panel">
<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline">
<div><strong>${esc(a.name)}</strong> <span class="muted">·</span> <a href="https://github.com/${esc(u.githubLogin ?? "")}">${esc(u.githubLogin ?? u.id)}</a>${u.email ? ` <span class="muted">· ${esc(u.email)}</span>` : ""}</div>
<div class="muted" style="font-size:13px">applied ${esc(u.appliedAt?.slice(0, 16).replace("T", " ") ?? "")}</div></div>
<table style="margin-top:10px">
<tr><th style="width:130px">Organization</th><td>${esc(a.organization)}</td></tr>
<tr><th>Use case</th><td style="white-space:pre-wrap">${esc(a.useCase)}</td></tr>
<tr><th>Agents</th><td>${esc(a.agents)}</td></tr>
${a.link ? `<tr><th>Link</th><td><a href="${esc(a.link)}" rel="nofollow noopener">${esc(a.link)}</a></td></tr>` : ""}
</table>
<form method="post" action="/admin/users" style="margin-top:12px;display:flex;gap:8px">
<input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="userId" value="${esc(u.id)}">
<button class="btn" name="action" value="approve">Approve</button>
<button class="btn danger" name="action" value="reject">Reject</button>
</form></div>`;
  };
  return layout({
    title: "Applications · Koncordia admin",
    siteUrl: o.siteUrl,
    nav: `<a href="/g">Public guides</a><form class="inline" method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button class="btn ghost" style="padding:5px 10px">Sign out</button></form>`,
    body: `<h1>Early-access applications</h1><p class="muted">Signed in as ${esc(o.admin.email ?? o.admin.id)} (admin).</p>
${o.notice ? `<div class="panel" style="border-color:var(--ok)">${esc(o.notice)}</div>` : ""}
<h2>Pending (${o.pending.length})</h2>
${o.pending.map(app).join("\n") || `<p class="muted">Nothing waiting.</p>`}
<h2>Decided</h2>
<div class="panel"><table><tr><th>User</th><th>Organization</th><th>Status</th><th>When</th><th></th></tr>
${o.decided
  .map(
    (u) => `<tr><td><a href="https://github.com/${esc(u.githubLogin ?? "")}">${esc(u.githubLogin ?? u.id)}</a><br><span class="muted" style="font-size:12.5px">${esc(u.application?.name ?? "")}</span></td><td>${esc(u.application?.organization ?? "")}</td><td><span class="pill${u.status === "approved" ? " ok" : ""}">${esc(u.status)}</span></td><td class="muted">${esc((u.approvedAt ?? u.appliedAt ?? "").slice(0, 10))}</td>
<td><form method="post" action="/admin/users" class="inline"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="userId" value="${esc(u.id)}">${u.status === "approved" ? `<button class="btn danger" style="padding:4px 10px" name="action" value="reject">Revoke</button>` : `<button class="btn ghost" style="padding:4px 10px" name="action" value="approve">Approve</button>`}</form></td></tr>`,
  )
  .join("\n") || `<tr><td colspan="5" class="muted">No decisions yet.</td></tr>`}
</table></div>`,
  });
}

export function connectSnippets(publicUrl: string, key: string): string {
  const mcp = `${publicUrl}/mcp`;
  return `<h2>Connect your agents</h2>
<p class="muted">Claude Code:</p>
<pre>claude mcp add --transport http koncordia ${esc(mcp)} --header "Authorization: Bearer ${esc(key)}"</pre>
<p class="muted">Codex:</p>
<pre>export KONCORDIA_API_KEY=${esc(key)}
codex mcp add koncordia --url ${esc(mcp)} --bearer-token-env-var KONCORDIA_API_KEY</pre>
<p class="muted">Local driver (runs both CLIs until they agree):</p>
<pre>export KONCORDIA_URL=${esc(mcp)} KONCORDIA_API_KEY=${esc(key)}
koncordia debate --topic "TypeScript styleguide for this repo" --kind styleguide \\
  --seat claude=claude --seat codex=codex</pre>`;
}

export function keyPage(o: { siteUrl: string; publicUrl: string; key: string; keyId: string; label: string | null; first: boolean }): string {
  return layout({
    title: "Your API key · Koncordia",
    siteUrl: o.siteUrl,
    body: `<h1>${o.first ? "Welcome. Here is your API key." : "New API key"}</h1>
<p class="muted">Shown once. Store it now; we only keep a hash. Key id <code class="inline">${esc(o.keyId)}</code>${o.label ? ` · label <code class="inline">${esc(o.label)}</code>` : ""}.</p>
<div class="key" id="k">${esc(o.key)}</div>
<p><button class="btn ghost" onclick="navigator.clipboard.writeText(document.getElementById('k').textContent).then(()=>{this.textContent='Copied'})">Copy key</button> <a class="btn ghost" href="/dashboard">Go to dashboard</a></p>
${connectSnippets(o.publicUrl, o.key)}`,
  });
}

export function dashboardPage(o: {
  siteUrl: string;
  publicUrl: string;
  user: UserInfo;
  keys: Array<{ id: string; label: string | null; createdAt: string; revokedAt: string | null }>;
  rooms: Room[];
  guides: Guide[];
  usage: { month: string; roomsCreated: number; entriesPosted: number };
  quotas: Quotas | null;
  csrf: string;
}): string {
  const active = o.keys.filter((k) => !k.revokedAt);
  const openRooms = o.rooms.filter((r) => r.state === "open").length;
  const q = o.quotas;
  const stat = (label: string, value: string) => `<div class="panel" style="margin:0"><div class="muted" style="font-size:13px">${esc(label)}</div><div style="font-size:22px;font-weight:700">${value}</div></div>`;
  return layout({
    title: "Dashboard · Koncordia",
    siteUrl: o.siteUrl,
    nav: `<a href="/g">Public guides</a><form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button class="btn ghost" style="padding:5px 10px">Sign out</button></form>`,
    body: `<h1>Dashboard</h1><p class="muted">Signed in as <strong>${esc(o.user.githubLogin ?? o.user.email ?? o.user.id)}</strong> · <span class="pill warn">early access · free</span></p>
<div class="grid">
${stat("Open rooms", `${openRooms}${q ? ` <span class="muted" style="font-size:14px">/ ${q.activeRooms}</span>` : ""}`)}
${stat(`Rooms created in ${esc(o.usage.month)}`, `${o.usage.roomsCreated}${q ? ` <span class="muted" style="font-size:14px">/ ${q.roomsPerMonth}</span>` : ""}`)}
${stat("Guides", String(o.guides.length))}
${stat("Transcript retention", q ? `${q.retentionDays} days` : "unlimited")}
</div>

<h2>API keys</h2>
<div class="panel">
<table><tr><th>Key id</th><th>Label</th><th>Created</th><th>Status</th><th></th></tr>
${o.keys
  .map(
    (k) => `<tr><td><code>${esc(k.id)}</code></td><td>${esc(k.label ?? "")}</td><td class="muted">${esc(k.createdAt.slice(0, 10))}</td><td>${k.revokedAt ? `<span class="pill">revoked</span>` : `<span class="pill ok">active</span>`}</td>
<td>${k.revokedAt ? "" : `<form class="inline" method="post" action="/dashboard/keys"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="action" value="revoke"><input type="hidden" name="keyId" value="${esc(k.id)}"><button class="btn danger" style="padding:4px 10px">Revoke</button></form>`}</td></tr>`,
  )
  .join("\n") || `<tr><td colspan="5" class="muted">No keys yet.</td></tr>`}
</table>
<form method="post" action="/dashboard/keys" style="margin-top:14px"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="action" value="create"><input type="text" name="label" placeholder="label (e.g. laptop, ci)" maxlength="60"> <button class="btn">Create key</button></form>
${active.length ? `<p class="muted" style="font-size:13px;margin-top:12px">Connect: <code class="inline">claude mcp add --transport http koncordia ${esc(o.publicUrl)}/mcp --header "Authorization: Bearer &lt;key&gt;"</code></p>` : ""}
</div>

<h2>Rooms</h2>
<div class="panel"><table><tr><th>Room</th><th>Topic</th><th>State</th><th>Round</th><th>Guide</th><th>Created</th></tr>
${o.rooms
  .slice(0, 50)
  .map(
    (r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.topic.slice(0, 80))}</td><td><span class="pill${r.state === "agreed" ? " ok" : r.state === "open" ? " warn" : ""}">${esc(r.state)}</span></td><td class="muted">${r.round}/${r.maxRounds}</td><td><a href="/g/${esc(r.guideSlug)}">${esc(r.guideSlug)}</a></td><td class="muted">${esc(r.createdAt.slice(0, 10))}</td></tr>`,
  )
  .join("\n") || `<tr><td colspan="6" class="muted">No rooms yet. Create one from your agent with <code>room.create</code>.</td></tr>`}
</table></div>

<h2>Guides</h2>
<div class="panel"><table><tr><th>Slug</th><th>Kind</th><th>Title</th><th>Visibility</th></tr>
${o.guides
  .map((g) => `<tr><td><a href="/g/${esc(g.slug)}">${esc(g.slug)}</a></td><td>${esc(g.kind)}</td><td>${esc(g.title)}</td><td><span class="pill">${esc(g.visibility)}</span></td></tr>`)
  .join("\n") || `<tr><td colspan="4" class="muted">No guides yet.</td></tr>`}
</table></div>`,
  });
}

function renderTranscriptHtml(entries: Entry[]): string {
  return renderEntries(entries)
    .split("\n")
    .map((line) => {
      if (line.startsWith("  ")) return `  ${esc(line.slice(2))}`;
      if (/^#\d+ /.test(line)) return `<span class="lbl${/^#\d+ system$/.test(line) ? " sys" : ""}">${esc(line)}</span>`;
      return esc(line);
    })
    .join("\n");
}

export function guidePage(o: {
  siteUrl: string;
  publicUrl: string;
  guide: Guide;
  revision: Revision;
  agreedBy: string[];
  room: Room | null;
  transcript: Entry[];
  history: Array<{ version: number; state: RevisionState; proposedBy: string; ts: string }>;
}): string {
  const uri = `koncordia://guides/${o.guide.slug}/latest`;
  return layout({
    title: `${o.guide.title} · Koncordia`,
    siteUrl: o.siteUrl,
    description: `${o.guide.kind} agreed by ${o.agreedBy.join(" and ")} on Koncordia.`,
    body: `<p class="muted"><a href="/g">Public guides</a> / ${esc(o.guide.kind)}</p>
<h1>${esc(o.guide.title)}</h1>
<p class="muted">v${o.revision.version} · <span class="pill ok">agreed</span> by <strong>${esc(o.agreedBy.join(", "))}</strong> · ${esc(o.revision.ts.slice(0, 10))}${o.room ? ` · ${o.room.round} round(s)` : ""} · <a href="/g/${esc(o.guide.slug)}/raw">raw markdown</a></p>
<div class="panel"><p class="muted" style="margin:0 0 6px;font-size:13px">Adopt it in your agent (read-only, no key needed for public guides):</p>
<pre>claude mcp add --transport http koncordia ${esc(o.publicUrl)}/mcp
# then read the resource ${esc(uri)}</pre></div>
<pre style="font-size:14px">${esc(o.revision.content)}</pre>
<h2>How it was agreed</h2>
${o.transcript.length ? `<div class="panel"><div class="transcript">${renderTranscriptHtml(o.transcript)}</div></div>` : `<p class="muted">Transcript no longer available (retention window passed).</p>`}
<h2>Revisions</h2>
<div class="panel"><table><tr><th>Version</th><th>State</th><th>Proposed by</th><th>Date</th></tr>
${o.history.map((h) => `<tr><td><a href="/g/${esc(o.guide.slug)}/v/${h.version}">v${h.version}</a></td><td><span class="pill${h.state === "agreed" ? " ok" : ""}">${esc(h.state)}</span></td><td>${esc(h.proposedBy)}</td><td class="muted">${esc(h.ts.slice(0, 10))}</td></tr>`).join("\n")}
</table></div>`,
  });
}

export function guidesIndexPage(siteUrl: string, guides: Array<Guide & { version: number; agreedAt: string }>): string {
  return layout({
    title: "Public guides · Koncordia",
    siteUrl,
    description: "Styleguides, decisions, rules and specs agreed by AI agents on Koncordia.",
    body: `<h1>Public guides</h1><p class="muted">Artifacts two or more agents agreed on. Every one of them was negotiated, not generated.</p>
<div class="panel"><table><tr><th>Guide</th><th>Kind</th><th>Version</th><th>Agreed</th></tr>
${guides.map((g) => `<tr><td><a href="/g/${esc(g.slug)}">${esc(g.title)}</a><br><span class="muted" style="font-size:12.5px">${esc(g.slug)}</span></td><td>${esc(g.kind)}</td><td>v${g.version}</td><td class="muted">${esc(g.agreedAt.slice(0, 10))}</td></tr>`).join("\n") || `<tr><td colspan="4" class="muted">Nothing public yet.</td></tr>`}
</table></div>`,
  });
}
