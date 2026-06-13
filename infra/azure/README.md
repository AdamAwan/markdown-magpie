# Azure Deployment Notes

Azure is an optional managed deployment target, not a product requirement.

Likely managed services:

- Azure Container Apps for API, web, MCP, and worker containers.
- Azure Database for PostgreSQL with vector support.
- Azure Cache for Redis if the selected queue adapter requires Redis.
- Azure Blob Storage for raw document snapshots and generated artifacts.
- Azure OpenAI for chat and embeddings.
- Azure DevOps Repos or GitHub for pull request workflows.
- Microsoft Entra ID for organization authentication.

Local development should continue to use npm with provider-neutral or mock adapters.
Docker Compose remains the single-host deployment shape; Azure is an optional managed
deployment shape.
