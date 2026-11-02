import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_AGENT_DEFAULTS } from "./config.js";
import type { BuildOptions, BuiltCommand, Env, GeneratedFile } from "./types.js";

const defaultDshProvider = "deepseek-official";
// DeepSeek-V4.1-Flash's API id. dsh has no model flag, and a patch row replaces
// its config, so every run restates the provider and model.
const defaultDshModel = BUILTIN_AGENT_DEFAULTS.dsh.model ?? "deepseek-flash";

export function dshModelSpec(modelSpec: string | undefined): { provider: string; model: string } {
  const rawModel = modelSpec ?? defaultDshModel;
  const slashIndex = rawModel.indexOf("/");
  if (slashIndex > 0 && slashIndex < rawModel.length - 1) {
    return { provider: rawModel.slice(0, slashIndex), model: rawModel.slice(slashIndex + 1) };
  }
  return { provider: defaultDshProvider, model: rawModel };
}

function overlayContent(options: Pick<BuildOptions, "model" | "reasoningEffort">, uploadEnabled: boolean): string {
  const { provider, model } = dshModelSpec(options.model);
  const lines = ["- id: agent-default-model", "  config:"];
  lines.push(`    provider: ${JSON.stringify(provider)}`, `    model: ${JSON.stringify(model)}`);
  if (options.reasoningEffort) lines.push(`    reasoningEffort: ${JSON.stringify(options.reasoningEffort)}`);
  if (!uploadEnabled) {
    lines.push("- id: session-log-deepseek", "  disabled: true");
  }
  return `${lines.join("\n")}\n`;
}

// Content-addressed so detached, concurrent, and containerized runs can share one
// file with no cleanup. It holds only routing and opt-out rows, never credentials.
export function dshOverlay(
  options: Pick<BuildOptions, "model" | "reasoningEffort">,
  env: Env,
): { file: GeneratedFile; env?: Env } {
  const uploadEnabled = env.HEADLESS_DSH_UPLOAD === "1";
  const content = overlayContent(options, uploadEnabled);
  const commandEnv = uploadEnabled ? undefined : { DSH_TELEMETRY_DISABLED: "1" };
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const root = env.HOME ? join(env.HOME, ".headless", "dsh") : join(tmpdir(), "headless-dsh");
  return {
    file: { path: join(root, `overlay-${hash}.yml`), content },
    ...(commandEnv ? { env: commandEnv } : {}),
  };
}

export function writeGeneratedFiles(command: Pick<BuiltCommand, "generatedFiles">): void {
  for (const file of command.generatedFiles ?? []) {
    mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
    writeFileSync(file.path, file.content, { mode: 0o600 });
  }
}
