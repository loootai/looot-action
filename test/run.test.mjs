import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "run.mjs");

import { spawn } from "node:child_process";
function runAction(mockUrl, inputs, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "looot-action-"));
  const out = join(dir, "output");
  const summary = join(dir, "summary.md");
  const env = {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: out,
    GITHUB_STEP_SUMMARY: summary,
    RUNNER_TEMP: dir,
    GITHUB_RUN_ID: "42",
    LOOOT_INPUT_BASE_URL: mockUrl,
    LOOOT_INPUT_TOKEN: "test-token",
    LOOOT_INPUT_TIMEOUT_SECONDS: "30",
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`LOOOT_INPUT_${k}`, v])),
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn("node", [script], { env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stdout += d));
    child.on("close", (code) => {
      const outputs = {};
      if (existsSync(out)) {
        const text = readFileSync(out, "utf8");
        for (const m of text.matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
      }
      resolve({ code, stdout, outputs, dir, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" });
    });
  });
}

test("completed run: outputs, auth header, body, summary", async () => {
  const mock = await startMock();
  try {
    const r = await runAction(mock.url, { OPERATION_ID: "serper-search", INPUT_JSON: '{"q":"looot"}', WAIT_SECONDS: "10" });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.status, "completed");
    assert.equal(r.outputs["run-id"], "r1");
    assert.equal(r.outputs["cost-usd"], "0.001");
    assert.equal(JSON.parse(r.outputs.result).organic[0].position, 1);
    assert.equal(JSON.parse(r.outputs.run).runId, "r1");
    const call = mock.calls[0];
    assert.equal(call.auth, "Bearer test-token");
    assert.equal(call.query.wait, "10");
    assert.deepEqual(call.body.input, { q: "looot" });
    assert.match(call.body.idempotencyKey, /^gha-42-[0-9a-f]{16}$/);
    assert.equal(call.body.fallback, undefined, "no fallback for a plain endpoint");
    assert.match(r.summary, /serper-search.*completed/);
    assert.ok(readFileSync(r.outputs["result-file"], "utf8").includes('"runId": "r1"'));
    assert.match(r.stdout, /::add-mask::test-token/);
  } finally {
    await mock.close();
  }
});

test("job run turns fallback on with the cost cap and polls until done", async () => {
  const mock = await startMock();
  try {
    const r = await runAction(mock.url, {
      OPERATION_ID: "job:people.email.find",
      INPUT_JSON: '{"first_name":"Jane","domain":"example.com"}',
      MAX_COST_USD: "0.25",
      WAIT_SECONDS: "0",
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.status, "completed");
    assert.deepEqual(mock.calls[0].body.fallback, { enabled: true, maxCostUsd: 0.25 });
    assert.ok(mock.calls.filter((c) => c.path === "/v1/runs/r2").length >= 2, "polled");
  }
  finally {
    await mock.close();
  }
});

test("failed run fails the step, unless fail-on-error is false", async () => {
  const mock = await startMock();
  try {
    const bad = await runAction(mock.url, { OPERATION_ID: "broke" });
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /::error::looot run r3 ended failed: provider down/);
    assert.equal(bad.outputs.status, "failed");
    const soft = await runAction(mock.url, { OPERATION_ID: "broke", FAIL_ON_ERROR: "false" });
    assert.equal(soft.code, 0);
  } finally {
    await mock.close();
  }
});

test("api error surfaces code and message", async () => {
  const mock = await startMock();
  try {
    const r = await runAction(mock.url, { OPERATION_ID: "poor" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /insufficient_balance: Top up to run this/);
  } finally {
    await mock.close();
  }
});

test("bad input json, missing token, wrong token", async () => {
  const mock = await startMock();
  try {
    assert.match((await runAction(mock.url, { OPERATION_ID: "x", INPUT_JSON: "{nope" })).stdout, /not valid JSON/);
    assert.match((await runAction(mock.url, { OPERATION_ID: "x", INPUT_JSON: "[1]" })).stdout, /must be a JSON object/);
    assert.match((await runAction(mock.url, { OPERATION_ID: "x", TOKEN: "" })).stdout, /No token/);
    const wrong = await runAction(mock.url, { OPERATION_ID: "x", TOKEN: "wrong" });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stdout, /unauthorized/);
  } finally {
    await mock.close();
  }
});

test("LOOOT_TOKEN from env works and a caller idempotency key is kept", async () => {
  const mock = await startMock();
  try {
    const r = await runAction(mock.url, { OPERATION_ID: "serper-search", TOKEN: "", IDEMPOTENCY_KEY: "mine" }, { LOOOT_TOKEN: "test-token" });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(mock.calls[0].body.idempotencyKey, "mine");
  } finally {
    await mock.close();
  }
});

test("a run over 900 KB leaves the outputs empty and points at the file", async () => {
  const mock = await startMock();
  try {
    const r = await runAction(mock.url, { OPERATION_ID: "big" });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.result, "");
    assert.match(r.stdout, /::warning::/);
    assert.ok(readFileSync(r.outputs["result-file"], "utf8").length > 900_000);
  } finally {
    await mock.close();
  }
});

test("action.yml declares the inputs and outputs the script reads and writes", () => {
  const yml = readFileSync(join(here, "..", "action.yml"), "utf8");
  const js = readFileSync(script, "utf8");
  for (const m of yml.matchAll(/LOOOT_INPUT_([A-Z_]+):/g)) assert.ok(js.includes(`LOOOT_INPUT_${m[1]}`), m[1]);
  for (const out of ["result", "run", "run-id", "status", "cost-usd", "result-file"]) {
    assert.ok(yml.includes(`steps.run.outputs.${out}`), out);
    assert.ok(js.includes(`setOutput("${out}"`), out);
  }
  assert.match(yml, /using: composite/);
});
