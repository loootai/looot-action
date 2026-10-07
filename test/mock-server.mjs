import { createServer } from "node:http";

export async function startMock(handlers = {}) {
  const calls = [];
  let polls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body });
      const send = (s, d) => {
        res.writeHead(s, { "content-type": "application/json" });
        res.end(JSON.stringify(d));
      };
      if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "unauthorized", message: "Valid bearer token required" } });
      if (u.pathname === "/v1/runs" && req.method === "POST") {
        if (body.endpointId === "serper-search") return send(200, { runId: "r1", status: "completed", actualCost: 0.001, result: { organic: [{ position: 1, link: "https://example.com" }] } });
        if (body.endpointId === "job:people.email.find") return send(200, { runId: "r2", status: "running" });
        if (body.endpointId === "broke") return send(200, { runId: "r3", status: "failed", actualCost: 0, error: { message: "provider down" } });
        if (body.endpointId === "poor") return send(402, { error: { code: "insufficient_balance", message: "Top up to run this" } });
        if (body.endpointId === "big") return send(200, { runId: "r5", status: "completed", result: { blob: "x".repeat(950_000) } });
      }
      if (u.pathname === "/v1/runs/r2") {
        polls++;
        return send(200, { runId: "r2", status: polls >= 2 ? "completed" : "running", actualCost: 0.02, result: { email: "jane@example.com" } });
      }
      send(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}
