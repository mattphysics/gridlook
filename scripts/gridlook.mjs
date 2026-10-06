#!/usr/bin/env node
/**
 * gridlook — one-command launcher for viewing a local dataset.
 *
 * Detects whether the given path is a zarr store or a gribscan/kerchunk
 * parquet reference, starts the matching data server plus the gridlook app
 * server, and opens the browser at the correct URL.
 *
 * By default the app is served as a production build (bundled, compressed,
 * cacheable), which loads much faster over slow links such as VS Code port
 * forwarding. The build is redone automatically when the sources change.
 * Use --dev for the Vite dev server with hot reload.
 *
 * Usage:
 *   gridlook <path-to-dataset> [options]
 *
 * Options:
 *   --port <n>       Preferred app port (default: per login node, see below)
 *   --dev            Use the Vite dev server (hot reload) instead of a build
 *   --verbose        Log every request the browser makes (not with --dev)
 *   --new            Always start a new instance (see below)
 *
 * If a gridlook is already running on the preferred port, a zarr dataset is
 * opened through that instance instead of starting another one: it serves the
 * whole filesystem, so any store can be viewed through it. This keeps a single
 * port (and a single VS Code port forward) for any number of datasets.
 * Parquet datasets and --dev always start their own instance.
 *
 * The default app port depends on the machine (3700 + node number, e.g.
 * ac6-102 -> 3702; if busy 3802, 3902, ...). Several VS Code windows connected
 * to different login nodes share the laptop's localhost, and whichever window
 * forwards a port first owns it; per-node ports keep them from colliding.
 *   --python <bin>   Python interpreter for the parquet proxy
 *                    (default: $GRIDLOOK_PYTHON or "python3")
 *   --root <dir>     Filesystem root the zarr HTTP server serves (default: "/")
 *   --no-open        Do not open the browser automatically
 *   -h, --help       Show this help
 *
 * Examples:
 *   gridlook /data/era5/an_daymean.zarr
 *   gridlook /data/hourly.parq
 */

import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PROXY_SCRIPT = path.join(__dirname, "zarr_parquet_proxy.py");
const VITE_BIN = path.join(
  PROJECT_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vite.cmd" : "vite"
);
// Production build used by the default (non --dev) mode. Kept out of `dist/`
// so it never interferes with a deployment build.
const BUILD_DIR = path.join(
  PROJECT_ROOT,
  "node_modules",
  ".cache",
  "gridlook-dist"
);
const BUILD_STAMP = path.join(BUILD_DIR, ".gridlook-build-stamp");
// Everything whose modification should trigger a rebuild.
const BUILD_INPUTS = [
  "src",
  "public",
  "index.html",
  "vite.config.ts",
  "package-lock.json",
];

function printHelp() {
  // Print the leading JSDoc-style banner as help text.
  console.log(
    [
      "gridlook — one-command launcher for viewing a local dataset.",
      "",
      "Usage:",
      "  gridlook <path-to-dataset> [options]",
      "",
      "Options:",
      `  --port <n>       Preferred app port (default here: ${defaultPort()})`,
      "  --dev            Use the Vite dev server (hot reload) instead of a build",
      "  --verbose        Log every request the browser makes (not with --dev)",
      "  --new            Start a new instance even if one is already running",
      "",
      "A zarr dataset is opened through an already running gridlook on the",
      "preferred port, if there is one, instead of starting another instance.",
      "  --python <bin>   Python interpreter for the parquet proxy",
      '                   (default: $GRIDLOOK_PYTHON or "python3")',
      '  --root <dir>     Filesystem root the zarr HTTP server serves (default: "/")',
      "  --no-open        Do not open the browser automatically",
      "  -h, --help       Show this help",
      "",
      "Examples:",
      "  gridlook /data/era5/an_daymean.zarr",
      "  gridlook /data/hourly.parq",
    ].join("\n")
  );
}

function parseArgs(argv) {
  const opts = {
    dataset: undefined,
    port: undefined,
    python: process.env.GRIDLOOK_PYTHON || "python3",
    root: "/",
    open: true,
    dev: false,
    verbose: false,
    reuse: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      case "--port":
        opts.port = parseInt(argv[++i], 10);
        break;
      case "--python":
        opts.python = argv[++i];
        break;
      case "--root":
        opts.root = argv[++i];
        break;
      case "--no-open":
        opts.open = false;
        break;
      case "--dev":
        opts.dev = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--new":
        opts.reuse = false;
        break;
      default:
        if (arg.startsWith("-")) {
          fail(`Unknown option: ${arg}`);
        } else if (opts.dataset === undefined) {
          opts.dataset = arg;
        } else {
          fail(`Unexpected extra argument: ${arg}`);
        }
    }
  }
  if (!opts.dataset) {
    printHelp();
    process.exit(1);
  }
  if (opts.port === undefined) {
    opts.port = defaultPort();
    opts.portStep = 100; // stay in this node's range (37NN, 38NN, ...)
  } else if (!Number.isInteger(opts.port) || opts.port <= 0) {
    fail("--port must be a positive integer");
  }
  return opts;
}

