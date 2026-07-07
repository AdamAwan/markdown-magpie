# Embedding-Based Phase-1 Gap Bucketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gap reconciler's phase-1 assignment a cheap embedding-based coarse pre-clusterer so obvious paraphrase gaps bucket together before the AI reshape, shrinking a 100-singleton fan-out to ~15 adjudicable buckets.

**Architecture:** A pure planner module (`gap-assignment.ts`) does the geometry (cosine, centroids, snapshot-based join/seed decisions); the reconciler orchestrates it inline using `ctx.providers.embedding` (embeddings are the sanctioned inline exception to queue-only); each cluster persists a representative embedding (`vector(1536)` column, nulled on composition change and recomputed lazily). The reshape propose→critic job is untouched and remains the semantic refiner.

**Tech Stack:** TypeScript ESM/NodeNext, node:test, pgvector, zod-validated startup config, custom SQL migrator.

**Spec:** `docs/superpowers/specs/2026-07-07-gap-embedding-bucketing-design.md` (approved). Branch: `claude/gap-embedding-bucketing` (main is PR-protected — never push main).

## Global Constraints

- The API never calls a chat/generative provider inline; **embeddings inline are allowed** (that's what this feature uses).
- Never cast through `unknown`/`any` to silence types. No hacky workarounds.
- Relative imports need explicit `.js` extensions, even from `.ts`.
- Validate as you go: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`, `npm run deadcode` (knip is strict — fix unused exports by de-exporting; `knip.json` already ignores `scripts/**`). DB-backed tests: `npm run test:db` (needs Docker; on this Windows box set `DOCKER_HOST` to the Docker Desktop Linux-engine pipe if the harness can't find the daemon).
- Run tests per workspace with `npm test -w @magpie/api` style commands, never root-cwd `node --test`.
- Commit and push little and often (on the feature branch).
- Migrations: append-only, `NNNN_snake_case.sql`, next free prefix is **0046**, no `BEGIN/COMMIT` of your own.
- Threshold semantics: T is conservative — collapse obvious paraphrases only; semantic cousins (~0.85 cosine, e.g. in-transit vs at-rest) must stay below T and remain reshape's job.
- Never compare gaps across flows. Frozen/dismissed clusters never participate.
- The full existing `apps/api/src/scheduling/gap-reconciler.test.ts` suite must stay green (it has no embedding provider → exercises the fallback path).

---

### Task 1: Pure assignment planner (`gap-assignment.ts`)

**Files:**
- Create: `apps/api/src/scheduling/gap-assignment.ts`
- Test: `apps/api/src/scheduling/gap-assignment.test.ts`

**Interfaces:**
- Consumes: nothing (pure, dependency-free).
- Produces (used by Tasks 2 and 5):
  - `l2Normalise(vector: number[]): number[]`
  - `cosineSimilarity(a: number[], b: number[]): number`
  - `normalisedMean(vectors: number[][]): number[]`
  - `foldIntoCentroid(representative: number[], priorCount: number, additions: number[][]): number[]`
  - `interface AssignmentCandidate { key: string; embedding: number[] }`
  - `interface ClusterRepresentative { clusterId: string; embedding: number[] }`
  - `interface AssignmentPlan { joins: Map<string, string[]>; seeds: string[][] }`
  - `planAssignments(candidates: AssignmentCandidate[], representatives: ClusterRepresentative[], threshold: number): AssignmentPlan`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/scheduling/gap-assignment.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cosineSimilarity,
  foldIntoCentroid,
  l2Normalise,
  normalisedMean,
  planAssignments,
  type AssignmentCandidate,
  type ClusterRepresentative
} from "./gap-assignment.js";

// 2-d unit vectors are enough to exercise every code path; angles picked so the
// intended relations are far from the 0.9-ish thresholds under test.
const east = [1, 0];
const nearEast = l2Normalise([0.995, 0.0999]); // cosine vs east ≈ 0.995
const north = [0, 1];
const nearNorth = l2Normalise([0.0999, 0.995]);
const northeast = l2Normalise([1, 1]); // cosine vs east ≈ 0.707

describe("vector helpers", () => {
  it("l2Normalise produces a unit vector and rejects zero vectors", () => {
    const normalised = l2Normalise([3, 4]);
    assert.ok(Math.abs(cosineSimilarity(normalised, [3, 4]) - 1) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...normalised) - 1) < 1e-12);
    assert.throws(() => l2Normalise([0, 0]), /zero or non-finite/);
  });

  it("cosineSimilarity matches known angles and rejects length mismatches", () => {
    assert.ok(Math.abs(cosineSimilarity(east, north)) < 1e-12);
    assert.ok(Math.abs(cosineSimilarity(east, east) - 1) < 1e-12);
    assert.ok(Math.abs(cosineSimilarity(east, northeast) - Math.SQRT1_2) < 1e-9);
    assert.throws(() => cosineSimilarity([1], [1, 0]), /length mismatch/);
  });

  it("normalisedMean averages then normalises", () => {
    const mean = normalisedMean([east, north]);
    assert.ok(Math.abs(cosineSimilarity(mean, northeast) - 1) < 1e-12);
    assert.throws(() => normalisedMean([]), /zero vectors/);
  });

  it("foldIntoCentroid folds additions as if the prior members summed to n·r", () => {
    // Prior: one member at east. Fold in one member at north → normalise([1,1]).
    const folded = foldIntoCentroid(east, 1, [north]);
    assert.ok(Math.abs(cosineSimilarity(folded, northeast) - 1) < 1e-12);
    // No additions → unchanged direction.
    const unchanged = foldIntoCentroid(east, 3, []);
    assert.ok(Math.abs(cosineSimilarity(unchanged, east) - 1) < 1e-12);
  });
});

describe("planAssignments", () => {
  const clusters: ClusterRepresentative[] = [
    { clusterId: "10", embedding: east },
    { clusterId: "11", embedding: north }
  ];

  it("joins each candidate to the best cluster at or above the threshold", () => {
    const candidates: AssignmentCandidate[] = [
      { key: "a", embedding: nearEast },
      { key: "b", embedding: nearNorth }
    ];
    const plan = planAssignments(candidates, clusters, 0.9);
    assert.deepEqual(plan.joins.get("10"), ["a"]);
    assert.deepEqual(plan.joins.get("11"), ["b"]);
    assert.deepEqual(plan.seeds, []);
  });

  it("seeds new clusters from candidates below the threshold, grouping transitively", () => {
    // c1~c2 and c2~c3 are above the threshold, c1~c3 is not: still one component.
    const c1 = l2Normalise([1, 0]);
    const c2 = l2Normalise([0.98, 0.199]); // cos(c1,c2) ≈ 0.98
    const c3 = l2Normalise([0.921, 0.39]); // cos(c2,c3) ≈ 0.98, cos(c1,c3) ≈ 0.92
    const lone = north;
    const plan = planAssignments(
      [
        { key: "c3", embedding: c3 },
        { key: "c1", embedding: c1 },
        { key: "lone", embedding: lone },
        { key: "c2", embedding: c2 }
      ],
      [],
      0.95
    );
    assert.deepEqual(plan.joins.size, 0);
    assert.deepEqual(plan.seeds, [["c1", "c2", "c3"], ["lone"]]);
  });

  it("is independent of candidate input order", () => {
    const candidates: AssignmentCandidate[] = [
      { key: "p", embedding: nearEast },
      { key: "q", embedding: northeast },
      { key: "r", embedding: nearNorth },
      { key: "s", embedding: l2Normalise([0.6, 0.8]) }
    ];
    const forward = planAssignments(candidates, clusters, 0.9);
    const reversed = planAssignments([...candidates].reverse(), clusters, 0.9);
    assert.deepEqual([...forward.joins.entries()].sort(), [...reversed.joins.entries()].sort());
    assert.deepEqual(forward.seeds, reversed.seeds);
  });

  it("breaks exact ties toward the earlier representative (callers pass id-ASC)", () => {
    const tied: ClusterRepresentative[] = [
      { clusterId: "3", embedding: east },
      { clusterId: "7", embedding: east }
    ];
    const plan = planAssignments([{ key: "x", embedding: east }], tied, 0.9);
    assert.deepEqual(plan.joins.get("3"), ["x"]);
    assert.equal(plan.joins.has("7"), false);
  });

  it("handles empty inputs", () => {
    const plan = planAssignments([], clusters, 0.9);
    assert.equal(plan.joins.size, 0);
    assert.deepEqual(plan.seeds, []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/api -- --test-name-pattern "planAssignments|vector helpers"`
(If the workspace test script doesn't accept a pattern, run `node --import tsx --test apps/api/src/scheduling/gap-assignment.test.ts` from the repo root.)
Expected: FAIL — `Cannot find module './gap-assignment.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/scheduling/gap-assignment.ts`:

```ts
// Pure geometry + bucketing for the reconciler's phase-1 gap assignment
// (embedding-based coarse pre-clustering). No I/O: the reconciler embeds
// candidate summaries and loads cluster representatives, then calls
// planAssignments to decide which gaps join which cluster. All decisions are
// made against the snapshot passed in — never against mid-pass updates — so
// the outcome is independent of candidate input order.

export interface AssignmentCandidate {
  // Stable identity within the pass (the reconciler uses gapSummaryKey).
  key: string;
  // L2-normalised embedding of the candidate's summary.
  embedding: number[];
}

export interface ClusterRepresentative {
  clusterId: string;
  // L2-normalised representative (centroid) embedding.
  embedding: number[];
}

export interface AssignmentPlan {
  // clusterId -> keys of candidates joining that cluster (key-sorted).
  joins: Map<string, string[]>;
  // Each entry seeds one new cluster: a connected component of candidates that
  // matched no existing cluster. Members are key-sorted; components are ordered
  // by their smallest key.
  seeds: string[][];
}

export function l2Normalise(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  const magnitude = Math.sqrt(sumSquares);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("cannot normalise a zero or non-finite vector");
  }
  return vector.map((value) => value / magnitude);
}

// Computed in full (not assuming unit inputs) so slightly-denormalised vectors
// still compare correctly.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}

// The stored form of a cluster's representative: the normalised mean of its
// distinct member-summary embeddings.
export function normalisedMean(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new Error("cannot average zero vectors");
  }
  const sum = new Array<number>(vectors[0].length).fill(0);
  for (const vector of vectors) {
    if (vector.length !== sum.length) {
      throw new Error(`vector length mismatch: ${vector.length} vs ${sum.length}`);
    }
    for (let i = 0; i < vector.length; i += 1) {
      sum[i] += vector[i];
    }
  }
  return l2Normalise(sum);
}

// Folds new member vectors into a stored centroid: normalise(n·r + Σ v). n·r
// stands in for the true sum of the n prior member vectors — exact when the
// members are identical, and near-exact for the tight clusters the assignment
// threshold produces (every member is within the threshold of the centroid by
// construction). The exact path remains the full recompute the reconciler runs
// when a representative is null.
export function foldIntoCentroid(
  representative: number[],
  priorCount: number,
  additions: number[][]
): number[] {
  const sum = representative.map((value) => value * priorCount);
  for (const vector of additions) {
    if (vector.length !== sum.length) {
      throw new Error(`vector length mismatch: ${vector.length} vs ${sum.length}`);
    }
    for (let i = 0; i < vector.length; i += 1) {
      sum[i] += vector[i];
    }
  }
  return l2Normalise(sum);
}

export function planAssignments(
  candidates: AssignmentCandidate[],
  representatives: ClusterRepresentative[],
  threshold: number
): AssignmentPlan {
  // Key-sort once so every downstream structure is input-order independent.
  const ordered = [...candidates].sort((l, r) => l.key.localeCompare(r.key));

  // Stage A: the best existing cluster at or above the threshold wins. Exact
  // ties break toward the earliest representative in the given order — callers
  // pass clusters id-ASC, so ties deterministically prefer the older cluster.
  const joins = new Map<string, string[]>();
  const unmatched: AssignmentCandidate[] = [];
  for (const candidate of ordered) {
    let best: { clusterId: string; similarity: number } | undefined;
    for (const representative of representatives) {
      const similarity = cosineSimilarity(candidate.embedding, representative.embedding);
      if (similarity >= threshold && (!best || similarity > best.similarity)) {
        best = { clusterId: representative.clusterId, similarity };
      }
    }
    if (!best) {
      unmatched.push(candidate);
      continue;
    }
    const bucket = joins.get(best.clusterId);
    if (bucket) {
      bucket.push(candidate.key);
    } else {
      joins.set(best.clusterId, [candidate.key]);
    }
  }

  // Stage B: connected components over the unmatched candidates (edge =
  // pairwise cosine ≥ threshold), via union-find over the sorted list.
  const parent = unmatched.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < unmatched.length; i += 1) {
    for (let j = i + 1; j < unmatched.length; j += 1) {
      if (cosineSimilarity(unmatched[i].embedding, unmatched[j].embedding) >= threshold) {
        parent[find(i)] = find(j);
      }
    }
  }
  const componentsByRoot = new Map<number, string[]>();
  unmatched.forEach((candidate, index) => {
    const root = find(index);
    const bucket = componentsByRoot.get(root);
    if (bucket) {
      bucket.push(candidate.key);
    } else {
      componentsByRoot.set(root, [candidate.key]);
    }
  });
  const seeds = [...componentsByRoot.values()].sort((l, r) => l[0].localeCompare(r[0]));
  return { joins, seeds };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test apps/api/src/scheduling/gap-assignment.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Validate and commit**

```bash
npm run typecheck && npm run lint
git add apps/api/src/scheduling/gap-assignment.ts apps/api/src/scheduling/gap-assignment.test.ts
git commit -m "feat(reconcile): pure embedding-assignment planner for phase-1 gap bucketing"
git push
```

Note: `npm run deadcode` will flag the planner's exports until Task 5 consumes them — that's expected mid-plan; the gate must be green by Task 6.

---

### Task 2: Offline threshold eval (choose T with evidence)

**Files:**
- Create: `scripts/eval-gap-threshold.ts`
- Create (generated + committed): `scripts/fixtures/gap-threshold-embeddings.json`
- Modify: `package.json` (root — add the `eval:gap-threshold` script next to `eval:api`)

**Interfaces:**
- Consumes: `planAssignments`, `l2Normalise` from `../apps/api/src/scheduling/gap-assignment.js`; `createEmbeddingProvider` from `../packages/retrieval/src/embeddings.js`.
- Produces: a sweep table on stdout and a chosen threshold. **Task 3 sets its default from this output.**

Notes: `knip.json` ignores `scripts/**`, so no dead-code concerns here. The script needs real embedding credentials on first run (present in `.env`: `OPENAI_COMPATIBLE_EMBEDDING_*` with fallback to `OPENAI_COMPATIBLE_*`); afterwards the committed fixture makes re-runs deterministic and offline.

- [ ] **Step 1: Write the eval script**

Create `scripts/eval-gap-threshold.ts`:

```ts
// Offline eval for the phase-1 gap-assignment threshold
// (GAP_CLUSTER_ASSIGN_THRESHOLD). Embeds a labelled corpus of gap summaries —
// paraphrase themes that SHOULD collapse, plus near-cousin traps and genuine
// singletons that MUST NOT — then sweeps the cosine threshold through the
// planner the reconciler actually uses and reports pairwise precision/recall
// and over-merges per T.
//
// First run embeds via the real configured provider (.env credentials) and
// caches vectors to scripts/fixtures/gap-threshold-embeddings.json; later runs
// are offline and deterministic. Pass --refresh to re-embed.
//
//   npm run eval:gap-threshold
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planAssignments } from "../apps/api/src/scheduling/gap-assignment.js";
import { createEmbeddingProvider } from "../packages/retrieval/src/embeddings.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(rootDir, "scripts", "fixtures", "gap-threshold-embeddings.json");

// The labelled corpus. Constructed (no labelled production corpus exists);
// themes mirror the compliance-questionnaire domain of the 100-gap incident.
// Adjacent themes are deliberate near-cousin traps: in-transit vs at-rest,
// backup vs log retention, MFA vs SSO, pen-test vs vuln-scan, incident
// response vs breach notification. Singletons include trap wordings too
// (key rotation vs at-rest encryption, PII-in-logs vs log retention).
const themes: Record<string, string[]> = {
  "tls-in-transit": [
    "What TLS versions are supported for data in transit?",
    "Which encryption protocols protect data in transit?",
    "How is data encrypted while in transit?",
    "What transport encryption standards are used?"
  ],
  "encryption-at-rest": [
    "How is data encrypted at rest?",
    "What encryption is applied to stored data?",
    "Describe at-rest encryption for customer data."
  ],
  "backup-retention": [
    "How long are backups retained?",
    "What is the backup retention period?",
    "For how many days are database backups kept?"
  ],
  "log-retention": [
    "How long are audit logs retained?",
    "What is the log retention period?"
  ],
  "mfa": [
    "Is multi-factor authentication enforced for staff?",
    "Do employees use MFA to sign in?",
    "Is two-factor authentication required for internal access?"
  ],
  "sso": [
    "Does the product support single sign-on?",
    "Is SAML SSO available?",
    "Can customers log in via their own identity provider?"
  ],
  "pen-testing": [
    "How often are penetration tests performed?",
    "What is the frequency of third-party pen tests?",
    "When was the last penetration test conducted?"
  ],
  "vuln-scanning": [
    "Is automated vulnerability scanning in place?",
    "How are vulnerabilities in dependencies detected?"
  ],
  "data-residency": [
    "Where is customer data stored geographically?",
    "In which regions does customer data reside?",
    "Can data be pinned to the EU region?"
  ],
  "subprocessors": [
    "Which subprocessors handle customer data?",
    "Is there a published list of third-party data processors?"
  ],
  "incident-response": [
    "What is the security incident response process?",
    "How are security incidents handled and escalated?",
    "Describe the incident response plan."
  ],
  "breach-notification": [
    "How quickly are customers notified of a data breach?",
    "What is the breach notification SLA?"
  ],
  "access-review": [
    "How often are user access rights reviewed?",
    "Is there a periodic access recertification process?"
  ],
  "disaster-recovery": [
    "What is the disaster recovery RTO?",
    "How fast can service be restored after a major outage?"
  ],
  "soc2": [
    "Is a SOC 2 Type II report available?",
    "Has the company completed a SOC 2 audit?"
  ]
};

const singletons: string[] = [
  "What open-source licences apply to the product?",
  "Is there an on-premise deployment option?",
  "Which web browsers are supported?",
  "How is usage-based billing calculated?",
  "What is the API rate limit per organisation?",
  "Does the roadmap include SCIM provisioning?",
  "What uptime SLA is offered?",
  "How do I export all my data?",
  "Is customer content used to train models?",
  "What languages is the client SDK available in?",
  "What is the password complexity policy?",
  "How is PII redacted from application logs?",
  "Are container images scanned before deployment?",
  "What DDoS protections are in place?",
  "Is customer data segregated per tenant?",
  "What is the change management approval process?",
  "How are encryption keys rotated and managed?",
  "Does support offer a dedicated account manager?"
];

interface LabelledText {
  text: string;
  label: string;
}

const corpus: LabelledText[] = [
  ...Object.entries(themes).flatMap(([label, texts]) => texts.map((text) => ({ text, label }))),
  ...singletons.map((text, index) => ({ text, label: `singleton-${index}` }))
];

async function loadOrEmbed(refresh: boolean): Promise<Map<string, number[]>> {
  if (!refresh && existsSync(fixturePath)) {
    const raw = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, number[]>;
    const cached = new Map(Object.entries(raw));
    if (corpus.every((entry) => cached.has(entry.text))) {
      console.log(`Using cached embeddings from ${path.relative(rootDir, fixturePath)}`);
      return cached;
    }
    console.log("Fixture missing corpus entries; re-embedding.");
  }
  loadDotEnv();
  const env = process.env;
  const baseUrl = env.OPENAI_COMPATIBLE_EMBEDDING_BASE_URL || env.OPENAI_COMPATIBLE_BASE_URL;
  const apiKey = env.OPENAI_COMPATIBLE_EMBEDDING_API_KEY || env.OPENAI_COMPATIBLE_API_KEY;
  const model = env.OPENAI_COMPATIBLE_EMBEDDING_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "No cached fixture and no OPENAI_COMPATIBLE_EMBEDDING_* credentials in the environment/.env"
    );
  }
  const provider = createEmbeddingProvider({ provider: "openai-compatible", apiKey, baseUrl, model });
  const texts = corpus.map((entry) => entry.text);
  console.log(`Embedding ${texts.length} summaries with ${model}…`);
  const vectors = await provider.embed(texts);
  if (vectors.length !== texts.length) {
    throw new Error(`provider returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  // Round to 7 significant digits to keep the committed fixture small; the
  // cosine error this introduces is far below the sweep's 0.01 resolution.
  const entries = texts.map((text, i) => [text, vectors[i].map((v) => Number(v.toPrecision(7)))]);
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, JSON.stringify(Object.fromEntries(entries)), "utf8");
  console.log(`Wrote fixture ${path.relative(rootDir, fixturePath)}`);
  return new Map(entries as Array<[string, number[]]>);
}

function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.join(rootDir, ".env"));
  } catch {
    // No .env — rely on the shell environment.
  }
}

interface SweepRow {
  threshold: number;
  components: number;
  pairPrecision: number;
  pairRecall: number;
  overMerges: number;
}

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");
  const embeddings = await loadOrEmbed(refresh);

  const labelByKey = new Map(corpus.map((entry) => [entry.text, entry.label]));
  const positivePairs = countPositivePairs();

  const rows: SweepRow[] = [];
  for (let t = 70; t <= 98; t += 1) {
    const threshold = t / 100;
    const plan = planAssignments(
      corpus.map((entry) => {
        const vector = embeddings.get(entry.text);
        if (!vector) throw new Error(`missing embedding for: ${entry.text}`);
        return { key: entry.text, embedding: vector };
      }),
      [],
      threshold
    );
    let truePositive = 0;
    let falsePositive = 0;
    let overMerges = 0;
    for (const component of plan.seeds) {
      const labels = component.map((key) => labelByKey.get(key) ?? "?");
      if (new Set(labels).size > 1) overMerges += 1;
      for (let i = 0; i < component.length; i += 1) {
        for (let j = i + 1; j < component.length; j += 1) {
          if (labels[i] === labels[j]) truePositive += 1;
          else falsePositive += 1;
        }
      }
    }
    rows.push({
      threshold,
      components: plan.seeds.length,
      pairPrecision: truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive),
      pairRecall: positivePairs === 0 ? 1 : truePositive / positivePairs,
      overMerges
    });
  }

  console.log("\n T     components  precision  recall  over-merges");
  for (const row of rows) {
    console.log(
      ` ${row.threshold.toFixed(2)}  ${String(row.components).padStart(10)}  ${row.pairPrecision.toFixed(3).padStart(9)}  ${row.pairRecall.toFixed(3).padStart(6)}  ${String(row.overMerges).padStart(11)}`
    );
  }

  const clean = rows.filter((row) => row.overMerges === 0);
  const lowestClean = clean.reduce((best, row) => (row.threshold < best.threshold ? row : best), clean[0]);
  console.log(
    `\nLowest zero-over-merge threshold: ${lowestClean.threshold.toFixed(2)} ` +
      `(recall ${lowestClean.pairRecall.toFixed(3)}). ` +
      `Recommended default: ${(lowestClean.threshold + 0.02).toFixed(2)} (0.02 safety margin).`
  );
}

function countPositivePairs(): number {
  let pairs = 0;
  for (const texts of Object.values(themes)) {
    pairs += (texts.length * (texts.length - 1)) / 2;
  }
  return pairs;
}

await main();
```

- [ ] **Step 2: Add the npm script**

In root `package.json`, next to `"eval:api"`:

```json
    "eval:gap-threshold": "node --import tsx scripts/eval-gap-threshold.ts",
```

- [ ] **Step 3: Run the eval (first run hits the real provider)**

Run: `npm run eval:gap-threshold`
Expected: an embedding pass (~60 texts, one batch), a fixture written to `scripts/fixtures/gap-threshold-embeddings.json`, a sweep table, and a recommendation line. Re-run once to confirm the offline path: `npm run eval:gap-threshold` → `Using cached embeddings…` and byte-identical table.

- [ ] **Step 4: Read the results and choose T**

Decision rule (from the spec): chosen T = lowest sweep value with **zero over-merges**, + 0.02 margin, rounded to 2 dp. Sanity-check the table: recall should still be meaningfully above 0 at the chosen T (the paraphrase themes must actually collapse — if recall at the chosen T is under ~0.5, the corpus or model needs a second look before proceeding; investigate rather than shipping a threshold that does nothing).

Record the chosen T and the table's key rows (the chosen T's row and its neighbours) — Task 3 embeds the value, Task 6 documents the evidence in the PR description.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-gap-threshold.ts scripts/fixtures/gap-threshold-embeddings.json package.json
git commit -m "feat(eval): offline threshold sweep for phase-1 gap assignment"
git push
```

---

### Task 3: Startup-config knob (`GAP_CLUSTER_ASSIGN_THRESHOLD`)

**Files:**
- Modify: `apps/api/src/platform/config.ts` (AppConfig interface ~line 127 area, resolver next to `resolveFlowRouterConfig` ~line 167, `loadConfig` return ~line 429)
- Test: `apps/api/src/platform/config.test.ts`

**Interfaces:**
- Consumes: the chosen T from Task 2 (referred to below as `<T>` — substitute the actual number, e.g. `0.92`).
- Produces: `AppConfig.gapClustering: { assignThreshold: number }` — Task 5's reconciler reads `ctx.settings.gapClustering.assignThreshold`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/platform/config.test.ts` (match the file's existing `describe`/`it` style and its helper for building a minimal valid env — reuse whatever base-env helper the existing tests use; if tests construct env objects inline, include `DATABASE_URL` and any other required vars the sibling tests set):

```ts
describe("gap clustering config", () => {
  it("defaults the assignment threshold", () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.gapClustering.assignThreshold, <T>);
  });

  it("honours a valid override", () => {
    const config = loadConfig({ ...baseEnv(), GAP_CLUSTER_ASSIGN_THRESHOLD: "0.95" });
    assert.equal(config.gapClustering.assignThreshold, 0.95);
  });

  it("falls back on out-of-range or non-numeric values (including 0)", () => {
    for (const bad of ["0", "-0.5", "1.5", "abc", ""]) {
      const config = loadConfig({ ...baseEnv(), GAP_CLUSTER_ASSIGN_THRESHOLD: bad });
      assert.equal(config.gapClustering.assignThreshold, <T>, `value ${JSON.stringify(bad)} must fall back`);
    }
  });
});
```

(`baseEnv()` = the minimal valid env the existing tests in this file already use — copy its pattern exactly; don't invent a new helper if one exists.)

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test apps/api/src/platform/config.test.ts`
Expected: FAIL — `gapClustering` does not exist on `AppConfig`.

- [ ] **Step 3: Implement**

In `apps/api/src/platform/config.ts`:

(a) Add to the `AppConfig` interface, after `flowRouter: FlowRouterConfig;`:

```ts
  // Phase-1 gap assignment: the cosine floor a new gap must clear against an
  // active cluster's representative embedding to join it (and for two new gaps
  // to seed one shared cluster). Deliberately conservative — it collapses only
  // obvious paraphrases; subtler consolidation is the reshape critic's job. A
  // blank or out-of-range value falls back to the default rather than failing
  // boot: like the flow-router cut-offs this is a safety-neutral tuning knob
  // (a mis-tune only changes how much pre-collapsing phase 1 does).
  gapClustering: GapClusteringConfig;
```

(b) Next to `FlowRouterConfig`:

```ts
interface GapClusteringConfig {
  assignThreshold: number;
}

// Chosen by the offline sweep in scripts/eval-gap-threshold.ts: the lowest
// threshold with zero over-merges across the labelled paraphrase/trap corpus,
// plus a 0.02 safety margin. See
// docs/superpowers/specs/2026-07-07-gap-embedding-bucketing-design.md.
const GAP_CLUSTER_DEFAULT_ASSIGN_THRESHOLD = <T>;

function resolveGapClusteringConfig(env: NodeJS.ProcessEnv): GapClusteringConfig {
  const value = parseUnitFloat(env.GAP_CLUSTER_ASSIGN_THRESHOLD, GAP_CLUSTER_DEFAULT_ASSIGN_THRESHOLD);
  // A threshold of 0 would bucket every gap together; treat it as invalid.
  return { assignThreshold: value > 0 ? value : GAP_CLUSTER_DEFAULT_ASSIGN_THRESHOLD };
}
```

(c) In `loadConfig`'s returned object, after `flowRouter: resolveFlowRouterConfig(env),`:

```ts
    gapClustering: resolveGapClusteringConfig(env),
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test apps/api/src/platform/config.test.ts`
Expected: PASS (all — existing config tests must stay green too).

- [ ] **Step 5: Validate and commit**

```bash
npm run typecheck && npm run lint && npm test -w @magpie/api
git add apps/api/src/platform/config.ts apps/api/src/platform/config.test.ts
git commit -m "feat(config): GAP_CLUSTER_ASSIGN_THRESHOLD startup knob for phase-1 gap assignment"
git push
```

---

### Task 4: Migration + cluster representative persistence

**Files:**
- Create: `packages/db/migrations/0046_gap_cluster_representative.sql`
- Create: `apps/api/src/stores/vector-literal.ts`
- Modify: `apps/api/src/stores/postgres-knowledge-store.ts` (replace its private `toVectorLiteral` with the shared import)
- Modify: `apps/api/src/stores/gap-cluster-store.ts` (record + input types, interface, in-memory impl)
- Modify: `apps/api/src/stores/postgres-gap-cluster-store.ts`
- Test: `apps/api/src/stores/gap-cluster-store.test.ts` (in-memory), `apps/api/src/stores/postgres-gap-cluster-store.test.ts` (integration, `RUN_PG_INTEGRATION`-gated — follow the existing tests' setup in that file)

**Interfaces:**
- Produces (used by Task 5):
  - `GapClusterRecord.representativeEmbedding?: number[]`
  - `CreateClusterInput.representativeEmbedding?: number[]`
  - `GapClusterStore.setClusterRepresentative(id: string, embedding: number[] | null): Promise<void>`
  - `toVectorLiteral(embedding: number[]): string` and `parseVectorLiteral(literal: string): number[]` from `vector-literal.ts`

- [ ] **Step 1: Write the migration**

Create `packages/db/migrations/0046_gap_cluster_representative.sql`:

```sql
-- Phase-1 gap assignment (embedding-based coarse pre-clustering) stores each
-- cluster's representative embedding: the L2-normalised centroid of its
-- distinct active member gap summaries. NULL means "recompute lazily on the
-- next assignment pass" — the state for pre-existing clusters and for any
-- cluster whose composition a reshape/prune just changed. Same type/dimension
-- as document_sections.embedding (0001). No ANN index: per-flow active cluster
-- counts are small and similarity is computed in the API against the loaded set.
ALTER TABLE gap_clusters
  ADD COLUMN IF NOT EXISTS representative_embedding vector(1536);
```

Run: `node --test scripts/lib/migration-order.test.mjs` — expected PASS (prefix 0046 is unique and well-formed).

- [ ] **Step 2: Write the failing store tests**

Add to `apps/api/src/stores/gap-cluster-store.test.ts` (in-memory; match the file's existing style):

```ts
describe("cluster representative embedding", () => {
  it("persists a representative set at creation and via the setter, and clears on null", async () => {
    const store = new InMemoryGapClusterStore();
    const created = await store.createCluster({
      title: "t",
      revision: 1,
      representativeEmbedding: [1, 0, 0]
    });
    assert.deepEqual((await store.getCluster(created.id))?.representativeEmbedding, [1, 0, 0]);

    await store.setClusterRepresentative(created.id, [0, 1, 0]);
    assert.deepEqual((await store.getCluster(created.id))?.representativeEmbedding, [0, 1, 0]);

    await store.setClusterRepresentative(created.id, null);
    assert.equal((await store.getCluster(created.id))?.representativeEmbedding, undefined);
  });

  it("leaves the representative undefined when not supplied at creation", async () => {
    const store = new InMemoryGapClusterStore();
    const created = await store.createCluster({ title: "t", revision: 1 });
    assert.equal((await store.getCluster(created.id))?.representativeEmbedding, undefined);
  });
});
```

Add to `apps/api/src/stores/postgres-gap-cluster-store.test.ts` a mirrored integration test using that file's existing gated setup (same `RUN_PG_INTEGRATION` skip flag, same pool/`reset()` lifecycle as its sibling tests) — the assertion body is identical to the in-memory test above except the vector must be 1536-dimensional for the column type. Build it as:

```ts
const embedding = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
const replacement = Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1 : 0));
```

and assert with `assert.deepEqual(record?.representativeEmbedding, embedding)` after create, `replacement` after set, `undefined` after `setClusterRepresentative(id, null)`.

- [ ] **Step 3: Run to verify failure**

Run: `node --import tsx --test apps/api/src/stores/gap-cluster-store.test.ts`
Expected: FAIL — `representativeEmbedding`/`setClusterRepresentative` don't exist.

- [ ] **Step 4: Implement the shared vector-literal helpers**

Create `apps/api/src/stores/vector-literal.ts`:

```ts
// pgvector text-format helpers shared by Postgres stores that read/write
// vector columns. pg returns vector values as their text literal ("[1,2,3]");
// writes send the same literal with a ::vector cast.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function parseVectorLiteral(literal: string): number[] {
  const inner = literal.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner === "") {
    return [];
  }
  return inner.split(",").map((value) => Number.parseFloat(value));
}
```

In `apps/api/src/stores/postgres-knowledge-store.ts`: delete the private `function toVectorLiteral(...)` (near the bottom, ~line 486) and add `import { toVectorLiteral } from "./vector-literal.js";` at the top. (knip: both exports are consumed — `toVectorLiteral` by two stores, `parseVectorLiteral` by the gap-cluster store below.)

- [ ] **Step 5: Extend the store interface + in-memory implementation**

In `apps/api/src/stores/gap-cluster-store.ts`:

(a) On `GapClusterRecord`, after `reconciliationRevision: number;`:

```ts
  // L2-normalised centroid of the cluster's distinct active member gap-summary
  // embeddings, used by the reconciler's phase-1 assignment. Undefined = not
  // yet computed, or invalidated by a composition change (reshape merge/split,
  // resolved-gap pruning) — the next assignment pass recomputes it lazily.
  representativeEmbedding?: number[];
```

(b) On `CreateClusterInput`, after `revision: number;`:

```ts
  representativeEmbedding?: number[];
```

(c) On the `GapClusterStore` interface, after `dismissCluster(...)`:

```ts
  // Sets or clears (null) the cluster's representative embedding. Cleared when
  // a reshape or prune changes the cluster's composition so the next assignment
  // pass recomputes the centroid from the surviving members.
  setClusterRepresentative(id: string, embedding: number[] | null): Promise<void>;
```

(d) In `InMemoryGapClusterStore.createCluster`, add to the record literal (after `reconciliationRevision: input.revision,`):

```ts
      representativeEmbedding: input.representativeEmbedding,
```

(e) Add the method to `InMemoryGapClusterStore` (after `dismissCluster`):

```ts
  async setClusterRepresentative(id: string, embedding: number[] | null): Promise<void> {
    const existing = this.clusters.get(id);
    if (existing) {
      const { representativeEmbedding: _dropped, ...rest } = existing;
      this.clusters.set(id, {
        ...rest,
        ...(embedding ? { representativeEmbedding: embedding } : {}),
        updatedAt: this.now()
      });
    }
  }
```

- [ ] **Step 6: Extend the Postgres implementation**

In `apps/api/src/stores/postgres-gap-cluster-store.ts`:

(a) Import: `import { parseVectorLiteral, toVectorLiteral } from "./vector-literal.js";`

(b) `ClusterRow` gains: `representative_embedding: string | null;`

(c) `mapCluster` gains (after `reconciliationRevision`):

```ts
    representativeEmbedding: row.representative_embedding
      ? parseVectorLiteral(row.representative_embedding)
      : undefined,
```

(d) `createCluster` — extend the INSERT:

```ts
  async createCluster(input: CreateClusterInput): Promise<GapClusterRecord> {
    const result = await this.pool.query<ClusterRow>(
      `
        INSERT INTO gap_clusters (flow_id, title, rationale, parent_cluster_id, reconciliation_revision, representative_embedding)
        VALUES ($1, $2, $3, $4, $5, $6::vector)
        RETURNING *
      `,
      [
        input.flowId ?? null,
        input.title,
        input.rationale ?? null,
        input.parentClusterId ?? null,
        input.revision,
        input.representativeEmbedding ? toVectorLiteral(input.representativeEmbedding) : null
      ]
    );
    return mapCluster(result.rows[0]);
  }
```

(e) New method (after `dismissCluster`):

```ts
  async setClusterRepresentative(id: string, embedding: number[] | null): Promise<void> {
    await this.pool.query(
      "UPDATE gap_clusters SET representative_embedding = $2::vector, updated_at = now() WHERE id = $1",
      [id, embedding ? toVectorLiteral(embedding) : null]
    );
  }
```

- [ ] **Step 7: Run unit tests, then the DB suite**

```bash
node --import tsx --test apps/api/src/stores/gap-cluster-store.test.ts   # PASS
npm run build && npm run typecheck && npm test
npm run test:db                                                          # applies 0046 on a clean container, runs integration tests
```

Expected: all PASS (the new Postgres test runs inside `test:db`).

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0046_gap_cluster_representative.sql apps/api/src/stores/
git commit -m "feat(store): persist gap-cluster representative embeddings (migration 0046)"
git push
```

---

### Task 5: Reconciler integration (embedding-based phase 1)

**Files:**
- Modify: `apps/api/src/scheduling/gap-reconciler.ts` (step-1 block inside `reconcileClusters` ~line 356; `applyMerge`; `applySplit`; `pruneResolvedMemberships`)
- Test: `apps/api/src/scheduling/gap-reconciler.test.ts`

**Interfaces:**
- Consumes: `planAssignments`, `foldIntoCentroid`, `normalisedMean`, `l2Normalise`, `ClusterRepresentative` (Task 1); `ctx.settings.gapClustering.assignThreshold` (Task 3); `setClusterRepresentative` / `representativeEmbedding` (Task 4); `EmbeddingProvider` from `@magpie/core`; `GapCandidate` from `@magpie/core`.
- Produces: no new exports (knip-safe). Behaviour: phase-1 assignment described in the spec.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/scheduling/gap-reconciler.test.ts`. First the shared fixture helper (near the other top-of-file helpers):

```ts
import type { EmbeddingProvider } from "@magpie/core";

// Deterministic embedding fixture: each summary maps to a fixed unit vector.
// Unknown text throws so a test cannot silently embed something it didn't stub.
function fakeEmbeddingProvider(vectorsBySummary: Record<string, number[]>): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vector = vectorsBySummary[text];
        if (!vector) {
          throw new Error(`no fixture vector for: ${text}`);
        }
        return vector;
      });
    }
  };
}

// cosine(east, nearEast) ≈ 0.995 (obvious paraphrase); cosine(east, north) = 0.
const EAST = [1, 0];
const NEAR_EAST = [0.9950124, 0.0995463];
const NORTH = [0, 1];

async function recordGap(ctx: AppContext, question: string, summary: string): Promise<void> {
  const log = await ctx.stores.questionLogs.record({
    question,
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, summary);
}
```

Then the tests (new `describe` block):

```ts
describe("reconcileGaps embedding-based assignment", () => {
  const noPr = { fetchPullRequestStatus: async () => undefined };

  it("collapses paraphrase gaps into one cluster and keeps distinct gaps separate", async () => {
    const ctx = makeTestContext({
      providers: {
        embedding: fakeEmbeddingProvider({
          "TLS versions for data in transit": EAST,
          "encryption protocols protecting data in transit": NEAR_EAST,
          "backup retention period": NORTH
        })
      }
    });
    await recordGap(ctx, "q1", "TLS versions for data in transit");
    await recordGap(ctx, "q2", "encryption protocols protecting data in transit");
    await recordGap(ctx, "q3", "backup retention period");

    await reconcileGaps(ctx, undefined, noPr);

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 2, "paraphrases share a cluster; the distinct gap seeds its own");
    const sizes = (
      await Promise.all(clusters.map((c) => ctx.stores.gapClusters.listMembershipsForCluster(c.id)))
    )
      .map((m) => m.length)
      .sort();
    assert.deepEqual(sizes, [1, 2]);
    for (const cluster of clusters) {
      assert.ok(cluster.representativeEmbedding, "every seeded cluster persists a representative");
    }
  });

  it("joins a later paraphrase to the existing cluster instead of seeding a new one", async () => {
    const ctx = makeTestContext({
      providers: {
        embedding: fakeEmbeddingProvider({
          "TLS versions for data in transit": EAST,
          "encryption protocols protecting data in transit": NEAR_EAST
        })
      }
    });
    await recordGap(ctx, "q1", "TLS versions for data in transit");
    await reconcileGaps(ctx, undefined, noPr);
    assert.equal((await ctx.stores.gapClusters.listActiveClusters()).length, 1);

    await recordGap(ctx, "q2", "encryption protocols protecting data in transit");
    await reconcileGaps(ctx, undefined, noPr);

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 1, "the paraphrase joined the existing cluster");
    const memberships = await ctx.stores.gapClusters.listMembershipsForCluster(clusters[0].id);
    assert.equal(memberships.length, 2);
  });

  it("recomputes a nulled representative from member summaries before matching", async () => {
    const ctx = makeTestContext({
      providers: {
        embedding: fakeEmbeddingProvider({
          "TLS versions for data in transit": EAST,
          "encryption protocols protecting data in transit": NEAR_EAST
        })
      }
    });
    await recordGap(ctx, "q1", "TLS versions for data in transit");
    await reconcileGaps(ctx, undefined, noPr);
    const [seeded] = await ctx.stores.gapClusters.listActiveClusters();
    await ctx.stores.gapClusters.setClusterRepresentative(seeded.id, null);

    await recordGap(ctx, "q2", "encryption protocols protecting data in transit");
    await reconcileGaps(ctx, undefined, noPr);

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 1, "recomputed representative still attracts the paraphrase");
    assert.ok(clusters[0].representativeEmbedding, "recompute persisted the representative");
  });

  it("fails the run (recorded failed) when the configured provider's embed call throws", async () => {
    const ctx = makeTestContext({
      providers: {
        embedding: {
          async embed(): Promise<number[][]> {
            throw new Error("embedding endpoint down");
          }
        }
      }
    });
    await recordGap(ctx, "q1", "some gap");

    await assert.rejects(reconcileGaps(ctx, undefined, noPr), /embedding endpoint down/);
    const runs = await ctx.stores.maintenanceRuns.list({ taskType: "process_gaps_to_pull_requests", limit: 10 });
    assert.equal(runs[0]?.status, "failed", "the failed tick is auditable and will retry");
    assert.equal(
      (await ctx.stores.gapClusters.listActiveClusters()).length,
      0,
      "no singleton fallback clusters were created"
    );
  });

  it("nulls the survivor's representative when a confirmed merge changes its composition", async () => {
    const jobs = new ReshapingJobBroker((input) => {
      const clusterIds = (input as { clusters: Array<{ id: string }> }).clusters.map((c) => c.id);
      return clusterIds.length >= 2
        ? { merges: [{ clusterIds: clusterIds.slice(0, 2), rationale: "same topic", confirmed: true }], splits: [], dismissals: [] }
        : { merges: [], splits: [], dismissals: [] };
    });
    const ctx = makeTestContext({
      jobs,
      providers: {
        embedding: fakeEmbeddingProvider({
          "TLS versions for data in transit": EAST,
          "backup retention period": NORTH
        })
      }
    });
    await recordGap(ctx, "q1", "TLS versions for data in transit");
    await recordGap(ctx, "q2", "backup retention period");

    await reconcileGaps(ctx, undefined, noPr);

    const clusters = await ctx.stores.gapClusters.listActiveClusters();
    assert.equal(clusters.length, 1, "merge left one survivor");
    assert.equal(
      clusters[0].representativeEmbedding,
      undefined,
      "survivor representative nulled for lazy recompute"
    );
  });
});
```

Adjust mechanical details to the file's reality while writing: `makeTestContext` import already exists; `recordManualGap(id, summary)` signature is `(id: string, summary?: string)`; `ReshapingJobBroker` is defined earlier in the same file. If `maintenanceRuns.list` requires different filter fields, match `apps/api/src/stores/maintenance-run-store.ts` (`list(filters: { taskType?; flowId?; limit })`).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --import tsx --test apps/api/src/scheduling/gap-reconciler.test.ts`
Expected: the 5 new tests FAIL (today every distinct summary becomes its own cluster; no representative persistence). Existing tests still PASS.

- [ ] **Step 3: Implement the assignment step**

In `apps/api/src/scheduling/gap-reconciler.ts`:

(a) New imports:

```ts
import type { EmbeddingProvider, GapCandidate, Proposal } from "@magpie/core"; // extend the existing @magpie/core type import
import {
  foldIntoCentroid,
  normalisedMean,
  l2Normalise,
  planAssignments,
  type ClusterRepresentative
} from "./gap-assignment.js";
```

(b) Replace the step-1 block inside `reconcileClusters` (the code from `const candidates = (await ctx.stores.questionLogs.listGapCandidates(200))...` down to the `logger.info({ flowLabel, clustersCreated }, "gap reconciler: created new clusters from unassigned gaps");` line) with:

```ts
  // 1) Assign this flow's unassigned gaps. With an embedding provider, phase 1
  // is a coarse semantic pre-clusterer: obvious paraphrases bucket together
  // (joining an existing cluster or seeding one shared new cluster) so the
  // reshape critic adjudicates a handful of buckets instead of discovering
  // every merge across ~100 singletons (the fan-out incident). Without a
  // provider (keyword-only deployments), fall back to the original
  // one-cluster-per-distinct-summary behaviour. Reshape (step 2) remains the
  // semantic refiner either way.
  details.clustersCreated = await assignNewGaps(ctx, flowId, flowLabel);
```

(c) Add the new functions (place them after `reconcileClusters`):

```ts
// One unassigned gap-candidate: the distinct (summary, flow) pair plus the gap
// row ids not yet held by any active cluster.
interface PendingCandidate {
  candidate: GapCandidate;
  key: string;
  gapIds: string[];
}

// Resolves this flow's candidates that still have unassigned gap rows, then
// routes to the embedding-based assignment or the exact-summary fallback.
// Returns the number of clusters created.
async function assignNewGaps(ctx: AppContext, flowId: string | undefined, flowLabel: string): Promise<number> {
  const candidates = (await ctx.stores.questionLogs.listGapCandidates(200)).filter((c) => sameFlow(c.flowId, flowId));
  const activeMemberships = await ctx.stores.gapClusters.listActiveMembershipsForFlow(flowId);
  const assignedGapIds = new Set(activeMemberships.map((m) => m.gapId));
  const gapIdsByCandidate = await ctx.stores.questionLogs.gapIdsForSummaries(
    candidates.map((candidate) => ({ summary: candidate.summary, flowId: candidate.flowId }))
  );
  const pending: PendingCandidate[] = [];
  for (const candidate of candidates) {
    const key = gapSummaryKey(candidate.summary, candidate.flowId);
    const gapIds = (gapIdsByCandidate.get(key) ?? []).filter((id) => !assignedGapIds.has(id));
    if (gapIds.length > 0) {
      pending.push({ candidate, key, gapIds });
    }
  }
  if (pending.length === 0) {
    logger.info({ flowLabel, clustersCreated: 0 }, "gap reconciler: no unassigned gaps to cluster");
    return 0;
  }

  const embedding = ctx.providers.embedding;
  if (!embedding) {
    return assignNewGapsBySummary(ctx, flowId, flowLabel, pending);
  }
  return assignNewGapsByEmbedding(ctx, flowId, flowLabel, pending, embedding);
}

// The original phase-1 behaviour: one new cluster per distinct summary. Kept
// for deployments with no embedding provider configured (keyword-only mode).
async function assignNewGapsBySummary(
  ctx: AppContext,
  flowId: string | undefined,
  flowLabel: string,
  pending: PendingCandidate[]
): Promise<number> {
  let clustersCreated = 0;
  for (const entry of pending) {
    const revision = await ctx.stores.questionLogs.getGapCatalogRevision(flowId);
    const cluster = await ctx.stores.gapClusters.createCluster({
      flowId: entry.candidate.flowId,
      title: entry.candidate.summary.slice(0, 80),
      revision
    });
    clustersCreated += 1;
    await ctx.stores.gapClusters.assignGapsToCluster(cluster.id, entry.gapIds, "initial assignment");
  }
  logger.info(
    { flowLabel, clustersCreated },
    "gap reconciler: created new clusters from unassigned gaps (no embedding provider; exact-summary buckets)"
  );
  return clustersCreated;
}

// Embedding-based phase 1. All similarity decisions are made against the
// tick-start snapshot of cluster representatives (see planAssignments), so the
// outcome is order-independent and a re-raised identical gap re-lands
// deterministically. An embed failure here is an infra failure and is rethrown:
// the tick records a failed MaintenanceRun and retries later, rather than
// silently degrading into the 100-singleton fallback (#150 principle).
async function assignNewGapsByEmbedding(
  ctx: AppContext,
  flowId: string | undefined,
  flowLabel: string,
  pending: PendingCandidate[],
  embedding: EmbeddingProvider
): Promise<number> {
  const threshold = ctx.settings.gapClustering.assignThreshold;

  // Representatives for this flow's active clusters, recomputing any that are
  // missing (pre-feature rows, or nulled by a reshape/prune composition change)
  // from their distinct active member summaries.
  const clusters = await ctx.stores.gapClusters.listActiveClustersForFlow(flowId);
  const representatives: ClusterRepresentative[] = [];
  const memberSummaryCounts = new Map<string, number>();
  for (const cluster of clusters) {
    if (cluster.representativeEmbedding) {
      representatives.push({ clusterId: cluster.id, embedding: cluster.representativeEmbedding });
      continue;
    }
    const members = await ctx.stores.gapClusters.listMembershipsForCluster(cluster.id);
    if (members.length === 0) {
      continue; // emptied clusters are frozen in step 0b; defensive only
    }
    const { summaries } = await ctx.stores.questionLogs.gapDetailsForIds(members.map((m) => m.gapId));
    if (summaries.length === 0) {
      continue;
    }
    const representative = normalisedMean(await embedAll(embedding, summaries));
    await ctx.stores.gapClusters.setClusterRepresentative(cluster.id, representative);
    representatives.push({ clusterId: cluster.id, embedding: representative });
    memberSummaryCounts.set(cluster.id, summaries.length);
  }

  const vectors = await embedAll(embedding, pending.map((entry) => entry.candidate.summary));
  const entriesByKey = new Map(pending.map((entry, index) => [entry.key, { entry, embedding: vectors[index] }]));
  const plan = planAssignments(
    pending.map((entry, index) => ({ key: entry.key, embedding: vectors[index] })),
    representatives,
    threshold
  );

  // Joins: move the gaps in, then fold the genuinely-new summaries into the
  // stored centroid (see foldIntoCentroid for why n·r is a safe stand-in for
  // the member-vector sum). A summary already present — a re-raised identical
  // gap — must not re-weight the centroid.
  let joinedCandidates = 0;
  for (const [clusterId, keys] of plan.joins) {
    const representative = representatives.find((r) => r.clusterId === clusterId);
    const members = await ctx.stores.gapClusters.listMembershipsForCluster(clusterId);
    const { summaries } = await ctx.stores.questionLogs.gapDetailsForIds(members.map((m) => m.gapId));
    const existingSummaries = new Set(summaries);
    const additions: number[][] = [];
    for (const key of keys) {
      const match = entriesByKey.get(key);
      if (!match) {
        continue;
      }
      await ctx.stores.gapClusters.assignGapsToCluster(clusterId, match.entry.gapIds, "assigned by embedding similarity");
      joinedCandidates += 1;
      if (!existingSummaries.has(match.entry.candidate.summary)) {
        additions.push(match.embedding);
      }
    }
    if (representative && additions.length > 0) {
      const priorCount = memberSummaryCounts.get(clusterId) ?? existingSummaries.size;
      const updated = foldIntoCentroid(representative.embedding, Math.max(priorCount, 1), additions);
      await ctx.stores.gapClusters.setClusterRepresentative(clusterId, updated);
    }
  }

  // Seeds: one cluster per connected component of unmatched candidates. The
  // component keys are sorted, and the key embeds the summary after a fixed
  // per-flow prefix, so entry[0] is the lexicographically-first summary —
  // matching the fallback path's title choice.
  let clustersCreated = 0;
  for (const componentKeys of plan.seeds) {
    const entries = componentKeys
      .map((key) => entriesByKey.get(key))
      .filter((match): match is NonNullable<typeof match> => match !== undefined);
    if (entries.length === 0) {
      continue;
    }
    const revision = await ctx.stores.questionLogs.getGapCatalogRevision(flowId);
    const cluster = await ctx.stores.gapClusters.createCluster({
      flowId: entries[0].entry.candidate.flowId,
      title: entries[0].entry.candidate.summary.slice(0, 80),
      revision,
      representativeEmbedding: normalisedMean(entries.map((match) => match.embedding))
    });
    clustersCreated += 1;
    for (const match of entries) {
      await ctx.stores.gapClusters.assignGapsToCluster(
        cluster.id,
        match.entry.gapIds,
        entries.length > 1 ? "seeded with paraphrase group" : "initial assignment"
      );
    }
  }

  logger.info(
    { flowLabel, clustersCreated, joinedCandidates, threshold },
    "gap reconciler: assigned new gaps by embedding similarity"
  );
  return clustersCreated;
}

// Embeds a batch and L2-normalises every vector, refusing a mismatched batch
// (same guard as embed-sections.ts).
async function embedAll(provider: EmbeddingProvider, texts: string[]): Promise<number[][]> {
  const vectors = await provider.embed(texts);
  if (vectors.length !== texts.length) {
    throw new Error(`embedding provider returned ${vectors.length} vector(s) for ${texts.length} input(s)`);
  }
  return vectors.map(l2Normalise);
}
```

(d) Null representatives on composition change:

- In `applyMerge`, after the `for (const cluster of clusters)` loop and before `await ctx.stores.gapClusters.updateCluster(survivorId, { revision });`:

```ts
  // The survivor's composition changed; null its representative so the next
  // assignment pass recomputes the centroid from the merged membership.
  await ctx.stores.gapClusters.setClusterRepresentative(survivorId, null);
```

- In `applySplit`, before `await ctx.stores.gapClusters.updateCluster(original.id, { revision });`:

```ts
  // The retained cluster lost members to its children; null its representative
  // for lazy recompute. Children are created without one and recompute the same
  // way.
  await ctx.stores.gapClusters.setClusterRepresentative(original.id, null);
```

- In `pruneResolvedMemberships`, replace the final `if (resolved.length > 0) { ... }` block with:

```ts
  if (resolved.length > 0) {
    await ctx.stores.gapClusters.deactivateMembershipsForGaps(resolved);
    // Pruning changed those clusters' compositions; null their representatives
    // so the next assignment pass recomputes the centroids without the
    // resolved gaps.
    const resolvedSet = new Set(resolved);
    const affectedClusterIds = new Set(
      active.filter((m) => resolvedSet.has(m.gapId)).map((m) => m.clusterId)
    );
    for (const clusterId of affectedClusterIds) {
      await ctx.stores.gapClusters.setClusterRepresentative(clusterId, null);
    }
  }
```

- [ ] **Step 4: Run the reconciler suite**

Run: `node --import tsx --test apps/api/src/scheduling/gap-reconciler.test.ts`
Expected: ALL tests pass — the 5 new ones and every pre-existing one (fallback path unchanged for provider-less contexts).

- [ ] **Step 5: Full validation**

```bash
npm run build && npm run typecheck && npm test && npm run lint && npm run deadcode
```

Expected: all green. knip must be satisfied: every Task-1 export is now consumed (`planAssignments`/`l2Normalise` also by the eval script, but scripts are knip-ignored — the reconciler + tests are the in-project consumers; if knip still flags `cosineSimilarity` or `normalisedMean`, they are consumed by tests and the reconciler respectively — investigate rather than suppress, and de-export anything genuinely unused).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/scheduling/
git commit -m "feat(reconcile): embedding-based phase-1 gap bucketing with lazy centroid maintenance"
git push
```

---

### Task 6: Docs, gates, PR

**Files:**
- Modify: `docs/architecture.md` (gap-reconciler / clustering section, ~lines 154–300)
- Modify: `docs/question-logging.md` (env-knob documentation, where `FLOW_ROUTER_MIN_SCORE` lives)
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-07-07-gap-embedding-bucketing-design.md` (record the eval-chosen T + evidence table under a short "Implementation notes" heading)

**Interfaces:** none — documentation and delivery.

- [ ] **Step 1: Update `docs/architecture.md`**

Find the paragraph describing clustering/reconciliation (near the "prunes resolved gaps" text ~line 289 and the reshape description ~line 173). Add a paragraph after the reshape description:

```markdown
**Phase-1 assignment is an embedding-based coarse pre-clusterer.** Before the
reshape, each unassigned gap is embedded inline (embeddings are the sanctioned
inline exception to queue-only) and compared, within its flow only, against each
active cluster's stored representative embedding — the normalised centroid of
the cluster's distinct member gap summaries (`gap_clusters.representative_embedding`,
migration 0046). A gap joins the nearest cluster at or above
`GAP_CLUSTER_ASSIGN_THRESHOLD` (a conservative default set by the offline sweep
in `scripts/eval-gap-threshold.ts`); the rest form connected components that each
seed one new cluster, so a burst of paraphrased gaps ("TLS versions in transit"
vs "encryption protocols in transit") lands as one bucket instead of N
singletons. Decisions are made against a tick-start snapshot, so assignment is
order-independent and reproducible. The threshold deliberately collapses only
obvious paraphrases — semantic cousins (in-transit vs at-rest) stay separate for
the reshape critic to adjudicate, which remains the semantic refiner. A cluster
whose composition changes (merge, split, resolved-gap pruning) has its
representative nulled and lazily recomputed on the next assignment pass. With no
embedding provider configured, phase 1 falls back to the original
one-cluster-per-distinct-summary behaviour; if the provider is configured but an
embed call fails, the tick fails and retries rather than silently fanning out
singletons.
```

Adapt placement/wording to the surrounding text — it must read as part of the existing section, not a bolted-on block.

- [ ] **Step 2: Document the env knob**

In `docs/question-logging.md`, where `FLOW_ROUTER_MIN_SCORE`/`FLOW_ROUTER_MIN_MARGIN` are documented, add `GAP_CLUSTER_ASSIGN_THRESHOLD` in the same style: what it gates (phase-1 join/seed cosine floor), the default (the eval-chosen T), the fallback-on-invalid behaviour, and the pointer to `npm run eval:gap-threshold` for re-tuning evidence.

In `.env.example`, next to the flow-router entries (or the embeddings block if that's where tuning knobs sit):

```bash
# Cosine floor for the gap reconciler's phase-1 assignment (join an existing
# cluster / seed a shared cluster). Conservative by design; re-tune with
# `npm run eval:gap-threshold`. Blank or out-of-range falls back to the default.
#GAP_CLUSTER_ASSIGN_THRESHOLD=<T>
```

- [ ] **Step 3: Record the eval evidence in the spec**

Append to `docs/superpowers/specs/2026-07-07-gap-embedding-bucketing-design.md`:

```markdown
## Implementation notes (post-eval)

Chosen threshold: **<T>** — lowest zero-over-merge sweep value <T-0.02> + 0.02
margin, from `npm run eval:gap-threshold` over the committed fixture
(`scripts/fixtures/gap-threshold-embeddings.json`, model
`openai/text-embedding-3-small`):

| T | components | precision | recall | over-merges |
|---|-----------|-----------|--------|-------------|
| (paste the chosen row and its two neighbours from the sweep table) |
```

- [ ] **Step 4: Run every gate**

```bash
npm run build && npm run typecheck && npm test && npm run lint && npm run deadcode && npm run format:check
npm run test:db
```

Expected: all green. Fix anything that isn't before proceeding.

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add docs/ .env.example
git commit -m "docs: embedding-based phase-1 gap bucketing (architecture, env knob, eval evidence)"
git push
gh pr create --title "feat(reconcile): embedding-based phase-1 gap bucketing" --body "<summary: problem (100-singleton fan-out), design (phase-1 coarse pre-clusterer, reshape untouched), eval evidence table with chosen T, validation gates run>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: PR opens against `main`; the 4 required checks run there.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** algorithm (Task 5), fallback + failure semantics (Task 5 + tests), storage/migration (Task 4), config knob (Task 3), pure core + determinism (Task 1), eval-before-commit (Task 2 ordered before Tasks 3–5 set/consume T), preserved safeguards (existing suite green, Tasks 5–6), docs (Task 6). ✔
- **Placeholder scan:** `<T>` / `<T-0.02>` are deliberate late-bound values produced by Task 2 and substituted in Tasks 3/6 — the only permitted "fill-ins", each with an explicit decision rule. ✔
- **Type consistency:** `setClusterRepresentative(id, number[] | null)`, `representativeEmbedding?: number[]`, `planAssignments(candidates, representatives, threshold) → { joins: Map<string,string[]>, seeds: string[][] }`, `foldIntoCentroid(rep, priorCount, additions)` used identically across Tasks 1/4/5. `ctx.settings.gapClustering.assignThreshold` matches Task 3's AppConfig shape. ✔
