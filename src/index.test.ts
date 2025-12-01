import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from './index';

// Mock ExecutionContext
const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// Mock Cache API
const cacheMatch = vi.fn();
const cachePut = vi.fn();
const cacheDelete = vi.fn();

// We need to mock the global caches object
// In the worker environment provided by vitest-pool-workers, this might already exist,
// but for explicit control we can mock it or spy on it.
// However, since we are running in the worker pool, `caches` should be available.
// If we want to mock it to verify calls:
globalThis.caches = {
  default: {
    match: cacheMatch,
    put: cachePut,
    delete: cacheDelete,
  },
} as any;


describe('Worker Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"hits": []}', { status: 200 }));
  });

  it('should handle OPTIONS request (CORS)', async () => {
    const request = new Request('https://example.com/1/indexes/*/queries', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://www.avocadostore.de',
      },
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.avocadostore.de');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('should handle valid search request', async () => {
    const validSearchBody = {
      "requests": [
        {
          "indexName": "products_de_v1.0.0_query_suggestions",
          "query": "schok",
          "hitsPerPage": 9,
          "highlightPreTag": "__aa-highlight__",
          "highlightPostTag": "__/aa-highlight__",
          "clickAnalytics": true,
          "userToken": "anonymous-a9e343ba-83b7-481b-881e-aaacd2d5d435",
          "facetFilters": [
            "products_de_v1.0.0.facets.exact_matches.categories_level.lvl0.value:-undefined",
            [
              "objectID:-schokolade"
            ]
          ]
        },
        {
          "indexName": "products_de_v1.0.0_query_suggestions",
          "query": "",
          "hitsPerPage": 8,
          "highlightPreTag": "__aa-highlight__",
          "highlightPostTag": "__/aa-highlight__",
          "clickAnalytics": true,
          "userToken": "anonymous-a9e343ba-83b7-481b-881e-aaacd2d5d435"
        }
      ]
    };

    const request = new Request('https://example.com/1/indexes/*/queries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.avocadostore.de',
      },
      body: JSON.stringify(validSearchBody),
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalled();

    // Verify Algolia headers are set
    const fetchCall = (globalThis.fetch as any).mock.calls.find((call: any) =>
      call[0].includes('algolia')
    );
    expect(fetchCall).toBeDefined();
    const fetchUrl = new URL(fetchCall[0]);
    expect(fetchUrl.searchParams.get('x-algolia-api-key')).toBe(env.ALGOLIA_API_KEY);
    expect(fetchUrl.searchParams.get('x-algolia-application-id')).toBe(env.ALGOLIA_APPLICATION_ID);
  });

  it('should handle valid category page request', async () => {
    const validCategoryBody = {
      "requests": [
        {
          "indexName": "products_de_v1.0.0",
          "clickAnalytics": true,
          "facetFilters": [
            [
              "categories_level.lvl1:Geschenke > Unter 20 Euro"
            ]
          ],
          "facets": [
            "*"
          ],
          "getRankingInfo": true,
          "highlightPostTag": "__/ais-highlight__",
          "highlightPreTag": "__ais-highlight__",
          "maxValuesPerFacet": 250,
          "page": 1,
          "query": "",
          "userToken": "anonymous-61f60424-64f8-4a47-92cf-f7bbe97368a3"
        },
        {
          "indexName": "products_de_v1.0.0",
          "analytics": false,
          "clickAnalytics": false,
          "facetFilters": [
            [
              "categories_level.lvl0:Geschenke"
            ]
          ],
          "facets": [
            "categories_level.lvl0",
            "categories_level.lvl1"
          ],
          "getRankingInfo": true,
          "highlightPostTag": "__/ais-highlight__",
          "highlightPreTag": "__ais-highlight__",
          "hitsPerPage": 0,
          "maxValuesPerFacet": 250,
          "page": 0,
          "query": "",
          "userToken": "anonymous-61f60424-64f8-4a47-92cf-f7bbe97368a3"
        },
        {
          "indexName": "products_de_v1.0.0",
          "analytics": false,
          "clickAnalytics": false,
          "facets": [
            "categories_level.lvl0"
          ],
          "getRankingInfo": true,
          "highlightPostTag": "__/ais-highlight__",
          "highlightPreTag": "__ais-highlight__",
          "hitsPerPage": 0,
          "maxValuesPerFacet": 250,
          "page": 0,
          "query": "",
          "userToken": "anonymous-61f60424-64f8-4a47-92cf-f7bbe97368a3"
        }
      ]
    };

    const request = new Request('https://example.com/1/indexes/*/queries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.avocadostore.de',
      },
      body: JSON.stringify(validCategoryBody),
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
  });

  it('should reject invalid query (too short)', async () => {
    const invalidBody = {
      "requests": [
        {
          "indexName": "test",
          "query": "ab" // Too short (< 3) and not empty
        }
      ]
    };

    const request = new Request('https://example.com/1/indexes/*/queries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.avocadostore.de',
      },
      body: JSON.stringify(invalidBody),
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({ error: "Invalid query parameter" });
  });

  it('should reject invalid query (invalid characters)', async () => {
    const invalidBody = {
      "requests": [
        {
          "indexName": "test",
          "query": "bad\u0000script" // Invalid chars
        }
      ]
    };

    const request = new Request('https://example.com/1/indexes/*/queries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.avocadostore.de',
      },
      body: JSON.stringify(invalidBody),
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
  });

  it('should use cache when cacheKey is present', async () => {
    const validSearchBody = { requests: [{ indexName: "test", query: "schok" }] };
    const cacheKey = "some-cache-key";

    // Mock cache match to return nothing first
    cacheMatch.mockResolvedValue(undefined);

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.avocadostore.de',
      },
      body: JSON.stringify(validSearchBody),
    };
    const url = `https://example.com/1/indexes/*/queries?cacheKey=${cacheKey}`;

    // First request - should fetch from Algolia and put in cache
    await worker.fetch(new Request(url, requestOptions), env, ctx);

    expect(cacheMatch).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(cachePut).toHaveBeenCalled();

    // Mock cache match to return a response
    const cachedResponse = new Response('{"cached": true}', { status: 200 });
    cacheMatch.mockResolvedValue(cachedResponse);

    // Second request - should return from cache
    const response2 = await worker.fetch(new Request(url, requestOptions), env, ctx);
    expect(response2.status).toBe(200);
    expect(await response2.text()).toBe('{"cached": true}');
  });

  it('should use different cache entries for different X-AS-Cache-Key headers', async () => {
    const url = 'https://example.com/1/indexes/*/queries';
    const body1 = { requests: [{ indexName: "test", query: "search1" }] };
    const body2 = { requests: [{ indexName: "test", query: "search2" }] };

    // 1. Request with Key 1
    cacheMatch.mockResolvedValueOnce(undefined); // Cache miss
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response('{"result": "search1"}', { status: 200 }));

    await worker.fetch(new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.avocadostore.de',
        'X-AS-Cache-Key': 'key-1'
      },
      body: JSON.stringify(body1),
    }), env, ctx);

    // Verify what was put in cache - now uses URL string as cache key
    expect(cachePut).toHaveBeenCalledTimes(1);
    const cacheUrl1 = cachePut.mock.calls[0][0] as string;

    // 2. Request with Key 2
    cacheMatch.mockResolvedValueOnce(undefined); // Cache miss
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response('{"result": "search2"}', { status: 200 }));

    await worker.fetch(new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.avocadostore.de',
        'X-AS-Cache-Key': 'key-2'
      },
      body: JSON.stringify(body2),
    }), env, ctx);

    expect(cachePut).toHaveBeenCalledTimes(2);
    const cacheUrl2 = cachePut.mock.calls[1][0] as string;

    // The URLs used for caching MUST be different for the cache to treat them differently
    expect(cacheUrl1).not.toBe(cacheUrl2);
    expect(cacheUrl1).toContain('key-1');
    expect(cacheUrl2).toContain('key-2');
  });
});
