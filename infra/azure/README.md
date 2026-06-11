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

The application should continue to run locally through Docker Compose with provider-neutral or mock adapters.