function fail(message) {
  console.error(`gridlook: ${message}`);
  process.exit(1);
}

/**
 * Decide whether a path is a zarr store or a parquet reference.
 * Returns "zarr" | "parquet".
 */
function detectDatasetType(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    fail(`Dataset not found: ${absPath}`);
  }

  const lower = absPath.toLowerCase();

  if (stat.isFile()) {
    if (lower.endsWith(".parq") || lower.endsWith(".parquet")) {
      return "parquet";
    }
    fail(
      `Unrecognized dataset file: ${absPath}\n` +
        "Expected a .parq/.parquet file or a .zarr directory."
    );
  }

  if (stat.isDirectory()) {
    // Parquet reference stores are directories (e.g. ".parq"/".parquet").
    // Check this before the zarr markers below, since such stores can also
    // contain a ".zmetadata" file and would otherwise be misdetected as zarr.
    if (lower.endsWith(".parq") || lower.endsWith(".parquet")) {
      return "parquet";
    }
    if (lower.endsWith(".zarr")) {
      return "zarr";
    }
    const markers = [".zgroup", ".zarray", ".zmetadata", "zarr.json"];
    if (markers.some((m) => fs.existsSync(path.join(absPath, m)))) {
      return "zarr";
    }
    fail(
      `Directory does not look like a zarr store: ${absPath}\n` +
        "Expected a .zarr suffix or one of .zgroup/.zmetadata/zarr.json inside."
    );
  }

  fail(`Unsupported path type: ${absPath}`);
}

/** Find a free TCP port, preferring `preferred`, then scanning upward. */
/**
 * Default app port for this machine: 3700 + the trailing number of the short
 * hostname (mod 100), e.g. ac6-102 -> 3702, or a stable hash for other names.
 * Avoids 3000, which local dev servers often occupy.
 */
function defaultPort() {
  const host = os.hostname().split(".")[0];
  const match = host.match(/(\d+)$/);
  let n;
  if (match) {
    n = Number(match[1]) % 100;
  } else {
    n = 0;
    for (const ch of host) n = (n * 31 + ch.charCodeAt(0)) % 100;
  }
  return 3700 + n;
}

function findFreePort(preferred, step = 1) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attemptsLeft) => {
      const server = net.createServer();
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryPort(port + step, attemptsLeft - 1);
        } else if (err.code === "EADDRINUSE") {
          // Fall back to an OS-assigned ephemeral port.
          const anyServer = net.createServer();
          anyServer.once("error", reject);
          anyServer.listen(0, "127.0.0.1", () => {
            const { port: freePort } = anyServer.address();
            anyServer.close(() => resolve(freePort));
          });
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        const { port: freePort } = server.address();
        server.close(() => resolve(freePort));
      });
    };
    tryPort(preferred, step === 1 ? 50 : 20);
  });
}

