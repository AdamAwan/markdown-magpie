import type { ChatProvider, Confidence } from "@magpie/core";
import type { Logger } from "@magpie/logger";
import { ROUTE_QUESTION_TO_FLOW } from "@magpie/prompts";
import { normalizeConfidence, parseJsonObject } from "./parse.js";

// Minimal shape the router needs from a configured flow.
export interface RoutableFlow {
  id: string;
  name: string;
  persona?: string;
}

/**
 * Outcome of routing a question across the configured flows.
 *
 * - `routed` — a flow was chosen (or exactly one flow is configured).
 * - `unknown` — the model *deliberately* abstained: no flow clearly matches, so
 *   the caller should be asked to pick one and re-ask.
 * - `unroutable` — routing could not run or produced untrustworthy output
 *   (provider error, unparseable response, a hallucinated/unknown id, or zero
 *   flows). The caller degrades to an unscoped answer; routing must never fail
 *   the ask, so infrastructure problems land here rather than in `unknown`.
 */
export type FlowRoute =
  | { status: "routed"; flowId: string; confidence: Confidence; rationale?: string }
  | { status: "unknown" }
  | { status: "unroutable" };

/**
 * Picks the single best-matching flow for a question via the chat provider.
 *
 * Short-circuits (no AI call) when zero or one flow is configured. A deliberate
 * model abstention (`flowId: null`) returns `unknown`; provider/parse failures
 * and unknown ids return `unroutable` so the caller can fall back to an unscoped
 * answer. The provider call is wrapped because routing must never fail the ask.
 */
export async function routeQuestionToFlow(
  question: string,
  flows: RoutableFlow[],
  chatProvider: ChatProvider,
  logger?: Logger
): Promise<FlowRoute> {
  if (flows.length === 0) {
    return { status: "unroutable" };
  }
  if (flows.length === 1) {
    return { status: "routed", flowId: flows[0].id, confidence: "high" };
  }

  let content: string;
  try {
    const response = await chatProvider.complete({
      system: ROUTE_QUESTION_TO_FLOW.instructions,
      messages: [
        {
          role: "user",
          content: `Question:\n${question}\n\nFlows:\n${JSON.stringify(
            flows.map((flow) => ({ id: flow.id, name: flow.name, persona: flow.persona })),
            null,
            2
          )}`
        }
      ],
      responseFormat: "json"
    });
    content = response.content;
  } catch (error) {
    // Routing must never fail the ask, but a silent swallow hides a misconfigured
    // provider. Log (when a logger is supplied) and degrade to an unscoped answer.
    logger?.warn({ err: error }, "flow routing provider call failed; answering unscoped");
    return { status: "unroutable" };
  }

  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== "object") {
    return { status: "unroutable" };
  }

  const candidate = parsed as { flowId?: unknown; confidence?: unknown; rationale?: unknown };

  // The model abstained: no flow clearly matches. Ask the caller to pick one
  // rather than guessing or silently answering unscoped.
  if (candidate.flowId === null) {
    return { status: "unknown" };
  }

  const flowId = typeof candidate.flowId === "string" ? candidate.flowId.trim() : undefined;
  if (!flowId || !flows.some((flow) => flow.id === flowId)) {
    return { status: "unroutable" };
  }

  return {
    status: "routed",
    flowId,
    confidence: normalizeConfidence(candidate.confidence),
    ...(typeof candidate.rationale === "string" ? { rationale: candidate.rationale } : {})
  };
}
