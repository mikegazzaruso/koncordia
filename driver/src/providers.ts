import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface McpTarget {
  url: string;
  key?: string;
}

export interface RunOptions {
  prompt: string;
  /** Provider-specific session id from a previous turn of the same seat, to keep context. */
  sessionId?: string;
  model?: string;
  mcp: McpTarget;
  cwd: string;
  /** Called with stderr chunks for live diagnostics. */
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  text: string;
  sessionId?: string;
}

export interface Provider {
  readonly name: string;
  run(opts: RunOptions): Promise<RunResult>;
}

export const KONCORDIA_TOOLS = [
  "room_read",
  "room_post",
  "room_status",
  "room_transcript",
  "guide_propose",
  "guide_vote",
  "guide_get",
  "guide_history",
];

function exec(bin: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; onStderr?: (s: string) => void }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onStderr?.(s);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/**
 * Claude Code: `claude -p` with the koncordia server injected via --mcp-config and only its tools allowed.
 * First turn sets --session-id, later turns --resume it, so the seat keeps its context.
 */
export function claudeProvider(bin = "claude"): Provider {
  return {
    name: "claude",
    async run(o) {
      const server: Record<string, unknown> = { type: "http", url: o.mcp.url };
      if (o.mcp.key) server.headers = { Authorization: `Bearer ${o.mcp.key}` };
      const mcpConfig = JSON.stringify({ mcpServers: { koncordia: server } });
      const sessionId = o.sessionId ?? randomUUID();
      const args = [
        "-p",
        "--output-format",
        "json",
        "--mcp-config",
        mcpConfig,
        "--strict-mcp-config",
        "--allowedTools",
        ...KONCORDIA_TOOLS.map((t) => `mcp__koncordia__${t}`),
        "--disallowedTools",
        "Bash",
        "Edit",
        "Write",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "Agent",
        o.sessionId ? "--resume" : "--session-id",
        sessionId,
      ];
      if (o.model) args.push("--model", o.model);
      const r = await exec(bin, args, { cwd: o.cwd, stdin: o.prompt, onStderr: o.onStderr });
      let parsed: { result?: string; session_id?: string; is_error?: boolean; subtype?: string } | undefined;
      try {
        parsed = JSON.parse(r.stdout.trim());
      } catch {
        // fall through
      }
      if (r.code !== 0 && !parsed) throw new Error(`claude exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
      if (!parsed) throw new Error(`claude: unparsable output: ${r.stdout.slice(0, 500)}`);
      if (parsed.is_error) throw new Error(`claude: ${parsed.subtype ?? "error"}: ${parsed.result ?? ""}`);
      return { text: parsed.result ?? "", sessionId: parsed.session_id ?? sessionId };
    },
  };
}

/**
 * Codex CLI: `codex exec --json` with the koncordia server passed as config overrides.
 * The thread id from the first turn is reused with `codex exec resume <id>`.
 */
export function codexProvider(bin = "codex"): Provider {
  return {
    name: "codex",
    async run(o) {
      // default_tools_approval_mode=approve: in non-interactive exec nobody can answer an approval prompt.
      const overrides = ["-c", `mcp_servers.koncordia.url="${o.mcp.url}"`, "-c", `mcp_servers.koncordia.default_tools_approval_mode="approve"`];
      const env: NodeJS.ProcessEnv = {};
      if (o.mcp.key) {
        overrides.push("-c", `mcp_servers.koncordia.bearer_token_env_var="KONCORDIA_API_KEY"`);
        env.KONCORDIA_API_KEY = o.mcp.key;
      }
      // sandbox via -c: `codex exec resume` does not accept the -s flag.
      const common = ["--json", "--skip-git-repo-check", "-c", `sandbox_mode="read-only"`, ...overrides];
      if (o.model) common.push("-m", o.model);
      const args = o.sessionId ? ["exec", "resume", o.sessionId, ...common, "-"] : ["exec", ...common, "-"];
      const r = await exec(bin, args, { cwd: o.cwd, env, stdin: o.prompt, onStderr: o.onStderr });
      let threadId: string | undefined;
      let text = "";
      let error: string | undefined;
      for (const line of r.stdout.split("\n")) {
        const l = line.trim();
        if (!l.startsWith("{")) continue;
        try {
          const ev = JSON.parse(l) as { type?: string; thread_id?: string; item?: { type?: string; text?: string }; message?: string; error?: { message?: string } };
          if (ev.type === "thread.started" && ev.thread_id) threadId = ev.thread_id;
          if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) text = ev.item.text;
          if (ev.type === "error" || ev.type === "turn.failed") error = ev.message ?? ev.error?.message ?? l;
        } catch {
          // ignore non-JSON lines
        }
      }
      if (r.code !== 0 && !text) throw new Error(`codex exited ${r.code}: ${error ?? r.stderr.trim().slice(-800)}`);
      if (error && !text) throw new Error(`codex: ${error}`);
      return { text, sessionId: threadId ?? o.sessionId };
    },
  };
}

export function providerByName(name: string, bins: { claude?: string; codex?: string } = {}): Provider {
  switch (name) {
    case "claude":
      return claudeProvider(bins.claude);
    case "codex":
      return codexProvider(bins.codex);
    default:
      throw new Error(`unknown provider "${name}" (known: claude, codex)`);
  }
}
