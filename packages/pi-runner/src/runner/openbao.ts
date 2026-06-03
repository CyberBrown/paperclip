/**
 * OpenBao AppRole credential seam.
 *
 * The runner holds NO LLM key on disk. It authenticates to OpenBao with an
 * AppRole bootstrap identity (role_id + secret_id, injected via env — the
 * secret_id arrives through Paperclip's ${PAPERCLIP_SECRET_*} resolution),
 * mints a short-lived token, and reads the provider key at call time.
 *
 * Wired into pi-agent-core as `AgentOptions.getApiKey(provider)`.
 */
import https from "node:https";
import http from "node:http";

export interface OpenBaoConfig {
  /** e.g. https://10.10.10.132:8200 */
  addr: string;
  roleId: string;
  secretId: string;
  /** KV v2 read path, e.g. secret/data/paperclip/deepseek */
  secretPath: string;
  /** field within the secret that holds the key */
  keyField: string;
  /** trust self-signed internal TLS (OpenBao uses a self-signed cert on the substrate) */
  skipVerify: boolean;
}

export function openBaoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OpenBaoConfig | null {
  const addr = env.VAULT_ADDR?.trim();
  const roleId = env.VAULT_ROLE_ID?.trim();
  const secretId = env.VAULT_SECRET_ID?.trim();
  if (!addr || !roleId || !secretId) return null;
  return {
    addr: addr.replace(/\/+$/, ""),
    roleId,
    secretId,
    secretPath: env.VAULT_SECRET_PATH?.trim() || "secret/data/paperclip/deepseek",
    keyField: env.VAULT_SECRET_FIELD?.trim() || "api_key",
    skipVerify: env.VAULT_SKIP_VERIFY !== "false",
  };
}

function request(
  urlStr: string,
  options: { method: string; headers?: Record<string, string>; body?: string; skipVerify: boolean },
): Promise<{ status: number; body: string }> {
  const url = new URL(urlStr);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: options.method,
        headers: options.headers,
        // self-signed internal CA: only honored for https requests
        ...(isHttps ? { rejectUnauthorized: !options.skipVerify } : {}),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * A getApiKey resolver bound to an OpenBao AppRole. Tokens are cached for the
 * process lifetime (the runner is a short-lived per-turn process, so a single
 * login per turn is fine). Returns undefined for providers we don't manage,
 * so pi-agent-core falls back to its own env lookup.
 */
export function makeOpenBaoGetApiKey(
  cfg: OpenBaoConfig,
  /** which pi provider this AppRole serves a key for */
  managedProvider = "deepseek",
): (provider: string) => Promise<string | undefined> {
  let cachedToken: string | null = null;
  let cachedKey: string | null = null;

  async function login(): Promise<string> {
    if (cachedToken) return cachedToken;
    const res = await request(`${cfg.addr}/v1/auth/approle/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role_id: cfg.roleId, secret_id: cfg.secretId }),
      skipVerify: cfg.skipVerify,
    });
    if (res.status !== 200) {
      throw new Error(`OpenBao AppRole login failed (${res.status}): ${res.body.slice(0, 200)}`);
    }
    const token = JSON.parse(res.body)?.auth?.client_token;
    if (typeof token !== "string" || !token) {
      throw new Error("OpenBao login returned no client_token");
    }
    cachedToken = token;
    return token;
  }

  async function readKey(): Promise<string> {
    if (cachedKey) return cachedKey;
    const token = await login();
    const res = await request(`${cfg.addr}/v1/${cfg.secretPath}`, {
      method: "GET",
      headers: { "X-Vault-Token": token },
      skipVerify: cfg.skipVerify,
    });
    if (res.status !== 200) {
      throw new Error(`OpenBao secret read failed (${res.status}): ${res.body.slice(0, 200)}`);
    }
    // KV v2 wraps the payload under data.data; KV v1 under data.
    const parsed = JSON.parse(res.body)?.data;
    const payload = parsed?.data ?? parsed;
    const key = payload?.[cfg.keyField];
    if (typeof key !== "string" || !key) {
      throw new Error(`OpenBao secret missing field "${cfg.keyField}"`);
    }
    cachedKey = key;
    return key;
  }

  return async (provider: string) => {
    if (provider !== managedProvider) return undefined;
    return readKey();
  };
}
