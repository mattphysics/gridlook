# Using gridlook locally (ECMWF)

## One-time: start the app

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
