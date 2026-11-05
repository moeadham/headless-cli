import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAgentCommand, buildInteractiveAgentCommand, dshPatchFile, waitTierForAgent, writeDshPatchFile } from "../src/agents.ts";
import { runCli } from "../src/cli.ts";
import { buildDockerAgentCommand } from "../src/docker.ts";
import { compactOversizedTraceLine } from "../src/relevant-trace.ts";
import { extractAgentError, extractFinalMessage, extractNativeSessionId, extractUsageSummary } from "../src/output.ts";

const line = (value: unknown) => JSON.stringify(value);
const trace = [
  line({ type: "session", sessionId: "session-1", cwd: "/work" }),
  line({ type: "status", phase: "step_start", turn: 1, step: 1 }),
  line({ type: "text", text: "working" }),
  line({ type: "tool_result", callId: "c", status: "error", result: "boom", error: { name: "E", code: "X" } }),
  line({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, reasoningTokens: 2 } }),
  line({ type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 5, outputTokens: 1 } }),
  line({ type: "final", sessionId: "session-1", reason: { kind: "completed" }, text: "all done" }),
].join("\n");

test("builds a one-shot dsh command with a patch file and the task on stdin", () => {
  const built = buildAgentCommand("dsh", { prompt: "hello", allow: "read-only" }, { HOME: "/home/u", DSH_BIN: "/opt/dsh" });
  const patch = dshPatchFile({ prompt: "hello", allow: "read-only" }, { HOME: "/home/u" });
  assert.equal(built.command, "/opt/dsh");
  assert.match(patch?.path ?? "", /^\/home\/u\/\.headless\/dsh\/overlay-[0-9a-f]{16}\.yml$/);
  assert.deepEqual(built.args, [
    "--profile", "headless", "--patch", patch?.path, "--json",
    "--permission-mode", "read-only", "--approval-policy", "never", "-",
  ]);
  assert.equal(built.stdinText, "hello");
  assert.equal(built.env?.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(patch?.content, [
    "- id: agent-default-model", "  config:", '    provider: "deepseek-official"', '    model: "deepseek-flash"',
    "- id: session-log-deepseek", "  disabled: true", "",
  ].join("\n"));
});

test("dsh yolo is the default and resume passes the native session id", () => {
  const built = buildAgentCommand("dsh", { prompt: "x", sessionMode: "resume", sessionId: "session-1" }, { HOME: "/h" });
  assert.deepEqual(built.args.slice(5), ["--permission-mode", "danger-full-access", "--approval-policy", "never", "--session-id", "session-1", "-"]);
  const fresh = buildAgentCommand("dsh", { prompt: "x", sessionMode: "new", sessionId: "ignored" }, { HOME: "/h" });
  assert.equal(fresh.args.includes("--session-id"), false);
});

test("dsh patch carries model and effort", () => {
  const patch = dshPatchFile({ prompt: "x", model: "deepseek-v4-pro", reasoningEffort: "high" }, { HOME: "/h" });
  assert.match(patch.content, /model: "deepseek-v4-pro"\n {4}reasoningEffort: "high"\n/);
});

test("HEADLESS_DSH_UPLOAD keeps DSH upload defaults", () => {
  const built = buildAgentCommand("dsh", { prompt: "x" }, { HOME: "/h", HEADLESS_DSH_UPLOAD: "1" });
  assert.doesNotMatch(dshPatchFile({ prompt: "x" }, { HOME: "/h", HEADLESS_DSH_UPLOAD: "1" }).content, /session-log-deepseek/);
  assert.equal(built.env, undefined);
});

test("dsh rejects tmux", () => {
  assert.equal(waitTierForAgent("dsh"), "unsupported");
  assert.throws(() => buildInteractiveAgentCommand("dsh", { prompt: "x" }, {}), /--tmux is not supported by dsh/);
});

test("parses the dsh event stream", () => {
  assert.equal(extractFinalMessage("dsh", trace), "all done");
  assert.equal(extractNativeSessionId("dsh", trace), "session-1");
  assert.equal(extractAgentError("dsh", trace), "");
});

test("dsh errors come from run outcome, not tool errors", () => {
  assert.equal(extractAgentError("dsh", line({ type: "error", message: "unknown session" })), "dsh error: unknown session");
  assert.match(extractAgentError("dsh", line({ type: "final", reason: { kind: "aborted" }, text: "" })), /reason aborted/);
  assert.match(extractAgentError("dsh", line({ type: "final", reason: null, text: "" })), /reason unknown/);
  assert.equal(extractAgentError("dsh", ""), "");
});

test("sums dsh step usage and refuses partial totals", () => {
  const usage = extractUsageSummary("dsh", trace, { model: "deepseek-v4-pro", provider: "deepseek-official" });
  assert.equal(usage.usageStatus, "reported");
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.cacheReadTokens, 6);
  assert.equal(usage.reasoningOutputTokens, 2);
  const partial = `${trace}\n${line({ type: "status", phase: "step_end", turn: 1, step: 3 })}`;
  assert.equal(extractUsageSummary("dsh", partial).usageStatus, "missing");
});

