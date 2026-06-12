# Using gridlook locally (ECMWF)

## Quick start: one command

The fastest way to open any local dataset is the `gridlook` launcher. It
auto-detects whether the path is a zarr store or a gribscan/kerchunk parquet
reference, starts the matching data server **and** the dev server, and opens
your browser at the right URL.

```sh
# one-time, from the repo root
npm install
npm link   # exposes a global `gridlook` command

# then, from anywhere
gridlook /path/to/dataset.zarr
gridlook /path/to/file.parq
```

Or without linking, from the repo root:

```sh
npm run open -- /path/to/dataset.zarr
```

Options:

| Flag            | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `--port <n>`    | Preferred dev-server port (default 3000; falls back if occupied). |
| `--python <bin>`| Python interpreter for the parquet proxy (default `python3`).     |
| `--root <dir>`  | Filesystem root the zarr HTTP server serves (default `/`).        |
| `--no-open`     | Print the URL but do not open the browser.                        |

The launcher picks free ports automatically, so you can run it multiple times.
Press `Ctrl+C` to stop both servers.

> On macOS, serving zarr from an external drive requires granting **Full Disk
> Access** to your terminal app (System Settings → Privacy & Security).
> For the parquet proxy, point `--python` (or `$GRIDLOOK_PYTHON`) at a Python
> with `gribscan` + `zarr` installed.

---

## Manual setup

If you prefer to run the steps yourself (or need finer control), follow the
sections below.

### One-time: start the app

```sh
cd /home/neam/code/gridlook && npm run dev
```

App is at http://localhost:3000.

If the default backend ports (8080 for zarr, 9091 for parquet) are already
occupied, override them when starting the dev server:

```sh
ZARR_PORT=8888 PARQ_PORT=9099 npm run dev
```

---

## Loading a local zarr

**Terminal 1** — serve the filesystem from root:

```sh
cd / && python3 -m http.server 8080
```

Use a different port if 8080 is occupied, and start the app with the matching env var:

```sh
cd / && python3 -m http.server 8888
# then:
ZARR_PORT=8888 npm run dev
```

**Browser** — use the full absolute path after `/localdata`:

```
http://localhost:3000/#/localdata<absolute-path-to-zarr>
```

Example:

```
http://localhost:3000/#/localdata/ec/fws5/lb/project/eerie/data/ERA5/mars/daily/an_daymean.zarr
```

Keep this server running for any zarr on the system. No restart needed for different datasets.

---

## Loading a gribscan/kerchunk parquet

**Terminal 1** — start the parquet proxy:

```sh
/perm/neam/conda/envs/science4_gribscan/bin/python \
  /home/neam/code/gridlook/scripts/zarr_parquet_proxy.py \
  /path/to/file.parq \
  9091
```

Use a different port if 9091 is occupied, and start the app with the matching env var:

```sh
python zarr_parquet_proxy.py /path/to/file.parq 9099
# then:
PARQ_PORT=9099 npm run dev
```

**Browser:**

```
http://localhost:3000/#/parqproxy/
```

For a different parquet: stop the proxy (Ctrl+C), restart it with the new path, reload the page.

The proxy decompresses GRIB data server-side. Each time step is ~100 MB — loading is
fast locally but stepping through time will have a short pause per step.

---

## Summary

| Data type   | What to run                            | URL pattern              | Port env var |
| ----------- | -------------------------------------- | ------------------------ | ------------ |
| Any `.zarr` | `cd / && python3 -m http.server 8080`  | `/#/localdata<abs-path>` | `ZARR_PORT`  |
| Any `.parq` | `zarr_parquet_proxy.py file.parq 9091` | `/#/parqproxy/`          | `PARQ_PORT`  |

---

## on Macbook

```sh
cd / && python3 -m http.server 8888
# then:
ZARR_PORT=8888 npm run dev
```

```
Open: http://localhost:3000/#/localdata/Volumes/T7/annual_extremes_stats.zarr
```
