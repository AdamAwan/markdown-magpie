export interface PromptDefinition {
  /** Stable kebab-case identifier, e.g. "crunch-knowledge-base". */
  id: string;
  /** Human-readable title shown in the UI. */
  title: string;
  /** What the prompt is for. */
  description: string;
  /** Where this prompt is used, e.g. ["watcher", "watcher · routing"]. */
  usedBy: string[];
  /** Short description of the JSON the model must return. */
  outputShape: string;
  /** Canonical instruction text (no runtime data baked in). Single source of truth. */
  instructions: string;
}
