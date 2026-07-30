#!/usr/bin/env node
/**
 * Static file server with HTTP Range request support.
 *
 * Replaces `python3 -m http.server` for zarr datasets.  Python's built-in
 * server ignores Range headers, which breaks sharding_indexed zarr v3 stores
 * because zarrita needs suffix range reads to decode the shard index.
 *
 * Usage:
 *   node scripts/zarr_file_server.mjs [root] [port]
 *
 * Defaults:
 *   root  /          (same default as `python3 -m http.server` run from /)
 *   port  8080
 *
 * Examples:
 *   node scripts/zarr_file_server.mjs / 8887
 *   node scripts/zarr_file_server.mjs /data 8080
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? "/");
const port = parseInt(process.argv[3] ?? "8080", 10);

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

server.listen(port, "127.0.0.1", () => {
  console.log(`Serving "${root}" on http://127.0.0.1:${port}`);
});

server.on("error", (err) => {
  console.error(`zarr_file_server: ${err.message}`);
  process.exit(1);
});
