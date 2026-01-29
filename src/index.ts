type Env = {
  ALGOLIA_APPLICATION_ID: string;
  ALGOLIA_API_KEY: string;
  CACHE_TTL_SSR?: string;
  CACHE_TTL_CLIENT?: string;
};

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

type SearchRequest = {
  query?: string;
  [key: string]: unknown;
};

type IncomingBody = {
  requests?: SearchRequest[];
  [key: string]: unknown;
};

type ParseResult = {
  body?: IncomingBody;
  error?: Response;
};

type ValidationErrorType = 'too_short' | 'invalid_characters' | 'malformed_json';

type ErrorDetail = {
  error: string;
  errorType: ValidationErrorType | 'network' | 'algolia';
  details?: string;
  timestamp: string;
};

type HostAttempt = {
  host: string;
  status?: number;
  error?: string;
  ok?: boolean;
};

type LogEntry = {
  message: string;
  status: string | number;
  [key: string]: unknown;
};

type RequestContext = {
  url: URL;
  origin: string;
  isSSRRequest: boolean;
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
};

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const SEARCH_AGENT =
  "Algolia%20for%20JavaScript%20(5.8.1)%3B%20Lite%20(5.8.1)%3B%20Browser%3B%20autocomplete-core%20(1.17.4)%3B%20autocomplete-js%20(1.17.4)" as const;
const INSIGHTS_AGENT =
  "insights-js%20(2.17.3)%3B%20insights-js-browser-umd%20(2.17.3)%3B%20insights-middleware%3B%20insights-plugin" as const;
const getHosts = (applicationId: string): readonly string[] => [
  applicationId + "-dsn.algolia.net",
  applicationId + "-1.algolianet.com",
  applicationId + "-2.algolianet.com",
  applicationId + "-3.algolianet.com",
];
const SERVICE_NAME = "algolia-proxy" as const;

