# Limits

Operational limits for the Aurora REST API.

## API rate limits

The Aurora REST API allows 120 requests per minute per token. Exceeding the
rate limit returns HTTP 429 with a Retry-After header.
