/**
 * Environment self-test for the pi_agent_core adapter. Surfaces config problems
 * in the Paperclip UI before a run: AppRole creds present? proxy set? sandbox
 * remote set? (Connectivity itself is exercised at run time inside the jail.)
 */
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const env = parseObject((ctx.config as Record<string, unknown>).env);
  const checks: AdapterEnvironmentCheck[] = [];

  const need = (key: string, msg: string, hint: string) => {
    if (typeof env[key] === "string" && (env[key] as string).length > 0) {
      checks.push({ code: `env.${key}`, level: "info", message: `${key} is set` });
    } else {
      checks.push({ code: `env.${key}`, level: "error", message: msg, hint });
    }
  };

  need("VAULT_ADDR", "OpenBao address missing", "Set env.VAULT_ADDR (e.g. https://10.10.10.132:8200)");
  need("VAULT_ROLE_ID", "AppRole role_id missing", "Set env.VAULT_ROLE_ID");
  need("VAULT_SECRET_ID", "AppRole secret_id missing", "Set env.VAULT_SECRET_ID via ${PAPERCLIP_SECRET_...}");

  if (typeof env.HTTPS_PROXY !== "string" || !env.HTTPS_PROXY) {
    checks.push({
      code: "env.HTTPS_PROXY",
      level: "warn",
      message: "HTTPS_PROXY not set — DeepSeek calls will not route through the domain proxy",
      hint: "Set env.HTTPS_PROXY to the host tinyproxy (e.g. http://10.10.10.1:8888)",
    });
  } else {
    checks.push({ code: "env.HTTPS_PROXY", level: "info", message: "HTTPS_PROXY is set" });
  }

  if (typeof env.FORGEJO_SANDBOX_REMOTE !== "string" || !env.FORGEJO_SANDBOX_REMOTE) {
    checks.push({
      code: "env.FORGEJO_SANDBOX_REMOTE",
      level: "warn",
      message: "No sandbox remote — the agent can edit files but cannot push",
      hint: "Set env.FORGEJO_SANDBOX_REMOTE to the authenticated sandbox URL via the host forwarder",
    });
  } else {
    checks.push({ code: "env.FORGEJO_SANDBOX_REMOTE", level: "info", message: "sandbox remote is set" });
  }

  const status = checks.some((c) => c.level === "error")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";

  return { adapterType: "pi_agent_core", status, checks, testedAt: new Date().toISOString() };
}
