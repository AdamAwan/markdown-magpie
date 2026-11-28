// Public barrel for @magpie/retrieval. Implementation lives in focused modules;
// this file only re-exports so the package's import surface stays stable.
export * from "./chat-providers.js";
export * from "./routing.js";
export * from "./flow-router.js";
export * from "./rrf.js";
export * from "./embeddings.js";
export * from "./query-embedding.js";
export {
  DEFAULT_CHAT_RETRY_POLICY,
  ProviderOutputTruncatedError,
  ProviderRequestError,
  type ProviderFailureKind,
  type RetryHooks,
  type RetryPolicy
} from "./http.js";
