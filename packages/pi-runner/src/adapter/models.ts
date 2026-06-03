import type { AdapterModel } from "@paperclipai/adapter-utils";

/** DeepSeek models exposed by this adapter. V4 Pro is the platform's locked default. */
export const PI_MODELS: AdapterModel[] = [
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
];

export const DEFAULT_MODEL_ID = "deepseek-v4-pro";
