import assert from "node:assert/strict";
import test from "node:test";
import { DATAFLOW_FIT_VIEW_OPTIONS, DATAFLOW_MAX_ZOOM, DATAFLOW_MIN_ZOOM } from "./viewport";

test("default viewport prefers readable zoom over fitting every node", () => {
  assert.ok(DATAFLOW_FIT_VIEW_OPTIONS.padding <= 0.03, "fit padding should not waste canvas space");
  assert.ok((DATAFLOW_FIT_VIEW_OPTIONS.minZoom ?? 0) >= 0.55, "initial fit should stay readable");
  assert.ok(DATAFLOW_MIN_ZOOM < (DATAFLOW_FIT_VIEW_OPTIONS.minZoom ?? 0), "users can still zoom out manually");
  assert.ok(DATAFLOW_MAX_ZOOM > 1, "users can zoom in for detail");
});