/** Wait until something is accepting TCP connections on `port`. */
function waitForPort(port, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "localhost");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for port ${port}`));
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    };
    attempt();
  });
}

/**
 * Static file server with full HTTP Range request support.
 * Replaces `python -m http.server` which ignores Range headers, breaking
 * sharding_indexed zarr v3 stores that need suffix range reads for shard
 * index decoding.
 *
 * Returns a ChildProcess-compatible object so the rest of main() can manage
 * it identically to the parquet proxy child process.
 */
function startZarrFileServer(root, port) {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    // Decode and sanitise the path — prevent path-traversal attacks.
    let relPath;
    try {
      relPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400, CORS);
      res.end();
      return;
    }
    const absFilePath = path.resolve(root, "." + relPath);
    const resolvedRoot = path.resolve(root);
    const rootPrefix = resolvedRoot.endsWith(path.sep)
      ? resolvedRoot
      : resolvedRoot + path.sep;
    if (!absFilePath.startsWith(rootPrefix) && absFilePath !== resolvedRoot) {
      res.writeHead(403, CORS);
      res.end();
      return;
    }

    fs.stat(absFilePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        res.writeHead(404, CORS);
        res.end();
        return;
      }

      const fileSize = stat.size;
      const rangeHeader = req.headers["range"];

      if (!rangeHeader) {
        // Full file response.
        res.writeHead(200, {
          ...CORS,
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
          "Content-Type": "application/octet-stream",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(absFilePath).pipe(res);
        return;
      }

      // Parse Range header.  Supports bytes=A-B and bytes=-N (suffix).
      const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        res.writeHead(416, { ...CORS, "Content-Range": `bytes */${fileSize}` });
        res.end();
        return;
      }

      let start, end;
      if (match[1] === "") {
        // Suffix range: bytes=-N
        const suffixLen = parseInt(match[2], 10);
        start = Math.max(0, fileSize - suffixLen);
        end = fileSize - 1;
      } else {
        start = parseInt(match[1], 10);
        end = match[2] !== "" ? parseInt(match[2], 10) : fileSize - 1;
      }

      if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
        res.writeHead(416, { ...CORS, "Content-Range": `bytes */${fileSize}` });
        res.end();
        return;
      }

      const chunkSize = end - start + 1;
      res.writeHead(206, {
        ...CORS,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": String(chunkSize),
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(absFilePath, { start, end }).pipe(res);
    });
  });

  server.listen(port, "127.0.0.1");

  // Return a ChildProcess-like object for uniform lifecycle management.
  const errorHandlers = [];
  const exitHandlers = [];
  server.on("error", (err) => {
    for (const h of errorHandlers) h(err);
  });
  return {
    killed: false,
    kill() {
      this.killed = true;
      server.close();
      for (const h of exitHandlers) h(0);
    },
    on(event, handler) {
      if (event === "error") errorHandlers.push(handler);
      else if (event === "exit") exitHandlers.push(handler);
      return this;
    },
  };
}

/** Latest modification time (ms) of a file or anything below a directory. */
function newestMtime(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target)) {
    newest = Math.max(newest, newestMtime(path.join(target, entry)));
  }
  return newest;
}

/**
 * Make sure BUILD_DIR holds a production build of the current sources,
 * rebuilding when any of BUILD_INPUTS changed since the last build.
 * Builds into a temporary directory first so a concurrently running
 * gridlook never sees a half-written build.
 */
function ensureBuild() {
  let builtAt = 0;
  try {
    builtAt = fs.statSync(BUILD_STAMP).mtimeMs;
  } catch {
    // no build yet
  }
  const sourcesAt = Math.max(
    ...BUILD_INPUTS.map((p) => newestMtime(path.join(PROJECT_ROOT, p)))
  );
  if (builtAt > sourcesAt) {
    return;
  }

  console.log(
    builtAt
      ? "Sources changed, rebuilding gridlook ..."
      : "Building gridlook (first run) ..."
  );
  const tmpDir = `${BUILD_DIR}.tmp-${process.pid}`;
  const result = spawnSync(
    VITE_BIN,
    ["build", "--outDir", tmpDir, "--emptyOutDir", "--logLevel", "error"],
    { cwd: PROJECT_ROOT, stdio: "inherit" }
  );
  if (result.status !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fail(
      "production build failed (see output above); " +
        "fix the error or run with --dev"
    );
  }
  fs.writeFileSync(path.join(tmpDir, path.basename(BUILD_STAMP)), "");
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.renameSync(tmpDir, BUILD_DIR);
}

const INFO_PATH = "/__gridlook/info";

/** Ask whatever listens on `port` whether it is a gridlook app server. */
function probeGridlook(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: INFO_PATH, timeout: 1000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const info = JSON.parse(body);
            resolve(info?.gridlook === true ? info : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function datasetUrl(port, type, absPath) {
  const base = `http://localhost:${port}`;
  return type === "zarr"
    ? `${base}/#/localdata${absPath}`
    : `${base}/#/parqproxy/`;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".geojson",
  ".map",
  ".svg",
  ".wasm",
  ".txt",
]);

/**
 * Serve the production build from `distDir`, compressed (brotli/gzip) and
 * with long-lived caching for Vite's content-hashed `assets/`. Requests under
 * a key of `proxies` (e.g. "/localdata") are forwarded to that local port
 * with the prefix stripped, mirroring the Vite dev server proxy config.
 *
 * Returns a ChildProcess-like object, like startZarrFileServer.
 */
