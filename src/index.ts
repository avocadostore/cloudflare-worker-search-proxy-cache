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
				ctx.waitUntil(
					logEvent("error", "Request validation failed", {
						origin,
						url: request.url,
						method: request.method,
						error: "Invalid query parameter or malformed JSON",
						is_ssr_request: isSSRRequest,
						user_agent:
							request.headers.get("User-Agent") || "unknown",
					})
				);
				return result.error;
			}
			bodyStr = JSON.stringify(result.body);
		}

		// Caching Logic
		// Note: Cloudflare Cache API caches responses based on the full request URL.
		// For POST requests, we create a synthetic GET request with a cache key parameter.
		// Only cache SSR requests to avoid caching client-side requests.
		// Reference: https://developers.cloudflare.com/workers/runtime-apis/cache/
		const cache = caches.default;
		const cacheKeyParam =
			reqContext.searchParams.get("cacheKey") ||
			request.headers.get("X-AS-Cache-Key");
		let cacheKeyUrl: string | undefined;
		let response: Response | undefined;
		let isCacheHit = false;

		if (request.method === "POST" && cacheKeyParam && isSSRRequest) {
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

			if (cacheKeyUrl && response.ok && isSSRRequest) {
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
		algoliaParams.set("x-algolia-agent", INSIGHTS_AGENT);

		const insightsUrl = `https://insights.algolia.io/1/events?${algoliaParams.toString()}`;
		logEvent("log", "Forwarding to Algolia Insights endpoint", {
			url: insightsUrl,
			is_ssr_request: isSSRRequest,
			user_agent: userAgent,
		});
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

function isInvalidQuery(requests: SearchRequest[]): boolean {
	if (requests.every((req) => req.query === "" || req.query === undefined)) {
		return false;
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
				return true;
			}
		}
	}
	return !hasLongQuery;
}

async function parseRequestBody(request: Request): Promise<ParseResult> {
	try {
		const body = (await request.json()) as IncomingBody;
		if (body?.requests && isInvalidQuery(body.requests)) {
			return {
				error: new Response('{"error":"Invalid query parameter"}', {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
			};
		}
		return { body };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const escapedMessage = message.replaceAll('"', String.raw`\"`);
		return {
			error: new Response(
				`{"error":"Malformed JSON body","details":"${escapedMessage}"}`,
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				}
			),
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
	let counter = 1;
	for (const host of hosts || []) {
		try {
			const url = "https://" + host + pathname + search;
			const response = await fetch(url, {
				method,
				headers,
				body: bodyStr,
			});

			const logData: LogEntry = {
				message: "Algolia host attempt " + host,
				host: host,
				status: response.status,
				ok: response.ok,
				url,
				is_ssr_request: isSSRRequest,
				user_agent: userAgent,
				counter: counter++,
			};

			// Capture error response body for failed requests
			if (!response.ok) {
				try {
					const errorBody = await response.clone().text();
					logData.error_response_body = errorBody;
				} catch (e) {
					logData.error_body_read_failed = String(e);
				}
			}

			await logEvent("log", logData.message, logData);

			if (response.ok) {
				return response;
			}
		} catch (e) {
			await logEvent("error", "Algolia host error", {
				message: "Algolia host error",
				host,
				error: String(e),
				is_ssr_request: isSSRRequest,
				user_agent: userAgent,
			});
			// Network error, continue to next host
		}
	}

	return new Response("All Algolia hosts failed", { status: 502 });
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
		headers.set(
			"Access-Control-Allow-Origin",
			"https://www.avocadostore.de"
		);
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
	await logEvent(
		response.ok ? "log" : "error",
		"Algolia proxy request to " +
			ctx.pathname +
			(response.ok ? " succeeded" : " failed"),
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