test("oversized dsh final keeps its outcome", () => {
  const big = line({ type: "final", sessionId: "s", reason: { kind: "completed" }, text: "x".repeat(1024) });
  assert.equal(extractAgentError("dsh", compactOversizedTraceLine("dsh", big)), "");
});

test("Docker mounts the dsh patch at its host path", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-docker-"));
  const options = { prompt: "x" };
  writeDshPatchFile(options, { HOME: home });
  const command = buildAgentCommand("dsh", options, { HOME: home });
  const path = dshPatchFile(options, { HOME: home }).path;
  const docker = buildDockerAgentCommand({
    agent: "dsh", command, dockerArgs: [], dockerEnv: [], env: { HOME: home, DEEPSEEK_API_KEY: "k" },
    image: "image", workDir: tmpdir(),
  });
  assert.ok(docker.args.includes(`${path}:${path}:ro`));
  assert.equal(docker.args[docker.args.indexOf("--patch") + 1], path);
  assert.ok(docker.args.includes("DEEPSEEK_API_KEY"));
});

function fixture(script: string) {
  const home = mkdtempSync(join(tmpdir(), "dsh-cli-"));
  writeFileSync(join(home, "dsh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const patchPath = args[args.indexOf('--patch') + 1];
const patch = fs.readFileSync(patchPath, 'utf8');
const task = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.HOME + '/call.json', JSON.stringify({ args, patch, patchMode: fs.statSync(patchPath).mode & 0o777, task, telemetry: process.env.DSH_TELEMETRY_DISABLED }));
${script}
`, { mode: 0o755 });
  const out: string[] = [];
  const err: string[] = [];
  return {
    home, out, err,
    env: { HOME: home, PATH: `${home}:${process.env.PATH}` },
    io: { stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); } },
    call: () => JSON.parse(readFileSync(join(home, "call.json"), "utf8")),
  };
}

const success = `console.log(${JSON.stringify(trace)});`;

test("CLI runs dsh end to end and writes the patch file", async () => {
  const run = fixture(success);
  const code = await runCli(["dsh", "--prompt", "hi", "--model", "deepseek-v4-pro"], { env: run.env, ...run.io });
  assert.equal(code, 0, run.err.join(""));
  assert.equal(run.out.join("").trim(), "all done");
  const call = run.call();
  assert.equal(call.task, "hi");
  assert.equal(call.telemetry, "1");
  assert.match(call.patch, /model: "deepseek-v4-pro"/);
  assert.equal(call.patchMode, 0o644);
});

test("CLI reports dsh usage and stores the native session for resume", async () => {
  const run = fixture(success);
  assert.equal(await runCli(["dsh", "--prompt", "one", "--session", "bug", "--usage"], { env: run.env, ...run.io }), 0, run.err.join(""));
  assert.match(run.out.join(""), /"inputTokens":15/);
  assert.equal(run.call().args.includes("--session-id"), false);
  assert.equal(await runCli(["dsh", "--prompt", "two", "--session", "bug"], { env: run.env, ...run.io }), 0, run.err.join(""));
  assert.equal(run.call().args[run.call().args.indexOf("--session-id") + 1], "session-1");
});

test("CLI fails a dsh run with its run outcome", async () => {
  const run = fixture(`console.log(${JSON.stringify(line({ type: "final", sessionId: "s", reason: { kind: "aborted" }, text: "" }))}); process.exit(1);`);
  assert.equal(await runCli(["dsh", "--prompt", "x"], { env: run.env, ...run.io }), 1);
  assert.match(run.err.join(""), /reason aborted/);
});

test("CLI passes a successful dsh --json stream through", async () => {
  const run = fixture(success);
  assert.equal(await runCli(["dsh", "--prompt", "x", "--json"], { env: run.env, ...run.io }), 0, run.err.join(""));
  assert.match(run.out.join(""), /"type":"final"/);
});

test("CLI streams a dsh prompt file on stdin", async () => {
  const run = fixture(success);
  const promptFile = join(run.home, "task.md");
  writeFileSync(promptFile, "from file");
  assert.equal(await runCli(["dsh", "--prompt-file", promptFile], { env: run.env, ...run.io }), 0, run.err.join(""));
  assert.equal(run.call().task, "from file");
});

test("CLI defaults dsh to deepseek-flash and reports the route in usage", async () => {
  const run = fixture(success);
  assert.equal(await runCli(["dsh", "--prompt", "hi", "--usage"], { env: run.env, ...run.io }), 0, run.err.join(""));
  const call = run.call();
  const content: string = call.patch;
  assert.match(content, /provider: "deepseek-official"\n {4}model: "deepseek-flash"/);
  assert.match(content, /session-log-deepseek/);
  assert.match(run.out.join(""), /"provider":"deepseek-official","model":"deepseek-flash"/);
});

test("a dsh launch failure is not reported as a missing final event", async () => {
  const run = fixture("");
  const code = await runCli(["dsh", "--prompt", "x"], { env: { ...run.env, DSH_BIN: join(run.home, "absent") }, ...run.io });
  assert.equal(code, 127);
  assert.doesNotMatch(run.err.join(""), /dsh error/);
});
