import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "./index";

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

describe("Worker Logic", () => {
  beforeEach(() => {
    env.ALGOLIA_API_KEY = "testtest";
    env.ALGOLIA_APPLICATION_ID = "testtest";

    vi.clearAllMocks();
    // Reset fetch mock
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"hits": []}', { status: 200 }));
  });

  it("should handle OPTIONS request (CORS)", async () => {
    const request = new Request("https://example.com/1/indexes/*/queries", {
      method: "OPTIONS",
      headers: {
        Origin: "https://www.avocadostore.de",
      },
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://www.avocadostore.de"
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST"
    );
  });

  it("should handle valid search request", async () => {
    const validSearchBody = {
      requests: [
        {
          indexName: "products_de_v1.0.0_query_suggestions",
          query: "schok",
          hitsPerPage: 9,
          highlightPreTag: "__aa-highlight__",
          highlightPostTag: "__/aa-highlight__",
          clickAnalytics: true,
          userToken: "anonymous-a9e343ba-83b7-481b-881e-aaacd2d5d435",
          facetFilters: [
            "products_de_v1.0.0.facets.exact_matches.categories_level.lvl0.value:-undefined",
            ["objectID:-schokolade"],
          ],
        },
        {
          indexName: "products_de_v1.0.0_query_suggestions",
          query: "",
          hitsPerPage: 8,
          highlightPreTag: "__aa-highlight__",
          highlightPostTag: "__/aa-highlight__",
          clickAnalytics: true,
          userToken: "anonymous-a9e343ba-83b7-481b-881e-aaacd2d5d435",
        },
      ],
    };

    const request = new Request("https://example.com/1/indexes/*/queries", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.avocadostore.de",
      },
      body: JSON.stringify(validSearchBody),
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalled();

    // Verify Algolia headers are set
    const fetchCall = (globalThis.fetch as any).mock.calls.find((call: any) =>
      call[0].includes("algolia")
    );
    expect(fetchCall).toBeDefined();
    const fetchUrl = new URL(fetchCall[0]);
    // The env values are empty strings in the test environment
    expect(fetchUrl.searchParams.get("x-algolia-api-key")).toBe("testtest");
    expect(fetchUrl.searchParams.get("x-algolia-application-id")).toBe(
      "testtest"
    );
  });

  it("should handle valid category page request", async () => {
    const validCategoryBody = {
      requests: [
        {
          indexName: "products_de_v1.0.0",
          clickAnalytics: true,
          facetFilters: [["categories_level.lvl1:Geschenke > Unter 20 Euro"]],
          facets: ["*"],
          getRankingInfo: true,
          highlightPostTag: "__/ais-highlight__",
          highlightPreTag: "__ais-highlight__",
          maxValuesPerFacet: 250,
          page: 1,
          query: "",
          userToken: "anonymous-61f60424-64f8-4a47-92cf-f7bbe97368a3",
        },
        {
          indexName: "products_de_v1.0.0",
          analytics: false,
          clickAnalytics: false,
          facetFilters: [["categories_level.lvl0:Geschenke"]],
          facets: ["categories_level.lvl0", "categories_level.lvl1"],
          getRankingInfo: true,
          highlightPostTag: "__/ais-highlight__",
          highlightPreTag: "__ais-highlight__",
          hitsPerPage: 0,
          maxValuesPerFacet: 250,
          page: 0,
          query: "",
          userToken: "anonymous-61f60424-64f8-4a47-92cf-f7bbe97368a3",
        },
        {
          indexName: "products_de_v1.0.0",
          analytics: false,
          clickAnalytics: false,
          facets: ["categories_level.lvl0"],
          getRankingInfo: true,
          highlightPostTag: "__/ais-highlight__",
          highlightPreTag: "__ais-highlight__",
          hitsPerPage: 0,
          maxValuesPerFacet: 250,
          page: 0,
          query: "",
          userToken: "anonymous-61f60424-64f8-4a47-92cf-f7bbe97368a3",
        },
      ],
    };

    const request = new Request("https://example.com/1/indexes/*/queries", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.avocadostore.de",
      },
      body: JSON.stringify(validCategoryBody),
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
  });

  it("should reject invalid query (too short)", async () => {
    const invalidBody = {
      requests: [
        {
          indexName: "test",
          query: "ab", // Too short (< 3) and not empty
        },
      ],
    };

    const request = new Request("https://example.com/1/indexes/*/queries", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.avocadostore.de",
      },
      body: JSON.stringify(invalidBody),
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('Query too short');
    expect(json.errorType).toBe('too_short');
  });

  it("should reject invalid query (invalid characters)", async () => {
    const invalidBody = {
      requests: [
        {
          indexName: "test",
          query: "bad\u0000script", // Invalid chars
        },
      ],
    };

    const request = new Request("https://example.com/1/indexes/*/queries", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.avocadostore.de",
      },
      body: JSON.stringify(invalidBody),
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('invalid characters');
    expect(json.errorType).toBe('invalid_characters');
  });

  it("should use cache when cacheKey is present", async () => {
    const validSearchBody = {
      requests: [{ indexName: "test", query: "schok" }],
    };
    const cacheKey = "some-cache-key";

    // Mock cache match to return nothing first
    cacheMatch.mockResolvedValue(undefined);

    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.avocadostore.de",
        "x-ssr-request": "ASDf928gh2efhajsdf!!",
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
    const cachedResponse = new Response('{"cached": true}', {
      status: 200,
    });
    cacheMatch.mockResolvedValue(cachedResponse);

    // Second request - should return from cache
    const response2 = await worker.fetch(
      new Request(url, requestOptions),
      env,
      ctx
    );
    expect(response2.status).toBe(200);
    expect(await response2.text()).toBe('{"cached": true}');
  });

  it("should use different cache entries for different X-AS-Cache-Key headers", async () => {
    const url = "https://example.com/1/indexes/*/queries";
    const body1 = { requests: [{ indexName: "test", query: "search1" }] };
    const body2 = { requests: [{ indexName: "test", query: "search2" }] };

    // 1. Request with Key 1
    cacheMatch.mockResolvedValueOnce(undefined); // Cache miss
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"result": "search1"}', { status: 200 })
      );

    await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
          "X-AS-Cache-Key": "key-1",
          "x-ssr-request": "ASDf928gh2efhajsdf!!",
        },
        body: JSON.stringify(body1),
      }),
      env,
      ctx
    );

    // Verify what was put in cache - uses URL string as cache key
    expect(cachePut).toHaveBeenCalledTimes(1);
    const cacheUrl1 = cachePut.mock.calls[0][0] as string;

    // 2. Request with Key 2
    cacheMatch.mockResolvedValueOnce(undefined); // Cache miss
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"result": "search2"}', { status: 200 })
      );

    await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
          "X-AS-Cache-Key": "key-2",
          "x-ssr-request": "ASDf928gh2efhajsdf!!",
        },
        body: JSON.stringify(body2),
      }),
      env,
      ctx
    );

    expect(cachePut).toHaveBeenCalledTimes(2);
    const cacheUrl2 = cachePut.mock.calls[1][0] as string;

    // The URLs used for caching MUST be different for the cache to treat them differently
    expect(cacheUrl1).not.toBe(cacheUrl2);
    expect(cacheUrl1).toContain("key-1");
    expect(cacheUrl2).toContain("key-2");
  });

  describe("Algolia Insights forwarding", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('{"status": "OK"}', { status: 200 }));
    });

    it("should forward insights events to Algolia Insights endpoint", async () => {
      const insightsBody = {
        events: [
          {
            eventType: "click",
            eventName: "Product Clicked",
            index: "products_de_v1.0.0",
            userToken: "user-123",
            timestamp: Date.now(),
            objectIDs: ["product-1"],
            positions: [1],
            queryID: "query-123",
          },
        ],
      };

      const request = new Request("https://example.com/1/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: JSON.stringify(insightsBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalled();

      // Verify the request was forwarded to insights.algolia.io
      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const fetchUrl = fetchCall[0];
      expect(fetchUrl).toContain("insights.algolia.io/1/events");
    });

    it("should use lowercase x-algolia params and remove uppercase duplicates", async () => {
      const insightsBody = {
        events: [
          {
            eventType: "view",
            eventName: "Product Viewed",
            index: "products_de_v1.0.0",
            userToken: "user-456",
            timestamp: Date.now(),
            objectIDs: ["product-2"],
          },
        ],
      };

      // Simulate a request with uppercase query params (as insights-js sends them)
      const url = new URL("https://example.com/1/events");
      url.searchParams.set("X-Algolia-Application-Id", "UPPERCASE_APP_ID");
      url.searchParams.set("X-Algolia-API-Key", "UPPERCASE_API_KEY");

      const request = new Request(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: JSON.stringify(insightsBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalled();

      // Verify the forwarded URL has lowercase params set from env and no uppercase duplicates
      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const forwardedUrl = new URL(fetchCall[0]);

      // Should have lowercase params from env
      expect(forwardedUrl.searchParams.get("x-algolia-api-key")).toBe(
        "testtest"
      );
      expect(forwardedUrl.searchParams.get("x-algolia-application-id")).toBe(
        "testtest"
      );

      // Should NOT have the uppercase params (they were deleted)
      expect(forwardedUrl.searchParams.has("X-Algolia-Application-Id")).toBe(
        false
      );
      expect(forwardedUrl.searchParams.has("X-Algolia-API-Key")).toBe(false);
    });

    it("should set correct insights agent in query params", async () => {
      const insightsBody = {
        events: [
          {
            eventType: "conversion",
            eventName: "Product Purchased",
            index: "products_de_v1.0.0",
            userToken: "user-789",
            timestamp: Date.now(),
            objectIDs: ["product-3"],
          },
        ],
      };

      const request = new Request("https://example.com/1/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: JSON.stringify(insightsBody),
      });

      await worker.fetch(request, env, ctx);

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const forwardedUrl = new URL(fetchCall[0]);

      // Should have the insights agent
      expect(forwardedUrl.searchParams.get("X-Algolia-Agent")).toContain(
        "insights-js"
      );
      expect(forwardedUrl.searchParams.get("X-Algolia-Agent")).toContain(
        "insights-middleware"
      );
    });

    it("should handle insights endpoint errors gracefully", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const insightsBody = {
        events: [
          {
            eventType: "click",
            eventName: "Product Clicked",
            index: "products_de_v1.0.0",
            userToken: "user-error",
            timestamp: Date.now(),
            objectIDs: ["product-error"],
          },
        ],
      };

      const request = new Request("https://example.com/1/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: JSON.stringify(insightsBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toBe("Failed to reach Algolia Insights endpoint");
    });

    it("should forward insights events with SSR request header", async () => {
      const insightsBody = {
        events: [
          {
            eventType: "click",
            eventName: "SSR Click",
            index: "products_de_v1.0.0",
            userToken: "user-ssr",
            timestamp: Date.now(),
            objectIDs: ["product-ssr"],
          },
        ],
      };

      const request = new Request("https://example.com/1/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
          "x-ssr-request": "ASDf928gh2efhajsdf!!",
        },
        body: JSON.stringify(insightsBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalled();

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const fetchUrl = fetchCall[0];
      expect(fetchUrl).toContain("insights.algolia.io/1/events");
    });

    it("should preserve original request headers when forwarding insights", async () => {
      const insightsBody = {
        events: [
          {
            eventType: "view",
            eventName: "Product Viewed",
            index: "products_de_v1.0.0",
            userToken: "user-headers",
            timestamp: Date.now(),
            objectIDs: ["product-headers"],
          },
        ],
      };

      const request = new Request("https://example.com/1/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
          "User-Agent": "TestAgent/1.0",
          "X-Custom-Header": "custom-value",
        },
        body: JSON.stringify(insightsBody),
      });

      await worker.fetch(request, env, ctx);

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const fetchOptions = fetchCall[1];

      // Verify headers were forwarded (header names are lowercase in the headers object)
      expect(fetchOptions.headers["content-type"]).toBe("application/json");
      expect(fetchOptions.headers["user-agent"]).toBe("TestAgent/1.0");
      expect(fetchOptions.headers["x-custom-header"]).toBe("custom-value");
    });
  });

  describe("Additional Coverage Tests", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('{"hits": []}', { status: 200 }));
    });

    it("should handle GET requests", async () => {
      const request = new Request(
        "https://example.com/1/indexes/*/queries?query=test",
        {
          method: "GET",
          headers: {
            Origin: "https://www.avocadostore.de",
          },
        }
      );

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it("should handle malformed JSON body", async () => {
      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: "{ invalid json",
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Malformed JSON body");
      expect(json.errorType).toBe('malformed_json');
      expect(json.details).toBeDefined();
    });

    it("should handle localhost origin", async () => {
      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
        },
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toEqual(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000"
      );
    });

    it("should handle disallowed origin", async () => {
      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.com",
        },
        body: JSON.stringify(validSearchBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.avocadostore.de"
      );
    });

    it("should handle request without origin header", async () => {
      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(validSearchBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.avocadostore.de"
      );
    });

    it("should NOT cache non-SSR requests even with cacheKey", async () => {
      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      cacheMatch.mockResolvedValue(undefined);

      const request = new Request(
        "https://example.com/1/indexes/*/queries?cacheKey=test-key",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://www.avocadostore.de",
            // No x-ssr-request header
          },
          body: JSON.stringify(validSearchBody),
        }
      );

      await worker.fetch(request, env, ctx);

      // Cache should not be used for non-SSR requests
      expect(cacheMatch).not.toHaveBeenCalled();
      expect(cachePut).not.toHaveBeenCalled();
    });

    it("should NOT cache failed responses", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response('{"error": "not found"}', { status: 404 })
        );

      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      cacheMatch.mockResolvedValue(undefined);

      const request = new Request(
        "https://example.com/1/indexes/*/queries?cacheKey=test-key",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://www.avocadostore.de",
            "x-ssr-request": "ASDf928gh2efhajsdf!!",
          },
          body: JSON.stringify(validSearchBody),
        }
      );

      const response = await worker.fetch(request, env, ctx);

      // When all hosts fail, worker returns 502
      expect(response.status).toBe(502);
      // Should not cache failed responses
      expect(cachePut).not.toHaveBeenCalled();
    });

    it("should retry multiple Algolia hosts on failure", async () => {
      // First host fails, second succeeds
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce(new Response('{"hits": []}', { status: 200 }));

      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: JSON.stringify(validSearchBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      // Should have tried at least 2 hosts
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("should return 502 when all Algolia hosts fail", async () => {
      // All hosts fail
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Network error"));

      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: JSON.stringify(validSearchBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(502);
      const json = await response.json();
      expect(json.error).toBe('All Algolia hosts failed');
      expect(json.errorType).toBe('algolia');
      expect(json.details).toContain('Tried');
      expect(json.details).toContain('host');
    });

    it("should use custom cache TTL for SSR requests", async () => {
      env.CACHE_TTL_SSR = "1800"; // 30 minutes

      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      cacheMatch.mockResolvedValue(undefined);

      const request = new Request(
        "https://example.com/1/indexes/*/queries?cacheKey=test-key",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://www.avocadostore.de",
            "x-ssr-request": "ASDf928gh2efhajsdf!!",
          },
          body: JSON.stringify(validSearchBody),
        }
      );

      await worker.fetch(request, env, ctx);

      expect(cachePut).toHaveBeenCalled();
      const cachedResponse = cachePut.mock.calls[0][1] as Response;
      expect(cachedResponse.headers.get("Cache-Control")).toContain("1800");
    });

    it("should handle OPTIONS with allowed origin domain", async () => {
      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "OPTIONS",
        headers: {
          Origin: "https://shop.avocadostore.de",
        },
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://shop.avocadostore.de"
      );
      expect(response.headers.get("Vary")).toBe("Origin");
    });

    it("should handle error responses from Algolia with error body", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response('{"message": "Rate limit exceeded"}', { status: 429 })
        );

      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: JSON.stringify(validSearchBody),
      });

      const response = await worker.fetch(request, env, ctx);

      // When all hosts return errors, worker returns 502
      expect(response.status).toBe(502);
    });

    it("should handle X-AS-Cache-Key header in addition to cacheKey param", async () => {
      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      cacheMatch.mockResolvedValue(undefined);

      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
          "X-AS-Cache-Key": "header-cache-key",
          "x-ssr-request": "ASDf928gh2efhajsdf!!",
        },
        body: JSON.stringify(validSearchBody),
      });

      await worker.fetch(request, env, ctx);

      expect(cacheMatch).toHaveBeenCalled();
      expect(cachePut).toHaveBeenCalled();
      const cacheUrl = cachePut.mock.calls[0][0] as string;
      expect(cacheUrl).toContain("header-cache-key");
    });

    it("should handle OPTIONS with SSR request header", async () => {
      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "OPTIONS",
        headers: {
          Origin: "https://test.avocadostore.de",
          "x-ssr-request": "ASDf928gh2efhajsdf!!",
        },
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.avocadostore.de"
      );
    });

    it("should handle empty query strings in all requests", async () => {
      const validBody = {
        requests: [
          { indexName: "test", query: "" },
          { indexName: "test2", query: "" },
        ],
      };

      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.avocadostore.de",
        },
        body: JSON.stringify(validBody),
      });

      const response = await worker.fetch(request, env, ctx);

      // Empty queries are allowed for category pages
      expect(response.status).toBe(200);
    });

    it("should handle Cloudflare dashboard origin", async () => {
      const validSearchBody = {
        requests: [{ indexName: "test", query: "search" }],
      };

      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dash.cloudflare.com",
        },
        body: JSON.stringify(validSearchBody),
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://dash.cloudflare.com"
      );
    });

    it("should handle avocadostore.dev origin", async () => {
      const request = new Request("https://example.com/1/indexes/*/queries", {
        method: "OPTIONS",
        headers: {
          Origin: "https://www.avocadostore.dev",
        },
      });

      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.avocadostore.dev"
      );
    });
  });
});
