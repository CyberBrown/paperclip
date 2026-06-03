/**
 * Workspace-confined filesystem tools. These plus the scoped git tools are the
 * agent's ENTIRE capability surface (pi-agent-core ships no default tools).
 * There is deliberately no shell/exec/bash tool.
 *
 * Every path is resolved and asserted to stay within the workspace root, so the
 * agent cannot read or write outside the run's working tree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".pnpm", ".cache"]);
const MAX_BYTES = 256 * 1024; // per-file read cap
const MAX_MATCHES = 200;

function text(s: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: s }], details: null };
}

/** Resolve a user-supplied path against the workspace root and refuse escapes. */
function resolveInside(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`path "${rel}" escapes the workspace root`);
  }
  return resolved;
}

async function walk(
  root: string,
  start: string,
  onFile: (abs: string) => Promise<boolean>, // return false to stop
): Promise<void> {
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        const cont = await onFile(abs);
        if (!cont) return;
      }
    }
  }
}

export function makeFsTools(root: string): AgentTool<any>[] {
  const read: AgentTool<any> = {
    name: "read",
    label: "Read file",
    description: "Read a UTF-8 text file within the workspace. Returns its contents.",
    parameters: Type.Object({ path: Type.String({ description: "path relative to the workspace root" }) }),
    execute: async (_id, params) => {
      const abs = resolveInside(root, (params as { path: string }).path);
      const buf = await fs.readFile(abs);
      const slice = buf.subarray(0, MAX_BYTES).toString("utf8");
      const truncated = buf.byteLength > MAX_BYTES ? `\n…[truncated at ${MAX_BYTES} bytes]` : "";
      return text(slice + truncated);
    },
  };

  const ls: AgentTool<any> = {
    name: "ls",
    label: "List directory",
    description: "List entries of a directory within the workspace.",
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "dir relative to root (default '.')" })) }),
    execute: async (_id, params) => {
      const rel = (params as { path?: string }).path ?? ".";
      const abs = resolveInside(root, rel);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const lines = entries
        .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
        .sort();
      return text(lines.join("\n") || "(empty)");
    },
  };

  const grep: AgentTool<any> = {
    name: "grep",
    label: "Search file contents",
    description: "Search file contents under a path for a regular expression. Returns matching lines.",
    parameters: Type.Object({
      pattern: Type.String({ description: "JavaScript regular expression" }),
      path: Type.Optional(Type.String({ description: "dir/file relative to root (default '.')" })),
    }),
    execute: async (_id, params) => {
      const p = params as { pattern: string; path?: string };
      const re = new RegExp(p.pattern);
      const startAbs = resolveInside(root, p.path ?? ".");
      const matches: string[] = [];
      await walk(root, startAbs, async (abs) => {
        let buf: Buffer;
        try {
          buf = await fs.readFile(abs);
        } catch {
          return true;
        }
        if (buf.byteLength > MAX_BYTES || buf.includes(0)) return true; // skip large/binary
        const relPath = path.relative(root, abs);
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
            if (matches.length >= MAX_MATCHES) return false;
          }
        }
        return true;
      });
      return text(matches.join("\n") || "(no matches)");
    },
  };

  const find: AgentTool<any> = {
    name: "find",
    label: "Find files by name",
    description: "Find files under a path whose relative path contains the given substring.",
    parameters: Type.Object({
      name: Type.String({ description: "substring to match in the file's relative path" }),
      path: Type.Optional(Type.String({ description: "dir relative to root (default '.')" })),
    }),
    execute: async (_id, params) => {
      const p = params as { name: string; path?: string };
      const startAbs = resolveInside(root, p.path ?? ".");
      const needle = p.name.toLowerCase();
      const hits: string[] = [];
      await walk(root, startAbs, async (abs) => {
        const relPath = path.relative(root, abs);
        if (relPath.toLowerCase().includes(needle)) {
          hits.push(relPath);
          if (hits.length >= MAX_MATCHES) return false;
        }
        return true;
      });
      return text(hits.join("\n") || "(no files)");
    },
  };

  const write: AgentTool<any> = {
    name: "write",
    label: "Write file",
    description: "Create or overwrite a file within the workspace with the given contents.",
    parameters: Type.Object({
      path: Type.String({ description: "path relative to the workspace root" }),
      content: Type.String({ description: "full file contents" }),
    }),
    execute: async (_id, params) => {
      const p = params as { path: string; content: string };
      const abs = resolveInside(root, p.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, p.content, "utf8");
      return text(`wrote ${p.content.length} chars to ${p.path}`);
    },
  };

  const edit: AgentTool<any> = {
    name: "edit",
    label: "Edit file",
    description:
      "Replace an exact string in a file within the workspace. The old string must occur exactly once.",
    parameters: Type.Object({
      path: Type.String({ description: "path relative to the workspace root" }),
      old: Type.String({ description: "exact string to replace (must be unique in the file)" }),
      new: Type.String({ description: "replacement string" }),
    }),
    execute: async (_id, params) => {
      const p = params as { path: string; old: string; new: string };
      const abs = resolveInside(root, p.path);
      const original = await fs.readFile(abs, "utf8");
      const count = original.split(p.old).length - 1;
      if (count === 0) throw new Error("old string not found");
      if (count > 1) throw new Error(`old string is not unique (${count} occurrences)`);
      await fs.writeFile(abs, original.replace(p.old, p.new), "utf8");
      return text(`edited ${p.path}`);
    },
  };

  return [read, ls, grep, find, write, edit];
}
