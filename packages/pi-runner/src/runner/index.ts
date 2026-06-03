#!/usr/bin/env node
/**
 * pi-paperclip-runner — one Paperclip turn on @earendil-works/pi-agent-core.
 *
 * Reads the prompt from stdin, runs a single agent turn with a CURATED tool set
 * (read/ls/grep/find/write/edit + sandbox-only git — no shell), streams the
 * assistant's text to stdout, and persists the transcript for the next turn.
 *
 * The DeepSeek key is fetched from OpenBao at call time (getApiKey) — never on
 * disk — and outbound LLM calls ride HTTPS_PROXY (the host domain proxy).
 */
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { buildTools } from "./tools/index.js";
import { resolveModel } from "./model.js";
import { makeOpenBaoGetApiKey, openBaoConfigFromEnv } from "./openbao.js";
import { loadMessages, saveMessages } from "./session.js";
import { installFetchProxyFromEnv } from "./proxy.js";
import { ensureWorkspaceRepo } from "./workspace.js";

const DEFAULT_SYSTEM_PROMPT = `You are a Paperclip agent running in a sandboxed environment.

You have a small, fixed set of tools: read, ls, grep, find, write, edit, and
(when configured) git_commit and git_push. You have NO shell and NO general
network access. To deliver work you must edit files with your tools and then
git_commit and git_push — pushing sends your commit to the team's sandbox for
human review. Be concise. When the task is complete, stop.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const prompt = (await readStdin()).trim();
  if (!prompt) {
    process.stderr.write("pi-runner: empty prompt on stdin\n");
    process.exit(2);
  }

  // Route the LLM fetch through the egress proxy (DeepSeek's openai-completions
  // provider uses native fetch, which ignores HTTPS_PROXY without this).
  installFetchProxyFromEnv();

  const workspaceRoot = process.env.WORKSPACE_ROOT?.trim() || process.cwd();
  const sessionFile = process.env.SESSION_FILE?.trim() || undefined;
  const systemPrompt = process.env.PI_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT;

  // Ensure the agent has the repo even when the issue isn't filed in a project.
  const wsStatus = await ensureWorkspaceRepo(workspaceRoot);
  process.stderr.write(`[workspace] ${wsStatus}\n`);

  const baoCfg = openBaoConfigFromEnv();
  const getApiKey = baoCfg ? makeOpenBaoGetApiKey(baoCfg, process.env.PI_PROVIDER?.trim() || "deepseek") : undefined;

  const model = resolveModel();
  const tools = buildTools(workspaceRoot);
  const messages = await loadMessages(sessionFile);

  const agent = new Agent({
    initialState: { systemPrompt, model, tools, messages },
    getApiKey,
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      process.stderr.write(`\n[tool] ${event.toolName} ${JSON.stringify(event.args)}\n`);
    } else if (event.type === "tool_execution_end" && event.isError) {
      process.stderr.write(`[tool:error] ${event.toolName}: ${JSON.stringify(event.result)}\n`);
    }
  });

  await agent.prompt(prompt);
  await agent.waitForIdle();

  await saveMessages(sessionFile, agent.state.messages);

  const err = agent.state.errorMessage;
  if (err) {
    process.stderr.write(`\npi-runner: turn ended with error: ${err}\n`);
    process.exit(1);
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(`pi-runner fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
