/**
 * Resolve the DeepSeek model. Defaults to deepseek-v4-pro (the platform's
 * locked choice). The model's baseUrl is https://api.deepseek.com; outbound
 * calls ride HTTPS_PROXY (the host's domain-allowlist tinyproxy), so the key
 * never travels except to the one allowlisted host.
 */
import { getModel, type Model, type Api } from "@earendil-works/pi-ai";

export function resolveModel(env: NodeJS.ProcessEnv = process.env): Model<Api> {
  const provider = (env.PI_PROVIDER?.trim() || "deepseek") as "deepseek";
  const modelId = env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-pro";
  // modelId is validated at the provider registry; cast for the dynamic env value.
  return getModel(provider, modelId as never) as Model<Api>;
}
