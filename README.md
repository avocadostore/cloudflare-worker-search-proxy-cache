# Cloudflare Worker Search Proxy Cache

A Cloudflare Worker that proxies and caches Algolia search requests with CORS support.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Yarn](https://yarnpkg.com/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

## Setup

```bash
# Install dependencies
yarn install

# Create local environment file with your Algolia credentials
cp .env.example .env.local
# Edit .env.local with your ALGOLIA_APPLICATION_ID and ALGOLIA_API_KEY
```

## Development

```bash
# Start local development server (staging environment)
yarn dev

# Run tests
yarn test

# Generate TypeScript types from wrangler config
yarn cf-typegen
```

## Deployment

```bash
# Deploy to staging
yarn deploy

# Deploy to production
yarn deploy:production
```

## Configuration

Environment variables are set in `wrangler.jsonc`:

| Variable | Description | Default |
|----------|-------------|---------|
| `CACHE_TTL_SSR` | Cache TTL for SSR requests (seconds) | 600 |
| `CACHE_TTL_CLIENT` | Cache TTL for client requests (seconds) | 600 |

Secrets (set via Wrangler CLI):
```bash
# Set Algolia credentials
wrangler secret put ALGOLIA_APPLICATION_ID --env staging
wrangler secret put ALGOLIA_API_KEY --env staging
```

## Logging & Observability

Logs are available via:
```bash
# View real-time logs (staging)
wrangler tail --env staging

# View real-time logs (production)
wrangler tail --env production
```

Dashboard: [Cloudflare Workers Logs](https://dash.cloudflare.com/?to=/:account/workers/services/view/cloudflare-worker-search-proxy-cache)

## Caching

The worker uses Cloudflare's [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) for response caching:

- Cache keys are generated from request URLs with a `cacheKey` parameter or `X-AS-Cache-Key` header
- SSR requests (with `x-ssr-request` header) use `CACHE_TTL_SSR`
- Client requests use `CACHE_TTL_CLIENT`

## API

### Endpoints

| Path | Description |
|------|-------------|
| `/1/indexes/*/queries` | Algolia search queries |
| `/1/events` | Algolia Insights events |

### Headers

| Header | Description |
|--------|-------------|
| `X-AS-Cache-Key` | Custom cache key for the request |
| `x-ssr-request` | Mark request as server-side rendered |

## Documentation

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Algolia Search API](https://www.algolia.com/doc/api-reference/search-api/)
