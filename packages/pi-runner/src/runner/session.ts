/**
 * Minimal JSONL session persistence so the agent keeps continuity across turns.
 * Paperclip invokes the runner once per turn; we load the prior transcript from
 * SESSION_FILE before the prompt and write it back after the turn settles.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export async function loadMessages(file: string | undefined): Promise<AgentMessage[]> {
  if (!file) return [];
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const messages: AgentMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as AgentMessage);
    } catch {
      // skip corrupt lines rather than fail the turn
    }
  }
  return messages;
}

export async function saveMessages(file: string | undefined, messages: AgentMessage[]): Promise<void> {
  if (!file) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = messages.map((m) => JSON.stringify(m)).join("\n");
  await fs.writeFile(file, body + (body ? "\n" : ""), "utf8");
}
