import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "./codex.js";
import { Harness } from "./harness.js";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codex = new Codex();
const harness = new Harness(
  process.env.HARNESS_DATA_DIR || path.join(base, ".harness"),
  codex,
);
const clients = new Set();
let revision = 0,
  accountCache = null;
harness.on("change", () => revision++);
harness.on("account", () => {
  accountCache = null;
  revision++;
});
codex.on("disconnect", () => {
  accountCache = null;
});
const ticker = setInterval(
  () => harness.tick().catch((error) => console.error(error.message)),
  1000,
);
const stream = setInterval(() => {
  for (const res of clients)
    if (res.lastRevision !== revision) {
      res.lastRevision = revision;
      res.write(`data: ${JSON.stringify(harness.snapshot())}\n\n`);
    }
}, 350);
async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64000) throw new Error("Request too large.");
  }
  return JSON.parse(data || "{}");
}
const json = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
};
const server = http.createServer(async (req, res) => {
  const host = req.headers.host;
  const expectedHosts = new Set([
    `127.0.0.1:${server.address().port}`,
    `localhost:${server.address().port}`,
  ]);
  // Reject cross-origin requests and DNS rebinding on this local control surface.
  if (
    !expectedHosts.has(host) ||
    (req.headers.origin && req.headers.origin !== `http://${host}`) ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    return json(res, 403, { error: "Local same-origin access only." });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    const url = new URL(req.url, `http://${host}`),
      route = url.pathname;
    if (req.method === "GET" && route === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(harness.snapshot())}\n\n`);
      res.lastRevision = revision;
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && route === "/api/state")
      return json(res, 200, harness.snapshot());
    if (req.method === "GET" && route === "/api/account") {
      if (!accountCache || Date.now() - accountCache.time > 60000) {
        await codex.start();
        const account = await codex.call("account/read", {
          refreshToken: false,
        });
        const limits = await codex
          .call("account/rateLimits/read")
          .catch(() => null);
        accountCache = { time: Date.now(), account: account.account, limits };
      }
      return json(res, 200, accountCache);
    }
    if (req.method === "GET" && route === "/api/models") {
      await codex.start();
      return json(res, 200, await codex.call("model/list", {}));
    }
    const diff = route.match(/^\/api\/tasks\/([\w-]+)\/diff$/);
    if (req.method === "GET" && diff)
      return json(res, 200, await harness.diff(diff[1]));
    if (req.method === "POST") {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "Use application/json." });
      const input = await body(req);
      if (route === "/api/projects")
        return json(res, 201, await harness.addProject(input));
      if (route === "/api/tasks") return json(res, 201, harness.addTask(input));
      if (route === "/api/settings") {
        harness.settings(input);
        return json(res, 200, {});
      }
      const action = route.match(/^\/api\/tasks\/([\w-]+)\/action$/);
      if (action) {
        await harness.action(action[1], input.action);
        return json(res, 200, {});
      }
      const approval = route.match(/^\/api\/requests\/([\w-]+)$/);
      if (approval) {
        harness.answer(approval[1], input);
        return json(res, 200, {});
      }
      return json(res, 404, { error: "Unknown endpoint." });
    }
    const assets = {
      "/": ["index.html", "text/html"],
      "/app.js": ["app.js", "text/javascript"],
      "/style.css": ["style.css", "text/css"],
    };
    if (req.method === "GET" && assets[route]) {
      const [file, type] = assets[route];
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      res.end(await readFile(path.join(base, "public", file)));
      return;
    }
    json(res, 404, { error: "Not found." });
  } catch (error) {
    json(res, 400, { error: error.message });
  }
});
server.listen(Number(process.env.PORT || 4310), "127.0.0.1", () =>
  console.log(`Cadence is ready at http://127.0.0.1:${server.address().port}`),
);
function shutdown() {
  clearInterval(ticker);
  clearInterval(stream);
  harness.close();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
