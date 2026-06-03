/**
 * pi_agent_core adapter execute(). Reads the Paperclip task from ctx.context,
 * builds the prompt, and runs ONE turn by spawning the pi-paperclip-runner as a
 * child process (process isolation), piping the prompt over stdin and streaming
 * the runner's stdout/stderr back through ctx.onLog.
 *
 * Credentials/egress config (VAULT_*, HTTPS_PROXY, FORGEJO_SANDBOX_REMOTE) come
 * from the agent's adapterConfig.env, where Paperclip has already resolved any
 * ${PAPERCLIP_SECRET_*} placeholders — so secrets never live in this code.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { DEFAULT_MODEL_ID } from "./models.js";

// Resolve the built runner from the package root, independent of whether this
// adapter module was loaded from src/adapter (tsx) or dist/adapter (built):
// both sit two levels under the package root, where dist/runner/index.js lives.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER_ENTRY = path.join(PKG_ROOT, "dist/runner/index.js");

const SECRET_ENV_KEYS = new Set(["VAULT_SECRET_ID", "FORGEJO_SANDBOX_REMOTE", "VAULT_ROLE_ID"]);

function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_ENV_KEYS.has(k) ? "***" : v;
  }
  return out;
}

function buildPrompt(context: Record<string, unknown>): string {
  const sections: string[] = [];
  const task = asString(context.paperclipTaskMarkdown, "").trim();
  const handoff = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  if (handoff) sections.push(`## Prior session handoff\n\n${handoff}`);
  if (task) sections.push(task);
  if (sections.length === 0) {
    // Fall back to a wake reason if the platform provided no task markdown.
    const wake = asString(context.wakeReason, "").trim();
    if (wake) sections.push(`Wake reason: ${wake}`);
  }
  return sections.join("\n\n---\n\n").trim() || "Continue.";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { agent, config, context, runtime, onLog, onMeta, onSpawn } = ctx;

  const workspace = parseObject(context.paperclipWorkspace);
  const cwd = asString(workspace.cwd, "") || asString(config.cwd, "") || process.cwd();
  const modelId = asString(config.model, "") || DEFAULT_MODEL_ID;
  const prompt = buildPrompt(context);

  // Per-agent session file (multi-turn continuity). Session id, when present,
  // keys distinct conversations for the same agent.
  const sessionKey = asString(runtime?.sessionId, "") || agent.id;
  const sessionsDir = asString(config.sessionsDir, "") || path.join(cwd, ".pi-sessions");
  const sessionFile = path.join(sessionsDir, `${sessionKey}.jsonl`);

  const configEnv = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  for (const [k, v] of Object.entries(configEnv)) if (typeof v === "string") env[k] = v;
  env.WORKSPACE_ROOT = cwd;
  env.SESSION_FILE = sessionFile;
  env.DEEPSEEK_MODEL = modelId;
  // Local agent identity (only present when supportsLocalAgentJwt) — lets a
  // manager agent call the Paperclip API as itself (e.g. propose teammates).
  env.PI_COMPANY_ID = agent.companyId;
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;

  if (onMeta) {
    await onMeta({
      adapterType: "pi_agent_core",
      command: `${process.execPath} ${RUNNER_ENTRY}`,
      cwd,
      prompt,
      env: redactEnv(env),
    });
  }

  return await new Promise<AdapterExecutionResult>((resolve) => {
    const child = spawn(process.execPath, [RUNNER_ENTRY], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    if (onSpawn && typeof child.pid === "number") {
      void onSpawn({ pid: child.pid, processGroupId: null, startedAt: new Date().toISOString() });
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stdout += s;
      void onLog("stdout", s);
    });
    child.stderr.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stderr += s;
      void onLog("stderr", s);
    });

    child.on("error", (err) => {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `failed to spawn pi-runner: ${err.message}`,
      });
    });

    child.on("close", (code, signal) => {
      const ok = (code ?? 0) === 0;
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut: false,
        errorMessage: ok ? null : `pi-runner exited with code ${code ?? -1}`,
        provider: "deepseek",
        model: modelId,
        summary: ok ? stdout.trim().slice(-2000) || null : null,
        resultJson: ok ? undefined : { stdout, stderr },
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
