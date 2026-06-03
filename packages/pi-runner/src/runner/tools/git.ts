/**
 * Scoped git tools. The agent can stage+commit its workspace and push — but ONLY
 * to the pre-configured Forgejo sandbox remote. The agent supplies no remote, no
 * URL, no refspec target: those are fixed by env, not by the model. Combined with
 * the egress wall (the sandbox remote is only reachable via the host forwarder),
 * this means the agent has exactly one place it can send code, and nowhere else.
 *
 * Uses execFile('git', [...]) — no shell, so the commit message (the only
 * model-controlled input) cannot inject commands.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

const exec = promisify(execFile);

export interface GitConfig {
  /** absolute workspace root (the git repo) */
  root: string;
  /** fully-qualified authenticated sandbox remote URL (fixed; never model-supplied) */
  remoteUrl: string;
  /** branch to push to, e.g. "agent/work" */
  branch: string;
  authorName: string;
  authorEmail: string;
}

export function gitConfigFromEnv(root: string, env: NodeJS.ProcessEnv = process.env): GitConfig | null {
  const remoteUrl = env.FORGEJO_SANDBOX_REMOTE?.trim();
  if (!remoteUrl) return null;
  return {
    root,
    remoteUrl,
    branch: env.GIT_PUSH_BRANCH?.trim() || "agent/work",
    authorName: env.GIT_AUTHOR_NAME?.trim() || "paperclip-agent",
    authorEmail: env.GIT_AUTHOR_EMAIL?.trim() || "paperclip-agent@agents.voltagelabs.net",
  };
}

function text(s: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: s }], details: null };
}

async function git(cfg: GitConfig, args: string[]): Promise<string> {
  const idArgs = ["-c", `user.name=${cfg.authorName}`, "-c", `user.email=${cfg.authorEmail}`];
  const { stdout, stderr } = await exec("git", ["-C", cfg.root, ...idArgs, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    // git creds are in the remote URL; never prompt interactively
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return (stdout + stderr).trim();
}

export function makeGitTools(cfg: GitConfig): AgentTool<any>[] {
  const commit: AgentTool<any> = {
    name: "git_commit",
    label: "Git commit",
    description:
      "Stage all changes in the workspace and create a commit with the given message. Local only — does not push.",
    parameters: Type.Object({ message: Type.String({ description: "commit message" }) }),
    execute: async (_id, params) => {
      const message = (params as { message: string }).message;
      await git(cfg, ["add", "-A"]);
      try {
        const out = await git(cfg, ["commit", "-m", message]);
        return text(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/nothing to commit/i.test(msg)) return text("nothing to commit (working tree clean)");
        throw err;
      }
    },
  };

  const push: AgentTool<any> = {
    name: "git_push",
    label: "Git push to sandbox",
    description:
      "Push committed work to the Forgejo sandbox. The destination is fixed (the sandbox repo) — you cannot choose a remote or branch.",
    parameters: Type.Object({}),
    execute: async () => {
      // HEAD -> the fixed sandbox branch. Remote URL is fixed config, not input.
      const out = await git(cfg, ["push", cfg.remoteUrl, `HEAD:refs/heads/${cfg.branch}`]);
      return text(`pushed to sandbox branch ${cfg.branch}\n${out}`);
    },
  };

  return [commit, push];
}
