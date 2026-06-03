/**
 * The pi_agent_core server adapter module. Registered in Paperclip's adapter
 * registry like the other bundled adapters (adapter-claude-local, etc.).
 */
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test-environment.js";
import { PI_MODELS } from "./models.js";

const AGENT_CONFIG_DOC = `# pi_agent_core agent configuration

Runs the agent on @earendil-works/pi-agent-core with a curated, no-shell tool
set (read, ls, grep, find, write, edit + sandbox-only git). The DeepSeek key is
read from OpenBao at runtime; outbound LLM calls ride the host domain proxy.

adapterConfig:
  model: deepseek-v4-pro            # or deepseek-v4-flash
  env:
    VAULT_ADDR: https://10.10.10.132:8200
    VAULT_ROLE_ID: <approle role_id>
    VAULT_SECRET_ID: \${PAPERCLIP_SECRET_VAULT_SECRET_ID}
    VAULT_SECRET_PATH: secret/data/paperclip/deepseek
    HTTPS_PROXY: http://10.10.10.1:8888
    FORGEJO_SANDBOX_REMOTE: \${PAPERCLIP_SECRET_FORGEJO_SANDBOX_REMOTE}
    GIT_PUSH_BRANCH: agent/work
`;

export const piAgentCoreAdapter: ServerAdapterModule = {
  type: "pi_agent_core",
  execute,
  testEnvironment,
  models: PI_MODELS,
  // Issue a short-lived local agent JWT (PAPERCLIP_API_KEY) so a manager agent
  // can act as itself against the Paperclip API (e.g. propose teammates). Most
  // agents never use it; it's scoped to the agent's own company.
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: AGENT_CONFIG_DOC,
};

/** External-plugin entrypoint (also usable via the adapter-plugins loader). */
export function createServerAdapter(): ServerAdapterModule {
  return piAgentCoreAdapter;
}

export default piAgentCoreAdapter;
