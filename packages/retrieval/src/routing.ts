import type { ChatProvider, FlowRouteDecision } from "@magpie/core";
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
 * Picks the single best-matching flow for a question via the chat provider.
 *
 * Short-circuits (no AI call) when zero or one flow is configured. Returns
 * `undefined` — letting the caller fall back to a default flow — when the model
 * errors, returns unparseable output, or names a flow id that is not configured.
 * Routing must never fail the ask, so the provider call is wrapped.
 */
export async function routeQuestionToFlow(
  question: string,
  flows: RoutableFlow[],
  chatProvider: ChatProvider,
  logger?: Logger
): Promise<FlowRouteDecision | undefined> {
  if (flows.length <= 1) {
    return flows[0] ? { flowId: flows[0].id, confidence: "high" } : undefined;
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
      ]
    });
    content = response.content;
  } catch (error) {
    // Routing must never fail the ask, but a silent swallow hides a misconfigured
    // provider. Log (when a logger is supplied) and degrade to the default flow.
    logger?.warn({ err: error }, "flow routing provider call failed; using default flow");
    return undefined;
  }

  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const candidate = parsed as { flowId?: unknown; confidence?: unknown; rationale?: unknown };
  const flowId = typeof candidate.flowId === "string" ? candidate.flowId.trim() : undefined;
  if (!flowId || !flows.some((flow) => flow.id === flowId)) {
    return undefined;
  }

  return {
    flowId,
    confidence: normalizeConfidence(candidate.confidence),
    rationale: typeof candidate.rationale === "string" ? candidate.rationale : undefined
  };
}