function startAppServer(
  distDir,
  port,
  proxies,
  { verbose = false, info = {} } = {}
) {
  const resolvedDist = path.resolve(distDir);
  // Compressed bodies, keyed by "<encoding>:<path>:<mtime>".
  const compressedCache = new Map();

  function proxy(req, res, prefix, targetPort) {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url.slice(prefix.length) || "/",
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
      }
      res.end();
    });
    req.pipe(upstream);
  }

  function pickEncoding(req, ext) {
    if (!COMPRESSIBLE.has(ext)) {
      return null;
    }
    const accepted = String(req.headers["accept-encoding"] ?? "");
    if (/\bbr\b/.test(accepted)) return "br";
    if (/\bgzip\b/.test(accepted)) return "gzip";
    return null;
  }

  function compress(encoding, filePath, stat, callback) {
    const key = `${encoding}:${filePath}:${stat.mtimeMs}`;
    const cached = compressedCache.get(key);
    if (cached) {
      callback(null, cached);
      return;
    }
    fs.readFile(filePath, (readErr, raw) => {
      if (readErr) {
        callback(readErr);
        return;
      }
      const done = (err, body) => {
        if (!err) compressedCache.set(key, body);
        callback(err, body);
      };
      if (encoding === "br") {
        zlib.brotliCompress(
          raw,
          {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          },
          done
        );
      } else {
        zlib.gzip(raw, { level: 6 }, done);
      }
    });
  }

  let browserSeen = false;
  const server = http.createServer((req, res) => {
    if (req.url === INFO_PATH) {
      // Lets a later `gridlook` invocation find and reuse this instance.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          gridlook: true,
          host: os.hostname(),
          pid: process.pid,
          ...info,
        })
      );
      return;
    }
    if (!browserSeen) {
      // Confirms the browser reaches us; if this never shows up, the problem
      // is between browser and server (e.g. VS Code port forwarding).
      browserSeen = true;
      console.log(`Browser connected (${req.socket.remoteAddress}).`);
    }
    if (verbose) {
      const started = Date.now();
      let bytes = 0;
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      res.write = (chunk, ...rest) => {
        if (chunk) bytes += chunk.length;
        return write(chunk, ...rest);
      };
      res.end = (chunk, ...rest) => {
        if (chunk && typeof chunk !== "function") bytes += chunk.length;
        return end(chunk, ...rest);
      };
      const log = (what) =>
        console.log(
          `${new Date().toISOString().slice(11, 23)} ${what} ` +
            `${String(Date.now() - started).padStart(6)}ms ` +
            `${(bytes / 1e6).toFixed(2).padStart(7)}MB ${req.url.slice(0, 160)}`
        );
      res.on("finish", () => log(res.statusCode));
      res.on("close", () => {
        if (!res.writableFinished) log("ABORTED");
      });
    }
    for (const [prefix, targetPort] of Object.entries(proxies)) {
      if (req.url === prefix || req.url.startsWith(prefix + "/")) {
        proxy(req, res, prefix, targetPort);
        return;
      }
    }

    let relPath;
    try {
      relPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (relPath.endsWith("/")) {
      relPath += "index.html";
    }
    const filePath = path.resolve(resolvedDist, "." + relPath);
    if (!filePath.startsWith(resolvedDist + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }

    fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const headers = {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        // Vite content-hashes everything under assets/, so it never changes.
        "Cache-Control": relPath.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        ETag: etag,
        Vary: "Accept-Encoding",
      };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }

      const encoding = pickEncoding(req, ext);
      if (!encoding) {
        res.writeHead(200, { ...headers, "Content-Length": String(stat.size) });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      compress(encoding, filePath, stat, (err, body) => {
        if (err) {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200, {
          ...headers,
          "Content-Encoding": encoding,
          "Content-Length": String(body.length),
        });
        res.end(req.method === "HEAD" ? undefined : body);
      });
    });
  });

  server.listen(port, "127.0.0.1");

  const errorHandlers = [];
  const exitHandlers = [];
  server.on("error", (err) => {
    for (const h of errorHandlers) h(err);
  });
  return {
    killed: false,
    get browserSeen() {
      return browserSeen;
    },
    kill() {
      this.killed = true;
      server.close();
      for (const h of exitHandlers) h(0);
    },
    on(event, handler) {
      if (event === "error") errorHandlers.push(handler);
      else if (event === "exit") exitHandlers.push(handler);
      return this;
    },
  };
}

/**
 * Explain what to do when the browser never reaches the app server. With VS
 * Code remote, stale entries in the Ports panel can map the opened local port
 * to a different (dead) remote port, so the page just stays black.
 */
