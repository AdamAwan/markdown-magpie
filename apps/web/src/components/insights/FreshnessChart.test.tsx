import assert from "node:assert/strict";
import test from "node:test";
import type { FreshnessSummary } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { ChartCard } from "./ChartCard";
import { FreshnessChart } from "./FreshnessChart";

const fixture: FreshnessSummary = {
  documents: { fresh: 12, due: 3, overdue: 5 },
  sources: { fresh: 4, stale: 1 }
};

test("ChartCard renders the freshness title", () => {
  const html = renderMarkup(
    <ChartCard title="Knowledge-base freshness" loading={false} empty={false}>
      <FreshnessChart summary={fixture} />
    </ChartCard>
  );
  assert.match(html, /Knowledge-base freshness/);
});

test("FreshnessChart renders both document and source panels", () => {
  const html = renderMarkup(<FreshnessChart summary={fixture} />);
  assert.match(html, /Documents by review cycle/);
  assert.match(html, /Sources by last sync/);
});

test("FreshnessChart renders without throwing for all-zero data", () => {
  const html = renderMarkup(
    <FreshnessChart summary={{ documents: { fresh: 0, due: 0, overdue: 0 }, sources: { fresh: 0, stale: 0 } }} />
  );
  assert.equal(typeof html, "string");
});
