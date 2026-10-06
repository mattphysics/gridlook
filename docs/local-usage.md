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
start the gridlook app server, and open the browser. Press `Ctrl+C` to stop
everything.

By default the app is served as a **production build** (bundled, compressed,
cached by the browser). It is ~1.5 MB instead of ~12 MB for the dev server,
which matters over slow links such as VS Code port forwarding. The build lives
in `node_modules/.cache/gridlook-dist` and is redone automatically (~10 s)
whenever anything in `src/`, `public/`, `index.html`, `vite.config.ts` or
`package-lock.json` changed. Use `--dev` for the Vite dev server with hot reload.

Options:

| Flag             | Description                                                                      |
| ---------------- | -------------------------------------------------------------------------------- |
| `--port <n>`     | Preferred app port (default `3700` + login-node number, e.g. 3702 on `ac6-102`). |
| `--dev`          | Use the Vite dev server (hot reload) instead of the build.                       |
| `--verbose`      | Log every request the browser makes (not with `--dev`).                          |
| `--new`          | Start a new instance even if one is already running (see below).                 |
| `--python <bin>` | Python interpreter for the parquet proxy (default `python3`).                    |
| `--root <dir>`   | Filesystem root the zarr HTTP server serves (default `/`).                       |
| `--no-open`      | Print the URL but do not open the browser.                                       |

**Several datasets at once:** if a gridlook is already running on the
preferred port, `gridlook other.zarr` opens the new zarr store through that
instance (it serves the whole filesystem) and exits, instead of starting a
second server. Everything then stays on one port and one VS Code port
forward. Parquet datasets always get their own instance; use `--new`, ideally
with a fixed `--port`, if you want a separate zarr instance too.

**Running on a remote machine (HPC, VS Code remote):** see
[Remote use](#remote-use-hpc-login-nodes-vs-code) below.

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

---

## Remote use (HPC login nodes, VS Code)

When gridlook runs on a remote machine, the browser on your laptop reaches it
through a port forward. The URL gridlook prints (`http://localhost:<port>/…`)
only works if your laptop's `localhost:<port>` is forwarded to **the node
gridlook runs on**. Two ways to set that up are below.

The default port depends on the node (3700 + node number, e.g. 3702 on
`ac6-102`; if that is busy 3802, 3902, …), so instances on different nodes
never compete for the same laptop port.

### Option A — SSH tunnel (always works, no configuration)

On your **laptop**, open a tunnel to the node and port that gridlook printed:

```sh
# gridlook printed http://localhost:3702/... and runs on ac6-102
ssh -L 3702:localhost:3702 ac6-102
```

Use the same jump host / user settings as for your normal login (e.g. add
`-J <jump-host>` or use a host alias from your `~/.ssh/config`). Keep the
session open and open the printed URL in your laptop's browser, e.g.
`http://localhost:3702/#/parqproxy/`. To find the node, run `hostname` in the
terminal where gridlook runs.

### Option B — VS Code remote, pinned to one node (recommended for VS Code)

VS Code forwards ports automatically and opens the URL for you. This is only
reliable if the VS Code window stays on **one** node:

- Login names such as a cluster alias are usually load-balanced. When a VS Code
  window reconnects (laptop sleep, network change), it can land on a different
  node, and **its port forwards move with it** — a forward set up while the
  window was on `ac6-102` then leads to the same port on another node, where
  nothing runs. The browser page stays black and gridlook never sees a request.
- All VS Code windows share your laptop's `localhost`; whichever window forwards
  a port first owns it.

Pin the connection to a fixed node in `~/.ssh/config` **on your laptop**: copy
the entry you use for the cluster and change only the name and `HostName`:

```
# existing, load-balanced entry (example)
Host hpc
  HostName hpc-login
  User myuser
  ProxyJump jump.example.org

# pinned to one node
Host hpc-102
  HostName ac6-102
  User myuser
  ProxyJump jump.example.org
```

Then connect VS Code to `hpc-102` (_Remote-SSH: Connect to Host…_) instead of
`hpc`. The window always reconnects to `ac6-102`, so its forwards stay valid.
With many windows you can spread them over several pinned nodes (`hpc-100`,
`hpc-101`, …); the per-node default ports keep them apart.

Also recommended, in your VS Code user settings:

```json
"remote.restoreForwardedPorts": false
```

so stale forwards from earlier sessions are not restored.

### Troubleshooting: the page stays black

gridlook prints `Browser connected (...)` on the first request it receives. If
that line never appears — after 20 s gridlook prints a hint — the browser is
talking to something else:

1. Run `hostname` where gridlook runs, note the port it printed, and use
   Option A (SSH tunnel) to that node and port. If this works, the VS Code
   forward was the problem.
2. In VS Code's _Ports_ panel, rows whose _Forwarded Address_ port differs from
   the _Port_ are stale; right-click → _Stop Forwarding Port_.
3. On the laptop, `curl -s http://127.0.0.1:<port>/__gridlook/info` shows which
   node and process answer on that port (`host`, `pid`). No answer within a few
   seconds means the forward leads to a node where nothing is running.

For parquet datasets, also check that the proxy started: a traceback ending in
`gridlook: data server exited with code 1` usually means the Python used lacks
`gribscan`, `zarr` or `fastparquet`; pass `--python <path>` or set
`$GRIDLOOK_PYTHON`.