function printNoBrowserHint(port, hashPath) {
  const host = os.hostname().split(".")[0];
  const lines = [
    "",
    `gridlook: no request from a browser has reached port ${port} on ${host} yet.`,
    "If the page stays black/loading, the browser is talking to something else.",
    "This always works: on your laptop, tunnel to this node",
    `  ssh -L ${port}:localhost:${port} ${host}   (+ your usual jump/user options)`,
    `and open  http://localhost:${port}/${hashPath}`,
  ];
  if (process.env.VSCODE_IPC_HOOK_CLI) {
    lines.push(
      "With VS Code remote, the window's port forward may lead to another node",
      "(windows on a load-balanced login name can reconnect to a different one).",
      "Pin VS Code to one node in your laptop's ~/.ssh/config to avoid this."
    );
  }
  lines.push('Details: docs/local-usage.md, section "Remote use".');
  console.log(lines.join("\n") + "\n");
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.log(`Could not open browser automatically. Open: ${url}`);
  });
  child.unref();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const absPath = path.resolve(opts.dataset);
  const type = detectDatasetType(absPath);
  if (!opts.dev) {
    ensureBuild();
  }

  // 0. Reuse a running instance for zarr: it can serve any store below its root.
  if (type === "zarr" && opts.reuse && !opts.dev) {
    const running = await probeGridlook(opts.port);
    if (running?.type === "zarr" && running.root === path.resolve(opts.root)) {
      const url = datasetUrl(opts.port, type, absPath);
      console.log(
        `Using the gridlook already running on port ${opts.port} ` +
          `(pid ${running.pid}); its terminal shows the server output.\n` +
          `\nOpen:\n  ${url}\n\n` +
          "(Use --new to start a separate instance instead.)"
      );
      if (opts.open) {
        openBrowser(url);
      }
      return;
    }
  }

  const children = [];
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // 1. Choose ports up front so we can build the exact URL.
  const vitePort = await findFreePort(opts.port, opts.portStep ?? 1);
  const dataPort = await findFreePort(type === "parquet" ? 9091 : 8080);

  // 2. Start the data server.
  let dataServer;
  let dataReadyPort = dataPort;
  if (type === "zarr") {
    console.log(
      `Serving filesystem from "${opts.root}" on port ${dataPort} ...`
    );
    dataServer = startZarrFileServer(opts.root, dataPort);
  } else {
    console.log(
      `Starting parquet proxy for ${absPath} on port ${dataPort} ...`
    );
    dataServer = spawn(opts.python, [PROXY_SCRIPT, absPath, String(dataPort)], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
  }
  dataServer.on("error", (err) => {
    console.error(`gridlook: failed to start data server: ${err.message}`);
    shutdown(1);
  });
  dataServer.on("exit", (code) => {
    if (!shuttingDown && code !== 0) {
      console.error(`gridlook: data server exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });
  children.push(dataServer);

  // 3. Start the app server: a production build, or Vite with --dev. Both
  // proxy /localdata or /parqproxy to the data server.
  let app;
  if (opts.dev) {
    const env = { ...process.env };
    if (type === "zarr") {
      env.ZARR_PORT = String(dataReadyPort);
    } else {
      env.PARQ_PORT = String(dataReadyPort);
    }
    console.log(`Starting gridlook dev server on port ${vitePort} ...`);
    app = spawn(VITE_BIN, ["--port", String(vitePort), "--strictPort"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env,
    });
  } else {
    console.log(`Serving gridlook build on port ${vitePort} ...`);
    const proxyPrefix = type === "zarr" ? "/localdata" : "/parqproxy";
    app = startAppServer(
      BUILD_DIR,
      vitePort,
      { [proxyPrefix]: dataReadyPort },
      {
        verbose: opts.verbose,
        info: { type, root: path.resolve(opts.root) },
      }
    );
  }
  app.on("error", (err) => {
    console.error(`gridlook: failed to start app server: ${err.message}`);
    shutdown(1);
  });
  app.on("exit", (code) => {
    if (!shuttingDown) {
      shutdown(code ?? 0);
    }
  });
  children.push(app);

  // 4. Wait for the app server, then build the URL and open the browser.
  try {
    await waitForPort(vitePort);
  } catch (err) {
    console.error(`gridlook: ${err.message}`);
    shutdown(1);
  }

  const base = `http://localhost:${vitePort}`;
  const url = datasetUrl(vitePort, type, absPath);

  console.log(`\nGridlook is ready:\n  ${url}\n`);
  if (opts.open) {
    openBrowser(url);
  }
  console.log("Press Ctrl+C to stop.");

  if (!opts.dev) {
    setTimeout(() => {
      if (!app.browserSeen) {
        printNoBrowserHint(vitePort, url.slice(base.length + 1));
      }
    }, 20000).unref();
  }
}

main().catch((err) => {
  console.error(`gridlook: ${err.stack || err.message}`);
  process.exit(1);
});
