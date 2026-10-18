import { WebSocketServer, type WebSocket } from "ws";
import net from "net";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { timingSafeEqual } from "crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const NOVNC = path.join(ROOT, "node_modules", "@novnc", "novnc");

// tsx does not load .env files; read .env.local directly so `npm run dev` just works.
function loadEnvFile(file: string) {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, ".env.local"));

const PORT = Number(process.env.PORT ?? 6080);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.PROXY_TOKEN ?? "";
// Optional: comma-separated hostnames allowed as targets. Empty = any host.
const ALLOW_HOSTS = new Set(
  (process.env.ALLOW_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const MAX_CONNECTIONS = 8;
const CONNECT_TIMEOUT_MS = 10_000;
const HIGH_WATER = 1 << 20; // pause the peer once 1 MiB is queued
const LOW_WATER = 1 << 18; // resume once it drains below 256 KiB

if (!TOKEN) {
  console.error(
    "PROXY_TOKEN is not set. Put PROXY_TOKEN=<some secret> in .env.local, " +
      "or start with it set in the environment.",
  );
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function safeTokenEqual(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// host:port, where host is a hostname/IPv4 or a bracketed IPv6 literal.
function parseTarget(target: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(target);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ""), port };
}

function serveFile(res: http.ServerResponse, file: string) {
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

function inside(base: string, file: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---------- saved connections (connections/connections.json) ----------

const CONNECTIONS_DIR = path.join(ROOT, "connections");
const CONNECTIONS_FILE = path.join(CONNECTIONS_DIR, "connections.json");
const MAX_BODY = 16 * 1024;

type Connection = { host: string; port: number; label: string; at: number };

const HOST_RE = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]{1,253})$/;

function normalizeEntry(raw: unknown): Connection | null {
  if (!raw || typeof raw !== "object") return null;
  const { host, port, label, at } = raw as Record<string, unknown>;
  const p = Number(port);
  if (typeof host !== "string" || !HOST_RE.test(host)) return null;
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  return {
    host,
    port: p,
    label: typeof label === "string" ? label.slice(0, 100) : "",
    at: typeof at === "number" ? at : Date.now(),
  };
}

async function readConnections(): Promise<Connection[]> {
  let text: string;
  try {
    text = await fs.promises.readFile(CONNECTIONS_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.map(normalizeEntry).filter((e): e is Connection => e !== null);
  } catch {
    // A hand-edited or corrupt file must not take the server down.
    console.error(`Ignoring malformed ${CONNECTIONS_FILE}`);
    return [];
  }
}

// Serialize writes and replace atomically so a crash cannot truncate the file.
let writeChain: Promise<unknown> = Promise.resolve();

function writeConnections(list: Connection[]): Promise<void> {
  const run = writeChain.then(async () => {
    await fs.promises.mkdir(CONNECTIONS_DIR, { recursive: true });
    const tmp = `${CONNECTIONS_FILE}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(list, null, 2)}\n`, "utf8");
    await fs.promises.rename(tmp, CONNECTIONS_FILE);
  });
  writeChain = run.catch(() => {});
  return run;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleConnectionsApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  // The page sends the shared token in a header, never in a URL.
  const headerToken = req.headers["x-proxy-token"];
  if (!safeTokenEqual(typeof headerToken === "string" ? headerToken : null)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    if (req.method === "GET") {
      sendJson(res, 200, await readConnections());
      return;
    }

    if (req.method === "POST") {
      const entry = normalizeEntry(JSON.parse(await readBody(req)));
      if (!entry) {
        sendJson(res, 400, { error: "invalid connection" });
        return;
      }
      const list = await readConnections();
      const i = list.findIndex((e) => e.host === entry.host && e.port === entry.port);
      if (i >= 0) {
        // Keep the old label when the update arrives without one.
        list[i] = { ...list[i], ...(entry.label ? { label: entry.label } : {}), at: Date.now() };
      } else {
        list.unshift({ ...entry, at: Date.now() });
      }
      await writeConnections(list);
      sendJson(res, 200, list);
      return;
    }

    if (req.method === "PUT") {
      // Edit in place: identify by the current host:port in the query string,
      // replace it with the (validated) entry from the body.
      const fromHost = url.searchParams.get("host") ?? "";
      const fromPort = Number(url.searchParams.get("port"));
      if (!HOST_RE.test(fromHost) || !Number.isInteger(fromPort)) {
        sendJson(res, 400, { error: "invalid connection" });
        return;
      }

      const updated = normalizeEntry(JSON.parse(await readBody(req)));
      if (!updated) {
        sendJson(res, 400, { error: "invalid connection" });
        return;
      }

      const list = await readConnections();
      const i = list.findIndex((e) => e.host === fromHost && e.port === fromPort);
      if (i < 0) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      // Refuse an edit that would collide with a different saved entry.
      const clash = list.findIndex(
        (e, j) => j !== i && e.host === updated.host && e.port === updated.port,
      );
      if (clash >= 0) {
        sendJson(res, 409, { error: "a connection with that address already exists" });
        return;
      }

      list[i] = { ...updated, at: Date.now() };
      await writeConnections(list);
      sendJson(res, 200, list);
      return;
    }

    if (req.method === "DELETE") {
      const host = url.searchParams.get("host") ?? "";
      const port = Number(url.searchParams.get("port"));
      if (!HOST_RE.test(host) || !Number.isInteger(port)) {
        sendJson(res, 400, { error: "invalid connection" });
        return;
      }
      const list = (await readConnections()).filter(
        (e) => !(e.host === host && e.port === port),
      );
      await writeConnections(list);
      sendJson(res, 200, list);
      return;
    }

    res.writeHead(405, { Allow: "GET, POST, PUT, DELETE" }).end();
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

const server = http.createServer((req, res) => {
  let url: URL;
  let pathname: string;
  try {
    url = new URL(req.url!, "http://x");
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("bad request");
    return;
  }

  if (pathname === "/api/connections") {
    void handleConnectionsApi(req, res, url);
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    fs.readFile(path.join(PUBLIC, "index.html"), "utf8", (err, html) => {
      if (err) {
        res.writeHead(500).end("UI not built");
        return;
      }
      // The page gets its own token so it can open the WebSocket.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Function replacement: a token containing `$` must stay literal.
      res.end(html.replace("__PROXY_TOKEN__", () => TOKEN));
    });
    return;
  }

  // noVNC is served straight out of node_modules; no bundler needed.
  const file =
    pathname === "/app.js" || pathname === "/styles.css"
      ? path.join(PUBLIC, pathname)
      : pathname.startsWith("/vendor/novnc/")
        ? path.join(NOVNC, pathname.slice("/vendor/novnc/".length))
        : null;

  if (file && inside(file.startsWith(NOVNC) ? NOVNC : PUBLIC, file)) {
    serveFile(res, file);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 << 20 });
let connections = 0;

wss.on("connection", (ws: WebSocket, req) => {
  // Cross-site WebSocket hijacking guard: only same-origin pages may connect.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) {
    ws.close(1008, "origin not allowed");
    return;
  }

  const q = new URL(req.url!, "http://x").searchParams;
  const target = q.get("target") ?? "";
  if (!safeTokenEqual(q.get("token"))) return ws.close(1008, "unauthorized");

  const parsed = parseTarget(target);
  if (!parsed) return ws.close(1008, "invalid target");
  if (ALLOW_HOSTS.size > 0 && !ALLOW_HOSTS.has(parsed.host.toLowerCase())) {
    return ws.close(1008, "host not allowed");
  }
  if (connections >= MAX_CONNECTIONS) return ws.close(1013, "too many connections");

  connections++;
  const tcp = net.connect({ host: parsed.host, port: parsed.port });
  tcp.setNoDelay(true);
  tcp.setTimeout(CONNECT_TIMEOUT_MS);
  let open = false;

  tcp.on("connect", () => {
    open = true;
    tcp.setTimeout(0);
  });
  tcp.on("data", (d) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(d);
    if (ws.bufferedAmount > HIGH_WATER) {
      tcp.pause();
      // ws has no drain event; poll until the socket drains, then resume.
      const wait = () => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount < LOW_WATER) tcp.resume();
        else setTimeout(wait, 25);
      };
      setTimeout(wait, 25);
    }
  });
  tcp.on("timeout", () => {
    ws.close(1011, "connect timeout");
    tcp.destroy();
  });
  tcp.on("end", () => ws.close());
  tcp.on("error", () => ws.close(open ? 1011 : 1013, "upstream error"));
  tcp.on("close", () => ws.close());

  ws.on("message", (d) => {
    tcp.write(d as Buffer);
    if (tcp.writableLength > HIGH_WATER) ws.pause();
  });
  tcp.on("drain", () => {
    if (tcp.writableLength < LOW_WATER) ws.resume();
  });
  ws.on("error", () => tcp.destroy());
  ws.on("close", () => {
    if (!tcp.destroyed) tcp.destroy();
    connections = Math.max(0, connections - 1);
  });
});

wss.on("error", (err) => {
  console.error("WebSocket server error:", err.message);
});

server.on("error", (err) => {
  console.error(`Cannot listen on ${HOST}:${PORT}:`, err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`VNC relay on http://${HOST}:${PORT}  (targets any host:port, token required)`);
});

process.on("SIGINT", () => {
  wss.close();
  server.close(() => process.exit(0));
});
