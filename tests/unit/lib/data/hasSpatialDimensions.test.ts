import { describe, expect, it } from "vitest";

import { hasSpatialDimensions } from "@/lib/data/coordinateVariables.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

type TDatasources = TSources["levels"][0]["datasources"];

function source(dimensionNames?: string[], units?: string) {
  return {
    store: "store",
    dataset: "",
    attrs: { dimensionNames, ...(units ? { units } : {}) },
  };
}

describe("hasSpatialDimensions", () => {
  // Layout of an unstructured (HEALPix without crs) store with QC time series
  const sources: TDatasources = {
    lat: source(["value"], "degrees_north"),
    lon: source(["value"], "degrees_east"),
    fwi: source(["time", "value"]),
    qc_fwi_mean: source(["time", "block"]), // eslint-disable-line camelcase
  };

  it("accepts variables sharing a dimension with lat/lon", () => {
    expect(hasSpatialDimensions(sources, "fwi")).toBe(true);
  });

  it("rejects variables not along lat/lon", () => {
    expect(hasSpatialDimensions(sources, "qc_fwi_mean")).toBe(false);
  });

  it("accepts variables with geographic dimension names", () => {
    expect(
      hasSpatialDimensions({ t2m: source(["time", "lat", "lon"]) }, "t2m")
    ).toBe(true);
  });

  it("accepts when it cannot decide", () => {
    expect(hasSpatialDimensions({ v: source(["time", "cell"]) }, "v")).toBe(
      true
    );
    expect(hasSpatialDimensions({ v: source(undefined) }, "v")).toBe(true);
  });
});
