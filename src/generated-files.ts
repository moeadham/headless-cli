import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { BuiltCommand, GeneratedFile } from "./types.js";

// Docker and Modal read generated files from a fixed path: the host path can sit
// under a home, such as /root, that the sandbox user cannot traverse.
const sandboxGeneratedDir = "/tmp/headless-generated";

// Generated files hold no secrets, so they stay readable by a container user
// whose uid differs from the host's.
export function writeGeneratedFiles(command: Pick<BuiltCommand, "generatedFiles">): void {
  for (const file of command.generatedFiles ?? []) {
    mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
    writeFileSync(file.path, file.content, { mode: 0o644 });
  }
}

export function sandboxGeneratedFiles(command: BuiltCommand): {
  args: string[];
  files: Array<GeneratedFile & { hostPath: string }>;
} {
  const files = (command.generatedFiles ?? []).map((file) => ({
    ...file,
    hostPath: file.path,
    path: `${sandboxGeneratedDir}/${basename(file.path)}`,
  }));
  const args = command.args.map((arg) => files.find((file) => file.hostPath === arg)?.path ?? arg);
  return { args, files };
}
