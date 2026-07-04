import { routeByEmbeddingSimilarity, type EmbeddedFlow, type EmbeddingRoute } from "@magpie/retrieval";
import { logger } from "../../logger.js";
import type { AppContext } from "../../context.js";

interface RouteFlow {
  id: string;
  name: string;
  persona?: string;
}

export interface RouteRequest {
  question: string;
  flows: RouteFlow[];
}

// The decision is the pure router's outcome verbatim: a confident winner, or an
// abstention the watcher answers by falling back to the chat router.
export type RouteResult = EmbeddingRoute;

// Flow embeddings memoized per AppContext, keyed by the flow's routing text. A
// WeakMap keyed on the context means each process/test gets its own cache (no
// cross-context bleed) and it is collected with the context; flows are static per
// process, so at steady state only the question is embedded per request.
const flowVectorCaches = new WeakMap<AppContext, Map<string, number[]>>();

function cacheFor(ctx: AppContext): Map<string, number[]> {
  let cache = flowVectorCaches.get(ctx);
  if (!cache) {
    cache = new Map();
    flowVectorCaches.set(ctx, cache);
  }
  return cache;
}

// The text a flow is embedded from: its name, its admin-authored routing summary
// (topical scope — the strongest routing signal, resolved from config by id), and
// its persona. Any of the three may be absent. The summary is looked up server-side
// rather than trusted from the request so routing always reflects the current config.
function flowText(flow: RouteFlow, routingSummary: string | undefined): string {
  return [flow.name, routingSummary, flow.persona].filter((part) => part && part.trim().length > 0).join("\n");
}

/**
 * Cheap embedding-similarity flow routing. Embeds the question (and any not-yet-cached
 * flow texts) in a single provider call, then delegates the decision to the pure
 * `routeByEmbeddingSimilarity`. Returns `abstain` when no embedding provider is
 * configured or the embedding call fails — routing must never fail the ask, and the
 * watcher answers an abstention with the chat router.
 */
export async function route(ctx: AppContext, request: RouteRequest): Promise<RouteResult> {
  const provider = ctx.providers.embedding;
  if (!provider || request.flows.length === 0) {
    return { status: "abstain" };
  }

  // The routing summary is the topical scope signal, resolved from the current config
  // by flow id (not trusted from the request), so routing reflects the live config.
  const summaryById = new Map(ctx.knowledgeConfig.flows.map((flow) => [flow.id, flow.routingSummary]));
  const textFor = (flow: RouteFlow): string => flowText(flow, summaryById.get(flow.id));

  const cache = cacheFor(ctx);
  const uniqueMissing = [...new Set(request.flows.map(textFor).filter((text) => !cache.has(text)))];

  try {
    // One batched embedding call: the question first, then any uncached flow texts.
    const vectors = await provider.embed([request.question, ...uniqueMissing]);
    const questionVector = vectors[0];
    uniqueMissing.forEach((text, index) => {
      cache.set(text, vectors[index + 1]);
    });

    const flows: EmbeddedFlow[] = request.flows.map((flow) => ({
      id: flow.id,
      vector: cache.get(textFor(flow)) ?? []
    }));
    return routeByEmbeddingSimilarity(questionVector, flows, ctx.settings.flowRouter);
  } catch (error) {
    logger.warn({ err: error }, "embedding flow routing failed; abstaining to the chat router");
    return { status: "abstain" };
  }
}
