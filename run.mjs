// Runs one looot operation for the GitHub Action. Node 20+, no dependencies.
// Reads LOOOT_INPUT_* (set by action.yml), writes step outputs to $GITHUB_OUTPUT.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const MAX_OUTPUT_BYTES = 900_000;
const TERMINAL = new Set(["completed", "failed", "blocked", "stopped", "reconciliation_pending"]);

function fail(message) {
  console.log(`::error::${message.replace(/\r?\n/g, " ")}`);
  process.exit(1);
}

function setOutput(name, value) {
  const file = env.GITHUB_OUTPUT;
  const text = String(value ?? "");
  if (!file) {
    console.log(`output ${name}=${text.length > 200 ? text.slice(0, 200) + "..." : text}`);
    return;
  }
  const delimiter = `LOOOT_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

const operationId = (env.LOOOT_INPUT_OPERATION_ID ?? "").trim();
if (!operationId) fail("operation-id is required");

let input;
try {
  input = JSON.parse(env.LOOOT_INPUT_INPUT_JSON?.trim() || "{}");
} catch (e) {
  fail(`input-json is not valid JSON: ${e.message}`);
}
if (input === null || typeof input !== "object" || Array.isArray(input)) fail("input-json must be a JSON object");

const token = (env.LOOOT_INPUT_TOKEN || env.LOOOT_TOKEN || "").trim();
if (!token) fail("No token. Pass token: ${{ secrets.LOOOT_TOKEN }} or set LOOOT_TOKEN in env.");
console.log(`::add-mask::${token}`);

const baseUrl = (env.LOOOT_INPUT_BASE_URL || "https://api.looot.ai").replace(/\/+$/, "");
const wait = Math.min(60, Math.max(0, Number.parseInt(env.LOOOT_INPUT_WAIT_SECONDS ?? "30", 10) || 0));
const timeoutMs = Math.max(wait, Number.parseInt(env.LOOOT_INPUT_TIMEOUT_SECONDS ?? "120", 10) || 120) * 1000;
const failOnError = (env.LOOOT_INPUT_FAIL_ON_ERROR ?? "true").toLowerCase() !== "false";

const fallbackMode = (env.LOOOT_INPUT_FALLBACK || "auto").toLowerCase();
const useFallback = fallbackMode === "true" || (fallbackMode === "auto" && operationId.startsWith("job:"));
const maxCost = Number.parseFloat(env.LOOOT_INPUT_MAX_COST_USD ?? "");

const digest = createHash("sha256").update(operationId + JSON.stringify(input)).digest("hex").slice(0, 16);
const idempotencyKey =
  env.LOOOT_INPUT_IDEMPOTENCY_KEY?.trim() ||
  (env.GITHUB_RUN_ID ? `gha-${env.GITHUB_RUN_ID}-${digest}` : `gha-local-${randomUUID()}`);

const body = { endpointId: operationId, input, idempotencyKey };
if (useFallback) body.fallback = maxCost > 0 ? { enabled: true, maxCostUsd: maxCost } : true;

async function call(method, path, payload) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(75_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = data?.error ?? {};
    fail(`looot ${method} ${path} failed: ${err.code ?? "http_" + res.status}: ${err.message ?? "HTTP " + res.status}`);
  }
  return data;
}

const started = Date.now();
let run = await call("POST", `/v1/runs?wait=${wait}`, body);
while (!TERMINAL.has(run.status) && Date.now() - started < timeoutMs) {
  await new Promise((r) => setTimeout(r, 3000));
  run = await call("GET", `/v1/runs/${encodeURIComponent(run.runId)}`);
}

const runJson = JSON.stringify(run);
const resultJson = JSON.stringify(run.result ?? null);
const dir = env.RUNNER_TEMP || ".";
const file = join(dir, "looot-run.json");
writeFileSync(file, JSON.stringify(run, null, 2));

const cost = typeof run.actualCost === "number" ? run.actualCost : 0;
setOutput("run-id", run.runId ?? "");
setOutput("status", run.status ?? "");
setOutput("cost-usd", cost);
setOutput("result-file", file);
const small = Buffer.byteLength(runJson) <= MAX_OUTPUT_BYTES;
setOutput("run", small ? runJson : "");
setOutput("result", small ? resultJson : "");
if (!small) console.log(`::warning::Run is larger than 900 KB, so outputs run and result are empty. Read ${file}.`);

console.log(`looot ${operationId}: ${run.status}, cost $${cost}, run ${run.runId}`);
if (env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    `### looot run\n\n| Operation | Status | Cost | Run |\n| --- | --- | --- | --- |\n| \`${operationId}\` | ${run.status} | $${cost} | \`${run.runId}\` |\n\n`,
  );
}

if (run.status !== "completed" && failOnError) {
  const why = run.error?.message ?? run.outcomeReason ?? "";
  fail(`looot run ${run.runId} ended ${run.status}${why ? ": " + why : ""}`);
}
