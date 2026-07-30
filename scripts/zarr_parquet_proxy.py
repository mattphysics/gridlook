#!/usr/bin/env python3
"""
Zarr proxy server for gribscan/kerchunk parquet reference stores.

Serves GRIB-backed zarr data as plain uncompressed zarr v2 over HTTP,
so any zarr client (including gridlook/zarrita in the browser) can read it.

GRIB chunks are decompressed server-side using zarr-python + gribscan.

Usage:
    python zarr_parquet_proxy.py <parq_path> [port]

Example:
    python zarr_parquet_proxy.py /ec/ws2/.../hourly.parq 9090

Then open in gridlook:
    http://localhost:3000/#/parqproxy/
"""

import sys
import json
import asyncio
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import fsspec
import zarr
from aiohttp import web


CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
}

_executor = ThreadPoolExecutor(max_workers=4)


def load_store(parq_path: str):
    fs = fsspec.filesystem("reference", fo=parq_path)
    mapper = fs.get_mapper("")
    z = zarr.open_group(mapper, mode="r")
    return mapper, z


def patch_zarray(meta: dict) -> dict:
    meta = dict(meta)
    meta["compressor"] = None
    meta["filters"] = None
    if "dimension_separator" not in meta:
        meta["dimension_separator"] = "."
    return meta


def patch_zmetadata(raw: bytes) -> bytes:
    meta = json.loads(raw)
    meta["zarr_consolidated_format"] = 1  # required by zarrita
    for key, val in meta.get("metadata", {}).items():
        if key.endswith(".zarray") and isinstance(val, dict):
            meta["metadata"][key] = patch_zarray(val)
    return json.dumps(meta).encode()


def _read_chunk_sync(z, var_path: str, chunk_idx: tuple) -> bytes:
    arr = z[var_path]
    slices = tuple(
        slice(ci * cs, min((ci + 1) * cs, s))
        for ci, cs, s in zip(chunk_idx, arr.chunks, arr.shape)
    )
    chunk = arr[slices]
    return chunk.astype(arr.dtype, copy=False).tobytes()


def make_app(parq_path: str) -> web.Application:
    print(f"Loading {parq_path} ...", flush=True)
    mapper, z = load_store(parq_path)
    print("Loaded. Ready.", flush=True)

    async def handle(request: web.Request) -> web.Response:
        if request.method == "OPTIONS":
            return web.Response(headers=CORS_HEADERS)

        key = request.match_info["key"].lstrip("/")

        if key == ".zmetadata":
            try:
                return web.Response(
                    body=patch_zmetadata(mapper[".zmetadata"]),
                    content_type="application/json",
                    headers=CORS_HEADERS,
                )
            except KeyError:
                return web.Response(status=404, headers=CORS_HEADERS)

        if key.endswith(".zarray"):
            try:
                meta = patch_zarray(json.loads(mapper[key]))
                return web.Response(
                    body=json.dumps(meta).encode(),
                    content_type="application/json",
                    headers=CORS_HEADERS,
                )
            except KeyError:
                return web.Response(status=404, headers=CORS_HEADERS)

        if key.endswith((".zattrs", ".zgroup")):
            try:
                return web.Response(
                    body=mapper[key],
                    content_type="application/json",
                    headers=CORS_HEADERS,
                )
            except KeyError:
                return web.Response(status=404, headers=CORS_HEADERS)

        # Chunk key: "varname/c0.c1"
        slash = key.rfind("/")
        if slash < 0:
            return web.Response(status=404, headers=CORS_HEADERS)

        var_path = key[:slash]
        chunk_str = key[slash + 1:]

        try:
            chunk_idx = tuple(int(c) for c in chunk_str.split("."))
        except ValueError:
            return web.Response(status=404, headers=CORS_HEADERS)

        try:
            loop = asyncio.get_event_loop()
            raw = await loop.run_in_executor(
                _executor, _read_chunk_sync, z, var_path, chunk_idx
            )
            return web.Response(
                body=raw,
                content_type="application/octet-stream",
                headers={**CORS_HEADERS, "Content-Length": str(len(raw))},
            )
        except KeyError:
            return web.Response(status=404, headers=CORS_HEADERS)
        except Exception as exc:
            print(f"ERROR serving {key}: {exc}", file=sys.stderr)
            return web.Response(status=500, text=str(exc), headers=CORS_HEADERS)

    app = web.Application()
    app.router.add_route("*", r"/{key:.*}", handle)
    return app


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    parq_path = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 9090

    web.run_app(make_app(parq_path), host="127.0.0.1", port=port)
