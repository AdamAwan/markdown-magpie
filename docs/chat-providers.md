# Chat Providers

Markdown Magpie keeps answer synthesis behind the `ChatProvider` interface.

## Providers

### `mock`

Default provider. It produces deterministic answers from retrieved Markdown context and requires no API key.

```bash
CHAT_PROVIDER=mock npm run dev:api
```

### `openai-compatible`

Uses an OpenAI-compatible `/chat/completions` endpoint.

```bash
CHAT_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=https://example.com/v1 \
OPENAI_COMPATIBLE_API_KEY=... \
OPENAI_COMPATIBLE_MODEL=... \
npm run dev:api
```

### `azure-openai`

Uses Azure OpenAI chat completions.

```bash
CHAT_PROVIDER=azure-openai \
AZURE_OPENAI_ENDPOINT=https://example.openai.azure.com \
AZURE_OPENAI_API_KEY=... \
AZURE_OPENAI_CHAT_DEPLOYMENT=... \
AZURE_OPENAI_API_VERSION=2024-10-21 \
npm run dev:api
```

## Execution Modes

`CHAT_PROVIDER` controls direct answer synthesis.

`AI_EXECUTION_MODE=queue` bypasses direct synthesis and enqueues an `answer_question` job for the watcher instead.
