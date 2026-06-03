# Handoff — 2026-06-03

> Voltage Labs deployment of Paperclip as a sandboxed agent platform. This file
> tracks **our** rebuild work (branch `feat/pi-agent-core-adapter`). The canonical
> detailed record is `notes-infra/paperclip-sandbox-rebuild.md` on Forgejo
> (git.voltagelabs.net). Most state lives on the **server (CT 134)**, not in this
> repo — this branch only holds the `packages/pi-runner` package + registry wiring.
>
> **Tracking:** the pending work below is now in OpenProject under
> **Infrastructure → Paperclip Sandbox Platform** (project #74,
> `https://openproject.voltagelabs.net/projects/paperclip-sandbox-platform`).
> WP numbers are noted inline. (WP #506 in *Bridge × CC-Dispatch* covers the
> separate metis cred/invite *access* turn, not this rebuild.)

## Current state
Paperclip is **fully deployed and running** on Helsinki **CT 134 `paperclip-helsinki`**
(snoochie), inside an egress wall (DeepSeek + OpenBao + Forgejo only; no GitHub/live
creds; no shell). The whole stack works end-to-end and is verified:
- **The jail** (Phase 1): unprivileged LXC, OpenBao AppRole DeepSeek key, Forgejo
  sandbox, nftables egress wall + host domain-proxy/forwarder. Boundary gate passed.
- **The inner wall** (Phase 2): `packages/pi-runner` — a `pi_agent_core` adapter that
  runs agents on `@earendil-works/pi-agent-core` with a curated no-shell toolset
  (read/ls/grep/find/write/edit + sandbox-only git). DeepSeek key from OpenBao at
  runtime; outbound via the proxy. Registered in `server/src/adapters/registry.ts`.
- **Full platform**: server + Postgres via `docker compose` in CT 134, reachable at
  **http://snoochie:3100** (tailnet only; admin `chris@voltagelabs.net`, pw in Pass).
- **Solamp company + team**: CEO, Lead (=eng manager), HR, Engineer, Frontend, QA, +
  an approved Backend Architect — org wired via `reportsTo`; personas visible via
  `title`/`capabilities`. Agents work a **walled Forgejo copy of solampio**
  (`paperclip-agent/solampio`, GitHub→Forgejo mirror-on-push via a GH Action).
- **Agent delegation**: the CEO can **propose** new teammates from a persona pool;
  proposals are `pending_approval` hires you approve. HR reviews hires (verified — it
  read the codebase and gave approve/reject calls).
- **Pool supply-chain lockdown** (just done): the persona pool is now a 2-repo model —
  `agency-agents-upstream` (raw GitHub mirror) + `agency-agents` (APPROVED, branch-
  protected: PRs require **chris or metis** approval; agents can't approve/merge; no
  direct push). Agents draw only from the approved repo.

Build is green (`pi-runner` + `server` typecheck clean). Branch pushed to fork
`CyberBrown/paperclip` (no upstream PR — carries internal infra detail).

## Next steps
1. **Promotion automation** (WP #515) — build a job that opens a PR `agency-agents-upstream → agency-agents`
   when they diverge, so the security agent (Chris is setting one up) has a daily review
   queue and chris/metis have something to approve. Without it the approved pool stays frozen.
2. **Approve/reject the 2 pending hires** (WP #516, in Solamp UI): HR recommends **APPROVE
   `forge-image-port`**, **REJECT `easypost-secret-fix`** (the latter needs a live secret an
   agent can't set — wrong fit for the jail).
3. **Import all persona data per worker** (WP #517) — `propose_agent` currently imports the persona
   body+name only; extend it to map frontmatter (description/vibe/emoji → title/capabilities/icon).
   Needs a runner rebuild.
4. **Skills/capabilities catalog** (WP #518) — `desiredSkills` is a *registered* company catalog (rejects
   free-text). Build the curated-skills system: register approved skills, make them assignable,
   have HR/manager manage grants. This is the real "capabilities" knob.
5. **Fire the team kickoff** (WP #510) — proposed task set (Lead→architecture map, CEO→priorities, QA→risk
   review, Frontend→storefront audit, Engineer→app READMEs) is ready but **not yet run**.
6. **Cleanup (batch into next rebuild)** (WP #511): rename `PI_REF_*`/`PI_FORGEJO_API` env vars to
   non-sensitive names (drops a helper-secret hack); add `modelProfiles` to the adapter; make
   `propose_agent` set title/capabilities/reportsTo on hires; an autonomous-HR `review_hires`
   tool; slim the server image (drops unused claude-code/codex/opencode CLIs → faster ship).

## Decisions made this session
- **Sandbox-first**: the jail (egress wall + no live creds) is the critical path; identity
  services layered per-agent. pi-agent-core (no shell) over hermes (shell). Inner wall = the
  *absence* of a bash tool in the tool array, not a feature.
- **Build-outside, ship-in**: the walled CT can't pull from the internet, so images are built on
  monsta and `docker load`ed in. 1.4GB WAN transfer was single-stream-TCP-limited (~4 Mbps over
  117ms Tailscale) → **parallel streams** fix (~9×). Runbook: `notes-infra/helsinki-artifact-transfer.md`.
- **Propose → human-approve** for new agents (not autonomous board-key) — keeps a human in the
  loop; the propose tool hardcodes the jailed config so the model picks persona only, never capability.
- **Pool approvers = chris + metis** (outside the pool); metis is the estate's existing promotion
  authority. The auto-mirror was the real supply-chain hole → split into raw-upstream + approved.
- DeepSeek key fetched at runtime via OpenBao AppRole; LLM fetch forced through the proxy with a
  global undici `ProxyAgent` (pi-ai's openai-completions provider ignores `HTTPS_PROXY`).

## Known debt / open questions
- Runner keeps **session memory** → agents sometimes say "already done" and lean on memory; a
  fresh-session-per-issue option is a 1-line change (WP #512, batch into next rebuild).
- New CEO proposals don't auto-get `title`/`capabilities`/`reportsTo` (propose tool doesn't set them;
  folded into WP #517).
- Throwaway **"Voltage Labs" test company** + jail-agent still exist; Solamp test issues (SOL-1..11)
  are cancelled, not deleted (WP #514).
- The CT trusts OpenBao self-signed TLS via `-k`; ship the CA eventually (WP #513).
- Lateral L2 reach from the CT to other `10.10.10.x` CTs isn't filtered (auth-gated services; a
  bridge/VLAN isolation is the hardening follow-up) (WP #519).

## In-flight remote state
- **CT 134**: `docker compose` (db + server) running; UI proxy `paperclip-ui-proxy.service`,
  egress wall + forwarders are systemd units (persist on boot).
- **Forgejo** (git.voltagelabs.net): `paperclip-agent/solampio` (sandbox), `paperclip-agent/agency-agents`
  (approved pool, branch-protected), `paperclip-agent/agency-agents-upstream` (raw mirror).
- **GitHub**: Action `mirror-forgejo.yml` in `CyberBrown/solampio` (push + hourly) mirrors main→Forgejo.
  Branch `feat/pi-agent-core-adapter` lives on fork `CyberBrown/paperclip`.
- **2 pending agent hires** in Solamp awaiting your approval (see Next steps #2).
- No background jobs/dev servers left running.
