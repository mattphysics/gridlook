#!/usr/bin/env node
/**
 * gridlook — one-command launcher for viewing a local dataset.
 *
 * Detects whether the given path is a zarr store or a gribscan/kerchunk
 * parquet reference, starts the matching data server plus the Vite dev
 * server, and opens the browser at the correct URL.
 *
 * Usage:
 *   gridlook <path-to-dataset> [options]
 *
 * Options:
 *   --port <n>       Preferred Vite port (default: 3000)
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

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PROXY_SCRIPT = path.join(__dirname, "zarr_parquet_proxy.py");
const VITE_BIN = path.join(
  PROJECT_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vite.cmd" : "vite"
);

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
      "  --port <n>       Preferred Vite port (default: 3000)",
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
    port: 3000,
    python: process.env.GRIDLOOK_PYTHON || "python3",
    root: "/",
    open: true,
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
  if (!Number.isInteger(opts.port) || opts.port <= 0) {
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
function findFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attemptsLeft) => {
      const server = net.createServer();
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryPort(port + 1, attemptsLeft - 1);
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
    tryPort(preferred, 50);
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
  const vitePort = await findFreePort(opts.port);
  const dataPort = await findFreePort(type === "parquet" ? 9091 : 8080);

  // 2. Start the data server.
  let dataServer;
  let dataReadyPort = dataPort;
  if (type === "zarr") {
    console.log(`Serving filesystem from "${opts.root}" on port ${dataPort} ...`);
    dataServer = spawn(
      opts.python,
      ["-m", "http.server", String(dataPort)],
      { cwd: opts.root, stdio: "inherit" }
    );
  } else {
    console.log(`Starting parquet proxy for ${absPath} on port ${dataPort} ...`);
    dataServer = spawn(
      opts.python,
      [PROXY_SCRIPT, absPath, String(dataPort)],
      { cwd: PROJECT_ROOT, stdio: "inherit" }
    );
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

  // 3. Start Vite with the matching proxy port in its environment.
  const env = { ...process.env };
  if (type === "zarr") {
    env.ZARR_PORT = String(dataReadyPort);
  } else {
    env.PARQ_PORT = String(dataReadyPort);
  }
  console.log(`Starting gridlook dev server on port ${vitePort} ...`);
  const vite = spawn(
    VITE_BIN,
    ["--port", String(vitePort), "--strictPort"],
    { cwd: PROJECT_ROOT, stdio: "inherit", env }
  );
  vite.on("error", (err) => {
    console.error(`gridlook: failed to start Vite: ${err.message}`);
    shutdown(1);
  });
  vite.on("exit", (code) => {
    if (!shuttingDown) {
      shutdown(code ?? 0);
    }
  });
  children.push(vite);

  // 4. Wait for Vite, then build the URL and open the browser.
  try {
    await waitForPort(vitePort);
  } catch (err) {
    console.error(`gridlook: ${err.message}`);
    shutdown(1);
  }

  const base = `http://localhost:${vitePort}`;
  const url =
    type === "zarr"
      ? `${base}/#/localdata${absPath}`
      : `${base}/#/parqproxy/`;

  console.log(`\nGridlook is ready:\n  ${url}\n`);
  if (opts.open) {
    openBrowser(url);
  }
  console.log("Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error(`gridlook: ${err.stack || err.message}`);
  process.exit(1);
});
