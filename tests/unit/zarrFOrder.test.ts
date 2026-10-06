import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

describe("ZarrDataManager F-order arrays", () => {
  it("returns zarr v2 order F data in C order", async () => {
    // 2x3 array [[0,1,2],[3,4,5]] stored column-major
    const files = new Map<string, Uint8Array>();
    const store: zarr.AsyncReadable = {
      get: async (key: string) => files.get(key),
    };
    const enc = new TextEncoder();
    files.set(
      "/.zarray",
      enc.encode(
        JSON.stringify({
          // eslint-disable-next-line camelcase
          zarr_format: 2,
          shape: [2, 3],
          chunks: [2, 3],
          dtype: "<f4",
          order: "F",
          compressor: null,
          filters: null,
          // eslint-disable-next-line camelcase
          fill_value: null,
        })
      )
    );
    files.set(
      "/0.0",
      new Uint8Array(new Float32Array([0, 3, 1, 4, 2, 5]).buffer)
    );
    const arr = await zarr.open.v2(store, { kind: "array" });
    const result = await ZarrDataManager.getVariableDataFromArray(arr, [
      null,
      null,
    ]);
    expect(Array.from(result.data as Float32Array)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.stride).toEqual([3, 1]);
  });
});
