import { routeByEmbeddingSimilarity, type EmbeddedFlow, type EmbeddingRoute } from "@magpie/retrieval";
import { logger } from "../../logger.js";
import type { AppContext } from "../../context.js";

export interface RouteFlow {
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

// The text a flow is embedded from: its name plus persona (the persona already
// absorbs a flow's optional description at config load).
function flowText(flow: RouteFlow): string {
  return flow.persona ? `${flow.name}\n${flow.persona}` : flow.name;
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

  const cache = cacheFor(ctx);
  const missing = request.flows.map(flowText).filter((text) => !cache.has(text));
  const uniqueMissing = [...new Set(missing)];

  try {
    // One batched embedding call: the question first, then any uncached flow texts.
    const vectors = await provider.embed([request.question, ...uniqueMissing]);
    const questionVector = vectors[0];
    uniqueMissing.forEach((text, index) => {
      cache.set(text, vectors[index + 1]);
    });

    const flows: EmbeddedFlow[] = request.flows.map((flow) => ({
      id: flow.id,
      vector: cache.get(flowText(flow)) ?? []
    }));
    return routeByEmbeddingSimilarity(questionVector, flows, ctx.settings.flowRouter);
  } catch (error) {
    logger.warn({ err: error }, "embedding flow routing failed; abstaining to the chat router");
    return { status: "abstain" };
  }
}
