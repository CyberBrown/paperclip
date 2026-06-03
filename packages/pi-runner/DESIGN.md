# pi-agent-core adapter — design & scope

Status: **scoped, validated against source, ready to build** (2026-06-02).
Context: the Paperclip sandbox-first rebuild. This adapter is the **inner wall** — agents
get *only the tools we define*, no shell. Outer wall (egress + no live creds) is already
built and verified (see `notes-infra/paperclip-sandbox-rebuild.md`, Phase 1).

## Why this exists

The old platform was dangerous because hermes gave agents a `terminal --yolo` shell-as-user.
This adapter runs agents on **`@earendil-works/pi-agent-core`** instead, which ships **zero
built-in tools** — an `Agent`'s entire capability surface is the `tools` array we pass it.
The inner wall is therefore not a feature we add; it is the *absence* of a `bash` tool in an
array we control.

## Architecture: subprocess runner + bundled adapter package

```
Paperclip server (CT 134)
  registry.ts ──imports──> @paperclipai/pi-runner (adapter)         [like adapter-claude-local]
       adapter.execute(ctx)
         ├─ reads ctx.context.paperclipTaskMarkdown (+ handoff + wake)  → builds prompt
         ├─ spawns the runner CLI, prompt piped via STDIN
         ├─ env: VAULT_* (AppRole) + HTTPS_PROXY + DEEPSEEK_MODEL + SESSION_FILE
         └─ streams runner stdout → ctx.onLog → run log
  runner CLI (child process — isolation boundary)
       embeds @earendil-works/pi-agent-core + pi-ai
         ├─ getApiKey('deepseek') → OpenBao AppRole login → read secret/paperclip/deepseek
         ├─ model = deepseek (baseUrl https://api.deepseek.com); HTTPS_PROXY → tinyproxy
         ├─ tools = CURATED ARRAY (the inner wall — see below)
         ├─ messages loaded/saved to SESSION_FILE (JSONL) for multi-turn continuity
         └─ agent.subscribe(text_delta → stdout); agent.prompt(stdin); waitForIdle()
```

Subprocess (not in-process embedding) for defense in depth: agent tools execute in a child
process, not the orchestrator's. Mirrors how Paperclip already runs claude/codex/cursor.

### Why a bundled package, not the generic `process` adapter

The built-in `process` adapter spawns a command but **discards `ctx.context`** — it cannot
deliver the Paperclip task to the agent. A real `execute(ctx)` is required to read
`context.paperclipTaskMarkdown` and pipe it in. So we ship a workspace package imported
directly in `server/src/adapters/registry.ts` (exactly how `@paperclipai/adapter-claude-local`
is wired — NOT via the external `adapter-plugins.json` plugin-loader, which is for 3rd parties).

## The inner wall — the tool array

Self-implemented `AgentTool`s (no dependency on pi-coding-agent internals), every filesystem
tool confined to the run's workspace root by resolved-path check:

| Tool | Capability | Confinement |
|---|---|---|
| `read` | read a file | within workspace root |
| `ls` | list a dir | within workspace root |
| `grep` | content search | within workspace root |
| `find` | filename/glob search | within workspace root |
| `write` | create/overwrite a file | within workspace root |
| `edit` | string-replace edit | within workspace root |
| `git_commit` | stage + commit | workspace repo only |
| `git_push` | push to sandbox remote | **`paperclip-agent/sandbox` only**, via host forwarder |

**Explicitly NOT present: `bash`/shell/exec, arbitrary network, any other git remote.**
`git_push` hardcodes the sandbox remote (`http://…@10.10.10.1:3000/paperclip-agent/sandbox.git`)
— it cannot push anywhere else. This is the whole "no raw capability, no live creds" guarantee.

## Credential seam (no key on disk)

`AgentOptions.getApiKey('deepseek')` → AppRole login using `VAULT_ROLE_ID`/`VAULT_SECRET_ID`
(env-injected; secret_id arrives via Paperclip's `${PAPERCLIP_SECRET_*}` resolution) → mint
15-min token → read `secret/paperclip/deepseek`. Outbound DeepSeek HTTPS rides `HTTPS_PROXY`
= the host tinyproxy (domain-allowlisted). Both proven working in Phase 1 verification.

## Validated facts (against source)

- `@earendil-works/pi-agent-core` / `pi-ai` are **published on npm** (0.78.0) — plain install.
- pi-agent-core has **no default tools**; `new Agent({ initialState: { tools, model, systemPrompt, messages }, getApiKey })`.
- Streaming: `agent.subscribe(e => e.type==='message_update' && e.assistantMessageEvent.type==='text_delta')`; completion via `turn_end`/`agent_end`; `agent.waitForIdle()`.
- DeepSeek: `Model<'openai-completions'>` with `baseUrl: 'https://api.deepseek.com'`, `provider: 'deepseek'`; pi-ai honors `HTTPS_PROXY`.
- Paperclip adapter contract (`@paperclipai/adapter-utils` `ServerAdapterModule`): required `type`, `execute(ctx)=>Promise<AdapterExecutionResult>`, `testEnvironment`, `models`, `agentConfigurationDoc`. Prompt delivered to the child via **stdin** (claude-local pattern); output streamed via `ctx.onLog`.
- Task source keys in `ctx.context`: `paperclipTaskMarkdown`, `paperclipSessionHandoffMarkdown`, `paperclipWake`, `paperclipWorkspace` (cwd), session id via `ctx.runtime`.

## Build plan (file by file)

```
packages/pi-runner/
  package.json            @paperclipai/pi-runner; deps: pi-agent-core, pi-ai, adapter-utils
  tsconfig.json
  src/
    runner/
      index.ts            CLI: read stdin prompt, build Agent, run turn, stream stdout, save session
      openbao.ts          AppRole getApiKey('deepseek')
      model.ts            DeepSeek model def (baseUrl)
      session.ts          load/save messages as JSONL (SESSION_FILE)
      tools/
        index.ts          assemble the curated array
        fs.ts             read/ls/grep/find/write/edit (workspace-confined)
        git.ts            git_commit + git_push (sandbox remote only)
    adapter/
      index.ts            ServerAdapterModule { type:'pi_agent_core', execute, testEnvironment, models, agentConfigurationDoc }
      execute.ts          read ctx.context → prompt → spawn runner (stdin) → onLog stream
      models.ts           DeepSeek model list
      test-environment.ts AppRole reachable? proxy reachable? sandbox remote reachable?
```
Then: register in `server/src/adapters/registry.ts`; deploy Paperclip in CT 134; configure an
agent on `pi_agent_core`; run a real task that lands a commit in the Forgejo sandbox — through
the wall. End-to-end proof = the gate for Phase 2.
```
