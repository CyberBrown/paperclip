/**
 * Route Node's global fetch through the egress proxy.
 *
 * pi-ai applies its http(s)-proxy-agent only to some providers (e.g. Bedrock);
 * the openai-completions provider DeepSeek uses goes through Node's native fetch
 * (undici), which ignores HTTPS_PROXY. In the jail that means a direct connection
 * to api.deepseek.com — which the egress wall drops. Setting a global undici
 * ProxyAgent makes that fetch tunnel through the host domain-allowlist proxy.
 *
 * OpenBao reads use node:https directly and are NOT affected by this dispatcher,
 * so they keep going direct on the substrate net.
 */
import { setGlobalDispatcher, ProxyAgent } from "undici";

export function installFetchProxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return undefined;
  setGlobalDispatcher(new ProxyAgent(proxy));
  return proxy;
}
