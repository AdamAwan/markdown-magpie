import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationSummary } from "../../lib/types";
import { renderMarkup } from "../../test/render";
import { ChartCard } from "./ChartCard";
import { VerificationSuccessChart } from "./VerificationSuccessChart";

const totals: VerificationSummary = { closed: 3, stillOpen: 1 };

test("ChartCard renders the verification chart title", () => {
  const html = renderMarkup(
    <ChartCard title="Verification success" loading={false} empty={false}>
      <VerificationSuccessChart totals={totals} />
    </ChartCard>
  );
  assert.match(html, /Verification success/);
});

test("VerificationSuccessChart shows the success percentage", () => {
  const html = renderMarkup(<VerificationSuccessChart totals={totals} />);
  // 3 closed of 4 total → 75%.
  assert.match(html, /75%/);
});

test("VerificationSuccessChart handles no verifications without throwing", () => {
  const html = renderMarkup(<VerificationSuccessChart totals={{ closed: 0, stillOpen: 0 }} />);
  assert.match(html, /0%/);
});
