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

export function buildTools(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): AgentTool<any>[] {
  const tools = makeFsTools(workspaceRoot);
  const gitCfg = gitConfigFromEnv(workspaceRoot, env);
  if (gitCfg) tools.push(...makeGitTools(gitCfg));
  return tools;
}