//TO AI AGENT: DO NOT CHANGE THE REGEX BELOW!!!
const ALLOWED_QUERY_REGEX =
  /^[\x20-\x7E\xA0-\xFF★•‚''„"""'›‹–…‒√°¬♥ᵘᵖⓇ™&⎥€∴ː∅ÆæĀāČčǝĒēЁёęłıÏïîÑñŌō⌀ŠšẞßŪū]+$/;

const ALLOWED_ORIGIN_PATTERN =
  /^https:\/\/([a-z0-9-]+\.)*avocadostore\.(de|dev)$/;
const LOCALHOST_PATTERN = /^http:\/\/localhost(:\d+)?$/;
const ENVIRONMENT = "production";
const CLOUDFLARE_DASHBOARD = "https://dash.cloudflare.com";
const BLACKLIST_HEADERS_FOR_GET = [
  "content-type",
  "content-length",
  "transfer-encoding",
];

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);
    const requestOrigin = request.headers.get("Origin");
    const origin = requestOrigin || "*";
    const ssrHeaderValue = request.headers.get("x-ssr-request");
    const isSSRRequest = ssrHeaderValue === "ASDf928gh2efhajsdf!!";

    const reqContext: RequestContext = {
      url,
      origin,
      isSSRRequest,
      method: request.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
    };

    if (request.method === "OPTIONS") {
      return handleOptions(reqContext);
    }

    let bodyStr: string | undefined;
    if (request.method === "POST") {
      const result = await parseRequestBody(request);
      if (result.error) {
        // Parse error details from response for logging
        const errorText = await result.error.clone().text();
        let errorDetails: ErrorDetail | undefined;
        try {
          errorDetails = JSON.parse(errorText) as ErrorDetail;
        } catch {
          // If parsing fails, use generic error
        }

        ctx.waitUntil(
          logEvent("error", `[FAILED] ${errorDetails?.error || "Validation error"} Algolia request to: ${reqContext.pathname}`, {
            origin,
            url: request.url,
            method: request.method,
            error: errorDetails?.error || "Validation error",
            error_type: errorDetails?.errorType,
            error_details: errorDetails?.details,
            is_ssr_request: isSSRRequest,
            user_agent: request.headers.get("User-Agent") || "unknown",
          })
        );
        return result.error;
      }
      bodyStr = JSON.stringify(result.body);
    }

    // Caching Logic
    // Note: Cloudflare Cache API caches responses based on the full request URL.
    // For POST requests, we create a synthetic GET request with a cache key parameter.
    // Cache SSR requests when CACHE_TTL_SSR > 0, and client-side requests when CACHE_TTL_CLIENT > 0.
    // Reference: https://developers.cloudflare.com/workers/runtime-apis/cache/
    const cache = caches.default;
    const cacheKeyParam =
      reqContext.searchParams.get("cacheKey") ||
      request.headers.get("X-AS-Cache-Key");
    let cacheKeyUrl: string | undefined;
    let response: Response | undefined;
    let isCacheHit = false;

    const cacheTtlClient = parseInt(env.CACHE_TTL_CLIENT || "0", 10) || 0;
    const shouldCache = isSSRRequest || cacheTtlClient > 0;

    if (request.method === "POST" && cacheKeyParam && shouldCache) {
      const cacheUrl = new URL(url.toString());
      cacheUrl.searchParams.set("cacheKey", cacheKeyParam);

      // Add SSR indicator to cache key to separate SSR and client-side cache entries
      cacheUrl.searchParams.set("ssr", isSSRRequest ? "1" : "0");
      cacheKeyUrl = cacheUrl.toString();

      // Create a GET request for cache lookup (POST requests are not cached by default)
      // Filter out body-related headers that would conflict with GET method
      const cacheHeaders = new Headers();
      for (const [key, value] of request.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (!BLACKLIST_HEADERS_FOR_GET.includes(lowerKey)) {
          cacheHeaders.set(key, value);
        }
      }

      const cachedResponse = await cache.match(cacheKeyUrl);

      if (cachedResponse) {
        response = cachedResponse;
        isCacheHit = true;
      } else {
        isCacheHit = false;
      }
    }

    if (!response) {
      response = await fetchFromAlgolia(
        reqContext,
        request.headers,
        bodyStr,
        env,
        isSSRRequest
      );

      if (cacheKeyUrl && response.ok && shouldCache) {
        const responseToCache = response.clone();
        const headers = new Headers(responseToCache.headers);

        const cacheTtl = isSSRRequest
          ? parseInt(env.CACHE_TTL_SSR || "600", 10) || 600
          : parseInt(env.CACHE_TTL_CLIENT || "0", 10) || 0;

        headers.set("Cache-Control", `public, max-age=${cacheTtl}`);

        const cachedResponse = new Response(responseToCache.body, {
          status: responseToCache.status,
          statusText: responseToCache.statusText,
          headers: headers,
        });

        // Store using GET Request object as the cache key (must match the lookup request)
        const storeCacheHeaders = new Headers();
        for (const [key, value] of request.headers.entries()) {
          const lowerKey = key.toLowerCase();
          if (!BLACKLIST_HEADERS_FOR_GET.includes(lowerKey)) {
            storeCacheHeaders.set(key, value);
          }
        }
        ctx.waitUntil(cache.put(cacheKeyUrl, cachedResponse));
      }
    }

    const duration = Date.now() - startTime;
    ctx.waitUntil(
      logRequest(
        reqContext,
        request.headers,
        response,
        duration,
        isCacheHit,
        bodyStr
      )
    );

    return addCorsHeaders(response, origin, isSSRRequest);
  },
} satisfies ExportedHandler<Env>;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function handleOptions(ctx: RequestContext): Response {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, x-algolia-agent, x-algolia-api-key, x-algolia-application-id, x-as-cache-key, x-ssr-request",
    "Access-Control-Max-Age": "86400",
  };

  if (ctx.isSSRRequest) {
    headers["Access-Control-Allow-Origin"] = "https://www.avocadostore.de";
  } else if (ctx.origin && isOriginAllowed(ctx.origin)) {
    headers["Access-Control-Allow-Origin"] = ctx.origin;
    headers["Vary"] = "Origin";
  } else {
    headers["Access-Control-Allow-Origin"] = "https://www.avocadostore.de";
  }

  return new Response(null, {
    status: 204,
    headers,
  });
}

async function fetchFromAlgolia(
  ctx: RequestContext,
  originalHeaders: Headers,
  bodyStr?: string,
  env?: Env,
  isSSRRequest?: boolean
): Promise<Response> {
  const { pathname } = ctx;
  const userAgent = originalHeaders.get("User-Agent") || "unknown";
  // Create a copy of searchParams to avoid mutating the original URL
  const algoliaParams = new URLSearchParams(ctx.searchParams.toString());
  algoliaParams.set("x-algolia-api-key", env?.ALGOLIA_API_KEY || "");
  algoliaParams.set(
    "x-algolia-application-id",
    env?.ALGOLIA_APPLICATION_ID || ""
  );

  const headers: Record<string, string> = {};
  for (const [key, value] of originalHeaders.entries()) {
    headers[key] = value;
  }

  if (pathname === "/1/events") {
    // Unfortunately insights agent uses uppercase query params, so remove duplicates, as we set ours above.
    // Support case will be filled. Added unit test to test current behavior.
    algoliaParams.set("X-Algolia-Agent", INSIGHTS_AGENT);
    algoliaParams.delete("X-Algolia-Application-Id");
    algoliaParams.delete("X-Algolia-API-Key");

    const insightsUrl = `https://insights.algolia.io/1/events?${algoliaParams.toString()}`;
    try {
      return await fetch(insightsUrl, {
        method: ctx.method,
        headers,
        body: bodyStr,
      });
    } catch {
      return new Response("Failed to reach Algolia Insights endpoint", {
        status: 502,
      });
    }
  } else {
    algoliaParams.set("x-algolia-agent", SEARCH_AGENT);
  }

  const search = `?${algoliaParams.toString()}`;

  const hosts = getHosts(env?.ALGOLIA_APPLICATION_ID || "");
  return await tryAlgoliaHosts(
    pathname,
    search,
    ctx.method,
    headers,
    bodyStr,
    hosts,
    isSSRRequest,
    userAgent
  );
}

function isInvalidQuery(requests: SearchRequest[]): {
  invalid: boolean;
  errorType?: ValidationErrorType;
  query?: string;
} {
  if (requests.every((req) => req.query === "" || req.query === undefined)) {
    return { invalid: false };
  }

  let hasLongQuery = false;
  for (const req of requests) {
    const queryValue = req.query;
    if (queryValue) {
      const query = String(queryValue);
      if (query.length >= 3) {
        hasLongQuery = true;
      }
      if (!ALLOWED_QUERY_REGEX.test(query)) {
        return {
          invalid: true,
          errorType: 'invalid_characters',
          query: query.substring(0, 100), // Limit to 100 chars for logging
        };
      }
    }
  }
  return hasLongQuery
    ? { invalid: false }
    : {
      invalid: true,
      errorType: 'too_short',
      query: requests.find((r) => r.query)?.query?.toString().substring(0, 100),
    };
}

async function parseRequestBody(request: Request): Promise<ParseResult> {
  try {
    const body = (await request.json()) as IncomingBody;
    if (body?.requests) {
      const validation = isInvalidQuery(body.requests);
      if (validation.invalid) {
        const errorType = validation.errorType ?? 'invalid_characters';
        const errorDetail: ErrorDetail = {
          error:
            errorType === 'too_short'
              ? 'Query too short (minimum 3 characters)'
              : 'Query contains invalid characters',
          errorType,
          details: validation.query ? `Query: "${validation.query}"` : undefined,
          timestamp: new Date().toISOString(),
        };
        return {
          error: new Response(JSON.stringify(errorDetail), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        };
      }
    }
    return { body };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const errorDetail: ErrorDetail = {
      error: 'Malformed JSON body',
      errorType: 'malformed_json',
      details: message,
      timestamp: new Date().toISOString(),
    };
    return {
      error: new Response(JSON.stringify(errorDetail), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
}

async function tryAlgoliaHosts(
  pathname: string,
  search: string,
  method: string,
  headers: Record<string, string>,
  bodyStr?: string,
  hosts?: readonly string[],
  isSSRRequest?: boolean,
  userAgent?: string
): Promise<Response> {
  const attempts: HostAttempt[] = [];

  for (const host of hosts || []) {
    try {
      const url = "https://" + host + pathname + search;
      const response = await fetch(url, {
        method,
        headers,
        body: bodyStr,
      });

      const attempt: HostAttempt = {
        host,
        status: response.status,
        ok: response.ok,
      };

      // Capture error response body for failed requests
      if (!response.ok) {
        try {
          const errorBody = await response.clone().text();
          attempt.error = errorBody;
        } catch (e) {
          attempt.error = `Failed to read error body: ${String(e)}`;
        }
      }

      attempts.push(attempt);

      if (response.ok) {
        return response;
      }
    } catch (e) {
      attempts.push({
        host,
        error: String(e),
      });
      // Network error, continue to next host
    }
  }

  // All hosts failed - return detailed error with request context
  const sampleUrl = hosts && hosts.length > 0
    ? `https://${hosts[0]}${pathname}${search}`
    : 'unknown';

  const errorDetail: ErrorDetail & {
    algolia_url?: string;
    algolia_method?: string;
    algolia_headers?: Record<string, string>;
    algolia_body?: string;
  } = {
    error: 'All Algolia hosts failed',
    errorType: 'algolia',
    details: `Tried ${attempts.length} host(s): ${attempts
      .map((a) => `${a.host}${a.status ? ` (${a.status})` : ''}`)
      .join(', ')}`,
    algolia_url: sampleUrl,
    algolia_method: method,
    algolia_headers: headers,
    algolia_body: bodyStr,
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(errorDetail), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

function isOriginAllowed(origin: string): boolean {
  return (
    ALLOWED_ORIGIN_PATTERN.test(origin) ||
    LOCALHOST_PATTERN.test(origin) ||
    origin === CLOUDFLARE_DASHBOARD
  );
}

function addCorsHeaders(
  response: Response,
  origin: string | null,
  isSSRRequest: boolean
): Response {
  const headers = new Headers(response.headers);

  if (isSSRRequest || !origin || !isOriginAllowed(origin)) {
    headers.set("Access-Control-Allow-Origin", "https://www.avocadostore.de");
  } else {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, x-algolia-agent, x-algolia-api-key, x-algolia-application-id, x-as-cache-key, x-ssr-request"
  );
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function logRequest(
  ctx: RequestContext,
  requestHeaders: Headers,
  response: Response,
  duration: number,
  isCacheHit: boolean,
  bodyStr?: string
): Promise<void> {
  const logContext: Record<string, unknown> = {
    origin: ctx.origin,
    url: ctx.url.toString(),
    method: ctx.method,
    status: response.status,
    duration_ms: duration,
    pathname: ctx.pathname,
    user_agent: requestHeaders.get("User-Agent") || "unknown",
    is_ssr_request: ctx.isSSRRequest,
    cache_hit: isCacheHit,
  };

  const queryParams: Record<string, string> = {};
  for (const [key, value] of ctx.searchParams.entries()) {
    queryParams[key] = value;
  }
  logContext.query_parameters = queryParams;

  const reqHeadersObj: Record<string, string> = {};
  for (const [key, value] of requestHeaders.entries()) {
    reqHeadersObj[key] = value;
  }
  logContext.request_headers = reqHeadersObj;

  if (bodyStr) {
    logContext.request_body = bodyStr;
  }

  // Include error details if response failed
  let errorType: string | undefined;
  if (!response.ok) {
    try {
      const errorText = await response.clone().text();

      // Try to parse as our ErrorDetail format (for proxy errors)
      try {
        const errorData = JSON.parse(errorText) as ErrorDetail & {
          algolia_url?: string;
          algolia_method?: string;
          algolia_headers?: Record<string, string>;
          algolia_body?: string;
        };
        if (errorData.details) {
          logContext.error_details = errorData.details;
        }
        if (errorData.errorType) {
          logContext.error_type = errorData.errorType;
          errorType = errorData.errorType;
        }
        // Include Algolia request details for network failures
        if (errorData.algolia_url) {
          logContext.algolia_url = errorData.algolia_url;
        }
        if (errorData.algolia_method) {
          logContext.algolia_method = errorData.algolia_method;
        }
        if (errorData.algolia_headers) {
          logContext.algolia_headers = errorData.algolia_headers;
        }
        if (errorData.algolia_body) {
          logContext.algolia_body = errorData.algolia_body;
        }
      } catch {
        // Not our error format - treat as raw Algolia response
        logContext.algolia_response = errorText;
        try {
          // Try to parse as JSON for better readability
          logContext.algolia_response_json = JSON.parse(errorText);
        } catch {
          // Keep as text if not JSON
        }
      }
    } catch {
      // If response can't be read, skip adding details
    }
  }

  await logEvent(
    response.ok ? "log" : "error",
    response.ok
      ? `[SUCCESS] Algolia request to: ${ctx.pathname}`
      : errorType === 'algolia'
        ? `[FAILED] Algolia not reachable, request: ${ctx.pathname}`
        : `[FAILED] Algolia request to: ${ctx.pathname}`,
    logContext
  );
}

// this is only async because ctx.waitUntil expects a Promise :(
async function logEvent(
  level: "log" | "error" | "warn",
  message: string,
  context: Record<string, unknown> = {}
): Promise<void> {
  try {
    const log: LogEntry = {
      message,
      status: level,
      timestamp: new Date().toISOString(),
      service: SERVICE_NAME,
      env: ENVIRONMENT,
      ...context,
    };

    // Log to Cloudflare's logging infrastructure (stdout/stderr)
    // This will be captured by "wrangler tail" and Cloudflare Workers Logs
    if (level === "error") {
      // Additionally log to stderr for errors
      console.error(log);
    } else if (level === "warn") {
      console.warn(log);
    } else {
      console.log(log);
    }
  } catch (error) {
    console.error("Failed to log event:", error);
  }
  return Promise.resolve();
}
