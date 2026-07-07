import { useEffect, useState } from "react";
import styled from "@emotion/styled";
import { AI_PROVIDERS, AiProviderName, RuntimeConfig, UiMessage } from "../lib/types";
import { apiGet, apiPost, errorMessage } from "../lib/api";
import { Badge, Button, EmptyState, Field, Select, Surface } from "./ui";

// Static provider labels. In the queue-only world the API never runs AI inline
// and watchers hold the provider credentials, so all four providers are always
// selectable here — availability is no longer gated by API-side credentials.
const PROVIDER_LABELS: Record<AiProviderName, string> = {
  "openai-compatible": "OpenAI-compatible",
  "azure-openai": "Azure OpenAI",
  codex: "Codex",
  claude: "Claude"
};

// The runtime AI editor: provider picker plus its apply action, laid out as a
// responsive grid so the control and button sit on one row on wide screens.
const RuntimeEditor = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(180px, 0.8fr) minmax(220px, 1fr) auto",
  gap: theme.space.lg,
  alignItems: "end",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  padding: theme.space.lg
}));

const ConfigStack = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: theme.space.lg
}));

const ConfigGroupCard = styled.section(({ theme }) => ({
  minWidth: 0,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  padding: theme.space.lg,
  "& > dl": {
    display: "grid",
    gap: theme.space.md,
    margin: `${theme.space.lg} 0 0`
  }
}));

const ConfigRow = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(130px, 0.42fr) minmax(0, 1fr)",
  gap: theme.space.md,
  alignItems: "start",
  borderTop: `1px solid ${theme.color.border}`,
  paddingTop: theme.space.md,
  "&:first-of-type": {
    borderTop: 0,
    paddingTop: 0
  },
  "& > dt": {
    color: theme.color.textMuted,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.semibold
  },
  "& > dd": {
    minWidth: 0,
    margin: 0,
    overflowWrap: "anywhere",
    color: theme.color.text,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm
  }
}));

const ResetControl = styled.div(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  gap: theme.space.md,
  marginTop: theme.space.xl
}));

const ResetConfirm = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md,
  flexWrap: "wrap"
}));

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
  const [provider, setProvider] = useState<AiProviderName>(AI_PROVIDERS[0]);
  const [saving, setSaving] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Once the user touches the controls we stop mirroring server config into local
  // state, so a background refresh can't reset their pending selection mid-edit.
  // Saving clears the flag, re-syncing to the freshly persisted values.
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!config || dirty) {
      return;
    }

    setProvider(config.aiRuntime.provider);
  }, [config, dirty]);

  if (!config) {
    return (
      <Surface>
        <Surface.Header>
          <h2>Runtime Config</h2>
        </Surface.Header>
        <Surface.Body>
          <EmptyState>Config has not loaded yet.</EmptyState>
        </Surface.Body>
      </Surface>
    );
  }

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
      onMessage(
        `Data reset. Re-indexed ${result.reindexed} knowledge source(s)${failureNote}.`,
        result.failures.length > 0 ? "danger" : "success"
      );
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
          provider
        }
      });
      onConfigChange(result);
      // Persisted: drop the dirty guard so the panel re-mirrors server values.
      setDirty(false);
      onMessage("Runtime AI config updated.", "success");
    } catch (error) {
      onMessage(errorMessage(error), "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Surface>
      <Surface.Header>
        <h2>Runtime Config</h2>
        <Badge tone="neutral" mono title="Browser-facing API base URL">
          {apiBaseUrl}
        </Badge>
      </Surface.Header>
      <Surface.Body>
        <RuntimeEditor>
          <Field label="Provider">
            <Select
              onChange={(event) => {
                setDirty(true);
                setProvider(event.target.value as AiProviderName);
              }}
              value={provider}
            >
              {AI_PROVIDERS.map((name) => (
                <option key={name} value={name}>
                  {PROVIDER_LABELS[name]}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={saving || resetting || provider === config.aiRuntime.provider}
            onClick={() => void saveRuntimeConfig()}
            type="button"
          >
            {saving ? "Saving" : "Apply"}
          </Button>
        </RuntimeEditor>
        <ConfigStack>
          <ConfigGroup title="API" value={{ ...config.api, browserApiBaseUrl: apiBaseUrl }} />
          <ConfigGroup title="Stores" value={config.stores} />
          <ConfigGroup title="Knowledge" value={config.knowledge} />
          <ConfigGroup
            title="Retrieval"
            value={{
              mode: config.retrieval.mode,
              embeddingProvider: config.retrieval.embeddingProvider,
              reason: config.retrieval.reason
            }}
          />
          <ConfigGroup title="Providers" value={config.providers} />
          <ConfigGroup title="Watcher" value={config.watcher} />
        </ConfigStack>
        <ResetControl>
          <h3>Demo controls</h3>
          <EmptyState>
            Deletes all questions, proposals, gaps and jobs, resets AI config, and re-indexes the knowledge bases from
            configuration.
          </EmptyState>
          {confirmingReset ? (
            <ResetConfirm>
              <span>This permanently deletes all app data. Continue?</span>
              <Button variant="danger" disabled={resetting} onClick={() => void resetData()} type="button">
                {resetting ? "Resetting" : "Confirm reset"}
              </Button>
              <Button disabled={resetting} onClick={() => setConfirmingReset(false)} type="button">
                Cancel
              </Button>
            </ResetConfirm>
          ) : (
            <Button variant="danger" disabled={resetting} onClick={() => setConfirmingReset(true)} type="button">
              Reset data
            </Button>
          )}
        </ResetControl>
      </Surface.Body>
    </Surface>
  );
}

function ConfigGroup({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <ConfigGroupCard>
      <h3>{title}</h3>
      <dl>
        {Object.entries(flattenConfig(value)).map(([key, itemValue]) => (
          <ConfigRow key={key}>
            <dt>{key}</dt>
            <dd>{String(itemValue ?? "not set")}</dd>
          </ConfigRow>
        ))}
      </dl>
    </ConfigGroupCard>
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

    result[nextKey] =
      typeof itemValue === "string" || typeof itemValue === "number" || itemValue === null
        ? itemValue
        : JSON.stringify(itemValue);
    return result;
  }, {});
}
