/**
 * Ensure the agent has a repo to work in.
 *
 * When an issue runs inside a Paperclip project, the platform clones the
 * project repo into the workspace (it has a .git). When an issue runs WITHOUT a
 * project, the workspace is empty and the agent can't see any code. If
 * PI_WORKSPACE_REPO is set, we clone it into the workspace in that case — so the
 * agent always has the repo regardless of whether the issue was filed in the
 * project. A workspace that already has a .git is left untouched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isEmptyish(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    // ignore the runner's own session dir
    return entries.filter((e) => e !== ".pi-sessions").length === 0;
  } catch {
    return true; // dir doesn't exist yet
  }
}

/**
 * If the workspace has no git repo and PI_WORKSPACE_REPO is configured, clone it.
 * Returns a short status string for logging. Never throws fatally — a clone
 * failure is logged and the turn proceeds (the agent will simply report it).
 */
export async function ensureWorkspaceRepo(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  // Prefer an explicit PI_WORKSPACE_REPO; otherwise fall back to the agent's
  // sandbox remote (clone source == push target for these agents), so existing
  // agents get auto-clone with no extra config.
  const repo = env.PI_WORKSPACE_REPO?.trim() || env.FORGEJO_SANDBOX_REMOTE?.trim();
  if (!repo) return "no workspace repo configured; using workspace as-is";
  if (await isGitRepo(workspaceRoot)) return "workspace already a git repo; skip clone";
  if (!(await isEmptyish(workspaceRoot))) return "workspace non-empty but not git; skip clone";

  const ref = env.PI_WORKSPACE_REF?.trim() || env.GIT_PUSH_BRANCH_BASE?.trim() || "main";
  await fs.mkdir(workspaceRoot, { recursive: true });
  try {
    await exec(
      "git",
      ["clone", "--depth", "1", "--branch", ref, repo, "."],
      { cwd: workspaceRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 16 * 1024 * 1024 },
    );
    return `cloned PI_WORKSPACE_REPO@${ref} into empty workspace`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `WARN: failed to clone PI_WORKSPACE_REPO: ${msg.slice(0, 200)}`;
  }
}
