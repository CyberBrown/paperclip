/**
 * Assemble the agent's complete tool array — the inner wall.
 *
 * read/ls/grep/find/write/edit (workspace-confined) + git_commit/git_push
 * (sandbox-only). No bash, no shell, no arbitrary network. If git is not
 * configured (no FORGEJO_SANDBOX_REMOTE) the agent is read/write only and
 * cannot push anywhere.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { makeFsTools } from "./fs.js";
import { makeGitTools, gitConfigFromEnv } from "./git.js";
import { makeAgentMgmtTools, agentMgmtConfigFromEnv } from "./agents.js";

export function buildTools(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): AgentTool<any>[] {
  const tools = makeFsTools(workspaceRoot);
  const gitCfg = gitConfigFromEnv(workspaceRoot, env);
  if (gitCfg) tools.push(...makeGitTools(gitCfg));
  // Agent-management tools are gated (PI_ENABLE_AGENT_MGMT) — only the manager
  // agent (the CEO) gets them, so only it can propose new teammates.
  const mgmtCfg = agentMgmtConfigFromEnv(env);
  if (mgmtCfg) tools.push(...makeAgentMgmtTools(mgmtCfg));
  return tools;
}
