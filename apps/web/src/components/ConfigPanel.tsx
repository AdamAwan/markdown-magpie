import { useEffect, useState } from "react";
import { AiExecutionMode, AiProviderName, RuntimeConfig, UiMessage } from "../lib/types";
import { apiGet, apiPost, errorMessage } from "../lib/api";

export function ConfigPanel({
  apiBaseUrl,
  config,
  onConfigChange,
  onMessage
}: {
  apiBaseUrl: string;
  config?: RuntimeConfig;
  onConfigChange: (config: RuntimeConfig) => void;
  onMessage: (message: string, tone?: UiMessage["tone"]) => void;
}) {
  const [executionMode, setExecutionMode] = useState<AiExecutionMode>("direct");
  const [provider, setProvider] = useState<AiProviderName>("mock");
  const [saving, setSaving] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!config) {
      return;
    }

    setExecutionMode(config.aiRuntime.executionMode);
    setProvider(config.aiRuntime.provider);
  }, [config]);

  if (!config) {
    return (
      <section className="surface">
        <div className="surfaceHeader">
          <h2>Runtime Config</h2>
        </div>
        <div className="surfaceBody">
          <p className="empty">Config has not loaded yet.</p>
        </div>
      </section>
    );
  }

  const providerOptions = config.aiRuntime.providers.filter((item) =>
    executionMode === "direct" ? item.supportsDirect : item.supportsQueue
  );
  const selectedProvider = providerOptions.some((item) => item.name === provider) ? provider : providerOptions[0]?.name ?? "mock";

  async function resetData() {
    setResetting(true);
    setConfirmingReset(false);
    onMessage("");
    try {
      const result = await apiPost<{ reindexed: number; failures: Array<{ target: string; message: string }> }>(
        "/admin/reset",
        {}
      );
      // Re-fetch config so the reset runtime AI config is reflected in the panel.
      const refreshed = await apiGet<RuntimeConfig>("/config");
      onConfigChange(refreshed);
      const failureNote = result.failures.length > 0 ? ` (${result.failures.length} source(s) failed to re-index)` : "";
      onMessage(`Data reset. Re-indexed ${result.reindexed} knowledge source(s)${failureNote}.`, result.failures.length > 0 ? "danger" : "success");
    } catch (error) {
      onMessage(errorMessage(error), "danger");
    } finally {
      setResetting(false);
    }
  }

  async function saveRuntimeConfig() {
    if (!config) {
      return;
    }

    setSaving(true);
    onMessage("");
    try {
      const result = await apiPost<RuntimeConfig>("/config", {
        ai: {
          executionMode,
          provider: selectedProvider
        }
      });
      onConfigChange(result);
      onMessage("Runtime AI config updated.", "success");
    } catch (error) {
      onMessage(errorMessage(error), "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Runtime Config</h2>
        <span className="pill" title="Browser-facing API base URL">
          {apiBaseUrl}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="runtimeEditor">
          <div className="configControl">
            <span>Execution</span>
            <div className="segmented" role="group" aria-label="AI execution mode">
              {config.aiRuntime.executionModes.map((mode) => (
                <button
                  className={executionMode === mode ? "segment active" : "segment"}
                  key={mode}
                  onClick={() => {
                    setExecutionMode(mode);
                    const nextProvider = config.aiRuntime.providers.find((item) =>
                      mode === "direct" ? item.supportsDirect : item.supportsQueue
                    )?.name;
                    if (nextProvider && !config.aiRuntime.providers.find((item) => item.name === provider && (mode === "direct" ? item.supportsDirect : item.supportsQueue))) {
                      setProvider(nextProvider);
                    }
                  }}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <label className="configControl">
            <span>Provider</span>
            <select onChange={(event) => setProvider(event.target.value as AiProviderName)} value={selectedProvider}>
              {providerOptions.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button"
            disabled={
              saving ||
              resetting ||
              (executionMode === config.aiRuntime.executionMode && selectedProvider === config.aiRuntime.provider)
            }
            onClick={() => void saveRuntimeConfig()}
            type="button"
          >
            {saving ? "Saving" : "Apply"}
          </button>
        </div>
        <div className="configStack">
          <ConfigGroup title="API" value={{ ...config.api, browserApiBaseUrl: apiBaseUrl }} />
          <ConfigGroup title="Stores" value={config.stores} />
          <ConfigGroup title="Knowledge" value={config.knowledge} />
          <ConfigGroup title="Retrieval" value={{
            mode: config.retrieval.mode,
            embeddingProvider: config.retrieval.embeddingProvider,
            reason: config.retrieval.reason
          }} />
          <ConfigGroup title="Providers" value={config.providers} />
          <ConfigGroup title="Watcher" value={config.watcher} />
        </div>
        <div className="resetControl">
          <h3>Demo controls</h3>
          <p className="empty">
            Deletes all questions, proposals, gaps and jobs, resets AI config, and re-indexes the
            knowledge bases from configuration.
          </p>
          {confirmingReset ? (
            <div className="resetConfirm">
              <span>This permanently deletes all app data. Continue?</span>
              <button className="button danger" disabled={resetting} onClick={() => void resetData()} type="button">
                {resetting ? "Resetting" : "Confirm reset"}
              </button>
              <button className="button" disabled={resetting} onClick={() => setConfirmingReset(false)} type="button">
                Cancel
              </button>
            </div>
          ) : (
            <button className="button danger" disabled={resetting} onClick={() => setConfirmingReset(true)} type="button">
              Reset data
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function ConfigGroup({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <section className="configGroup">
      <h3>{title}</h3>
      <dl>
        {Object.entries(flattenConfig(value)).map(([key, itemValue]) => (
          <div className="configRow" key={key}>
            <dt>{key}</dt>
            <dd>{String(itemValue ?? "not set")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function flattenConfig(value: Record<string, unknown>, prefix = ""): Record<string, string | number | null> {
  return Object.entries(value).reduce<Record<string, string | number | null>>((result, [key, itemValue]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (itemValue && typeof itemValue === "object" && !Array.isArray(itemValue)) {
      return {
        ...result,
        ...flattenConfig(itemValue as Record<string, unknown>, nextKey)
      };
    }

    result[nextKey] = typeof itemValue === "string" || typeof itemValue === "number" || itemValue === null ? itemValue : JSON.stringify(itemValue);
    return result;
  }, {});
}
