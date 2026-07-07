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
import { cosineSimilarity, planAssignments } from "../apps/api/src/scheduling/gap-assignment.js";
import { createEmbeddingProvider } from "../packages/retrieval/src/embeddings.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(rootDir, "scripts", "fixtures", "gap-threshold-embeddings.json");

// The labelled corpus. Constructed (no labelled production corpus exists);
// themes mirror the compliance-questionnaire domain of the 100-gap incident.
// Adjacent themes are deliberate near-cousin traps: in-transit vs at-rest,
// backup vs log retention, MFA vs SSO, pen-test vs vuln-scan, incident
// response vs breach notification. Singletons include trap wordings too
// (key rotation vs at-rest encryption, PII-in-logs vs log retention).
// Each theme mixes LOOSE paraphrases (same topic, different framing) with
// NEAR-IDENTICAL rewordings (marked ~) of the kind repeated model re-answers of
// the same underlying gap actually produce. The near-identical pairs are the
// wins phase 1 must bank; the loose ones show what stays for the reshape critic.
const themes: Record<string, string[]> = {
  "tls-in-transit": [
    "What TLS versions are supported for data in transit?",
    "Which TLS versions are supported for data in transit?", // ~
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
    "How long are database backups retained?", // ~
    "What is the backup retention period?",
    "For how many days are database backups kept?"
  ],
  "log-retention": ["How long are audit logs retained?", "What is the log retention period?"],
  mfa: [
    "Is multi-factor authentication enforced for staff?",
    "Is multi-factor authentication required for staff?", // ~
    "Do employees use MFA to sign in?",
    "Is two-factor authentication required for internal access?"
  ],
  sso: [
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
    "Where is customer data geographically stored?", // ~
    "In which regions does customer data reside?",
    "Can data be pinned to the EU region?"
  ],
  subprocessors: [
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
  "disaster-recovery": ["What is the disaster recovery RTO?", "How fast can service be restored after a major outage?"],
  soc2: [
    "Is a SOC 2 Type II report available?",
    "Is a SOC 2 Type 2 report available?", // ~
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

function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.join(rootDir, ".env"));
  } catch {
    // No .env — rely on the shell environment.
  }
}

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
    throw new Error("No cached fixture and no OPENAI_COMPATIBLE_EMBEDDING_* credentials in the environment/.env");
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
  const entries: Array<[string, number[]]> = texts.map((text, i) => [
    text,
    vectors[i].map((v) => Number(v.toPrecision(7)))
  ]);
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, JSON.stringify(Object.fromEntries(entries)), "utf8");
  console.log(`Wrote fixture ${path.relative(rootDir, fixturePath)}`);
  return new Map(entries);
}

interface SweepRow {
  threshold: number;
  components: number;
  pairPrecision: number;
  pairRecall: number;
  overMerges: number;
}

function countPositivePairs(): number {
  let pairs = 0;
  for (const texts of Object.values(themes)) {
    pairs += (texts.length * (texts.length - 1)) / 2;
  }
  return pairs;
}

// Prints the raw pair-similarity landscape: every same-theme pair (these must
// sit ABOVE a usable threshold) and the highest-scoring cross-label pairs
// (these must sit BELOW it). Run with --pairs when the sweep looks off.
function printPairDiagnostics(embeddings: Map<string, number[]>): void {
  const entries = corpus.map((entry) => ({
    ...entry,
    embedding: embeddings.get(entry.text)
  }));
  const pairs: Array<{ a: string; b: string; same: boolean; similarity: number }> = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i];
      const right = entries[j];
      if (!left.embedding || !right.embedding) continue;
      pairs.push({
        a: `${left.label}: ${left.text}`,
        b: `${right.label}: ${right.text}`,
        same: left.label === right.label,
        similarity: cosineSimilarity(left.embedding, right.embedding)
      });
    }
  }
  const samePairs = pairs.filter((p) => p.same).sort((l, r) => l.similarity - r.similarity);
  const crossPairs = pairs.filter((p) => !p.same).sort((l, r) => r.similarity - l.similarity);
  console.log("\nSame-theme pairs (ascending — the floor a threshold must reach down to):");
  for (const pair of samePairs) {
    console.log(`  ${pair.similarity.toFixed(3)}  ${pair.a}  <->  ${pair.b}`);
  }
  console.log("\nTop 15 cross-label pairs (the impostors a threshold must stay above):");
  for (const pair of crossPairs.slice(0, 15)) {
    console.log(`  ${pair.similarity.toFixed(3)}  ${pair.a}  <->  ${pair.b}`);
  }
}

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");
  const embeddings = await loadOrEmbed(refresh);

  if (process.argv.includes("--pairs")) {
    printPairDiagnostics(embeddings);
  }

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
      ` ${row.threshold.toFixed(2)}  ${String(row.components).padStart(10)}  ${row.pairPrecision
        .toFixed(3)
        .padStart(9)}  ${row.pairRecall.toFixed(3).padStart(6)}  ${String(row.overMerges).padStart(11)}`
    );
  }

  const clean = rows.filter((row) => row.overMerges === 0);
  if (clean.length === 0) {
    console.log("\nNo threshold in the sweep produced zero over-merges — inspect the corpus/model.");
    return;
  }
  const lowestClean = clean.reduce((best, row) => (row.threshold < best.threshold ? row : best), clean[0]);
  console.log(
    `\nLowest zero-over-merge threshold: ${lowestClean.threshold.toFixed(2)} ` +
      `(recall ${lowestClean.pairRecall.toFixed(3)}). ` +
      `Recommended default: ${(lowestClean.threshold + 0.02).toFixed(2)} (0.02 safety margin).`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
