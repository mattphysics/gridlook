# Using gridlook locally

There are two ways to open a dataset. Both work for zarr v2, zarr v3, and
parquet.

---

## Method 1 — one command (recommended)

```sh
# from the repo root
gridlook /path/to/dataset.zarr    # after: npm link
# or, without linking:
npm run open -- /path/to/dataset.zarr
```

`npm run open` is just a shorthand for `node scripts/gridlook.mjs`. Both do
the same thing: auto-detect the dataset type, start the right data server,
start Vite, and open the browser. Press `Ctrl+C` to stop everything.

Options:

| Flag             | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `--port <n>`     | Preferred dev-server port (default 3000; falls back if occupied). |
| `--python <bin>` | Python interpreter for the parquet proxy (default `python3`).     |
| `--root <dir>`   | Filesystem root the zarr HTTP server serves (default `/`).        |
| `--no-open`      | Print the URL but do not open the browser.                        |

> On macOS, serving zarr from an external drive requires granting **Full Disk
> Access** to your terminal app (System Settings → Privacy & Security).
> For the parquet proxy, `--python` (or `$GRIDLOOK_PYTHON`) must point at a
> Python with `gribscan` + `zarr` installed.

---

## Method 2 — manual (dev workflow only)

Use this when you are actively developing gridlook and want to keep Vite
running while swapping datasets, so you don't restart the dev server each time.

**Step 1** — start the dev server once, keep it running:

```sh
npm run dev
# or with custom ports if the defaults are occupied:
ZARR_PORT=8888 PARQ_PORT=9099 npm run dev
```

**Step 2** — for each dataset, start the matching data server in a second terminal:

| Dataset type  | Command                                                         | Port env var               |
| ------------- | --------------------------------------------------------------- | -------------------------- |
| zarr v2 or v3 | `node scripts/zarr_file_server.mjs / 8080`                      | `ZARR_PORT` (default 8080) |
| parquet       | `python3 scripts/zarr_parquet_proxy.py /path/to/file.parq 9091` | `PARQ_PORT` (default 9091) |

> **Do not use `python3 -m http.server` for zarr.** Python's built-in server
> ignores `Range` headers, which silently corrupts reads on sharding_indexed
> zarr v3 stores. Use `zarr_file_server.mjs` instead.

**Step 3** — open in the browser:

| Dataset type | URL                                                        |
| ------------ | ---------------------------------------------------------- |
| zarr         | `http://localhost:3000/#/localdata<absolute-path-to-zarr>` |
| parquet      | `http://localhost:3000/#/parqproxy/`                       |

Example zarr URL:

```
http://localhost:3000/#/localdata/Users/neam/Downloads/data.zarr
```

For a different zarr: just navigate to the new URL — no server restart needed.
For a different parquet: stop the proxy (`Ctrl+C`), restart with the new path, reload the page.
