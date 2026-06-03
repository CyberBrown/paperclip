/**
 * Agent-management tools — gated to a single "manager" agent (the CEO) via
 * PI_ENABLE_AGENT_MGMT. They let the CEO browse a persona pool (mirrored into
 * Forgejo) and PROPOSE new teammates. Two hard safety properties:
 *
 *   1. The CEO picks a PERSONA only. This tool hardcodes the jailed config —
 *      pi_agent_core adapter + the same OpenBao/proxy/sandbox env (by secret
 *      reference) — so a proposed agent can never get a shell, live creds, or a
 *      different adapter. The model supplies name/role/persona; the tool supplies
 *      capabilities.
 *   2. Proposals are HUMAN-GATED: the company has requireBoardApprovalForNewAgents
 *      on, so propose_agent creates a *pending hire* a human approves in the UI.
 *
 * HTTP here uses node:http directly (NOT fetch) so it bypasses the global undici
 * ProxyAgent (which routes fetch through the DeepSeek-only proxy).
 */
import http from "node:http";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

function text(s: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: s }], details: null };
}

function httpJson(
  method: string,
  urlStr: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; json: any; raw: string }> {
  const url = new URL(urlStr);
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json: any = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            /* leave raw */
          }
          resolve({ status: res.statusCode ?? 0, json, raw: data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export interface AgentMgmtConfig {
  paperclipApi: string; // http://localhost:3100
  apiKey: string; // local agent JWT (bearer)
  companyId: string;
  forgejoApi: string; // http://10.10.10.1:3000/api/v1
  poolRepo: string; // paperclip-agent/agency-agents
  // secret reference UUIDs for the jailed env of proposed agents
  refVaultSecretId: string;
  refVaultSecretPath: string;
  refForgejoRemote: string;
  // plain env copied to proposed agents
  plainEnv: Record<string, string>;
}

export function agentMgmtConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentMgmtConfig | null {
  if (env.PI_ENABLE_AGENT_MGMT !== "true") return null;
  const apiKey = env.PAPERCLIP_API_KEY?.trim();
  const companyId = env.PI_COMPANY_ID?.trim();
  if (!apiKey || !companyId) return null;
  const pick = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : "");
  return {
    paperclipApi: (env.PI_PAPERCLIP_API_URL?.trim() || "http://localhost:3100").replace(/\/+$/, ""),
    apiKey,
    companyId,
    forgejoApi: (env.PI_FORGEJO_API?.trim() || "http://10.10.10.1:3000/api/v1").replace(/\/+$/, ""),
    poolRepo: env.PI_AGENT_POOL?.trim() || "paperclip-agent/agency-agents",
    refVaultSecretId: env.PI_REF_VAULT_SECRET_ID?.trim() || "",
    refVaultSecretPath: env.PI_REF_VAULT_SECRET_PATH?.trim() || "",
    refForgejoRemote: env.PI_REF_FORGEJO_REMOTE?.trim() || "",
    plainEnv: {
      VAULT_ADDR: pick("VAULT_ADDR"),
      VAULT_ROLE_ID: pick("VAULT_ROLE_ID"),
      VAULT_SECRET_PATH_RAW: "", // unused; path comes via secret ref
      VAULT_SKIP_VERIFY: pick("VAULT_SKIP_VERIFY") || "true",
      HTTPS_PROXY: pick("HTTPS_PROXY"),
      HTTP_PROXY: pick("HTTP_PROXY"),
      NO_PROXY: pick("NO_PROXY"),
      DEEPSEEK_MODEL: pick("DEEPSEEK_MODEL") || "deepseek-v4-pro",
    },
  };
}

function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

const VALID_ROLES = new Set([
  "ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general",
]);

export function makeAgentMgmtTools(cfg: AgentMgmtConfig): AgentTool<any>[] {
  const list: AgentTool<any> = {
    name: "list_agent_templates",
    label: "List agent personas",
    description:
      "List available agent personas from the team's persona pool. Optionally filter by category (e.g. 'engineering', 'design', 'product', 'finance').",
    parameters: Type.Object({ category: Type.Optional(Type.String({ description: "category prefix filter" })) }),
    execute: async (_id, params) => {
      const cat = (params as { category?: string }).category?.trim().toLowerCase();
      const { status, json, raw } = await httpJson(
        "GET",
        `${cfg.forgejoApi}/repos/${cfg.poolRepo}/git/trees/HEAD?recursive=true`,
      );
      if (status !== 200 || !json?.tree) throw new Error(`pool list failed (${status}): ${raw.slice(0, 150)}`);
      let paths: string[] = json.tree
        .filter((t: any) => t.type === "blob" && typeof t.path === "string" && t.path.endsWith(".md") && t.path.includes("/"))
        .map((t: any) => t.path)
        .filter((p: string) => !p.startsWith(".github/") && p !== "README.md");
      if (cat) paths = paths.filter((p) => p.toLowerCase().startsWith(cat));
      paths.sort();
      const shown = paths.slice(0, 120);
      const note = paths.length > shown.length ? `\n…and ${paths.length - shown.length} more (filter by category)` : "";
      return text(`${paths.length} personas${cat ? ` in "${cat}"` : ""}:\n${shown.join("\n")}${note}`);
    },
  };

  const propose: AgentTool<any> = {
    name: "propose_agent",
    label: "Propose a new teammate",
    description:
      "Propose a new jailed teammate from a persona template. Creates a PENDING hire a human must approve before it runs. You choose the persona, name, and role only — the sandbox config is fixed and cannot be changed.",
    parameters: Type.Object({
      template: Type.String({ description: "persona path from list_agent_templates, e.g. engineering/engineering-code-reviewer.md" }),
      name: Type.String({ description: "name for the new agent" }),
      role: Type.Optional(Type.String({ description: "one of: ceo,cto,cmo,cfo,security,engineer,designer,pm,qa,devops,researcher,general (default engineer)" })),
      reason: Type.Optional(Type.String({ description: "why this teammate is needed (shown to the human approver)" })),
    }),
    execute: async (_id, params) => {
      const p = params as { template: string; name: string; role?: string; reason?: string };
      const role = p.role && VALID_ROLES.has(p.role) ? p.role : "engineer";
      // read persona template from the Forgejo pool
      const enc = encodeURIComponent(p.template).replace(/%2F/g, "/");
      const { status, json } = await httpJson("GET", `${cfg.forgejoApi}/repos/${cfg.poolRepo}/contents/${enc}`);
      if (status !== 200 || !json?.content) throw new Error(`template not found: ${p.template}`);
      const md = Buffer.from(json.content, "base64").toString("utf8");
      const { meta, body } = parseFrontmatter(md);
      const persona =
        `You are ${p.name}${meta.name ? ` (persona: ${meta.name})` : ""}, a teammate on the Solampio project ` +
        `(a B2B solar-industry platform: Qwik storefront + Hono worker + Cloudflare Workers, TypeScript/Bun monorepo). ` +
        `You run inside an egress-walled sandbox with a fixed toolset (read/ls/grep/find/write/edit + git_commit/git_push) ` +
        `— no shell, no live credentials, no GitHub. Make small, focused, reviewable changes that match existing patterns.\n\n` +
        `--- Your persona ---\n${body}`;

      // hardcoded jailed config — the model cannot influence capabilities
      const env: Record<string, unknown> = {
        ...cfg.plainEnv,
        VAULT_SECRET_ID: { type: "secret_ref", secretId: cfg.refVaultSecretId },
        VAULT_SECRET_PATH: { type: "secret_ref", secretId: cfg.refVaultSecretPath },
        FORGEJO_SANDBOX_REMOTE: { type: "secret_ref", secretId: cfg.refForgejoRemote },
        PI_WORKSPACE_REPO: { type: "secret_ref", secretId: cfg.refForgejoRemote },
        GIT_PUSH_BRANCH: `agent/${slug(p.name)}`,
        PI_SYSTEM_PROMPT: persona,
      };
      // remove empty plain values
      for (const k of Object.keys(env)) if (env[k] === "") delete env[k];

      const { status: hs, json: hj, raw } = await httpJson(
        "POST",
        `${cfg.paperclipApi}/api/companies/${cfg.companyId}/agent-hires`,
        {
          headers: { Authorization: `Bearer ${cfg.apiKey}`, Origin: cfg.paperclipApi },
          body: {
            name: p.name,
            role,
            adapterType: "pi_agent_core",
            adapterConfig: { model: "deepseek-v4-pro", env },
            ...(p.reason ? { description: p.reason } : {}),
          },
        },
      );
      if (hs >= 200 && hs < 300) {
        const id = hj?.id ?? hj?.agentId ?? "(pending)";
        return text(`Proposed "${p.name}" (${role}) from ${p.template}. Pending hire ${id} — a human must approve it before it runs.`);
      }
      throw new Error(`propose failed (${hs}): ${raw.slice(0, 250)}`);
    },
  };

  return [list, propose];
}
