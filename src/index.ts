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
	status: string;
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

const AGENT =
	"Algolia%20for%20JavaScript%20(5.8.1)%3B%20Lite%20(5.8.1)%3B%20Browser%3B%20autocomplete-core%20(1.17.4)%3B%20autocomplete-js%20(1.17.4)" as const;

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
		const isSSRRequest = request.headers.get("x-ssr-request") === "ASDf928gh2efhajsdf!!";

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
					})
				);
				return result.error;
			}
			bodyStr = JSON.stringify(result.body);
		}

		// Caching Logic
		// Note: Cloudflare Cache API caches responses based on the full request URL.
		// For POST requests, we create a synthetic GET request with a cache key parameter.
		// Reference: https://developers.cloudflare.com/workers/runtime-apis/cache/
		const cache = caches.default;
		const cacheKeyParam =
			reqContext.searchParams.get("cacheKey") ||
			request.headers.get("X-AS-Cache-Key");
		let cacheKeyUrl: string | undefined;
		let response: Response | undefined;
		let isCacheHit = false;

		if (request.method === "POST" && cacheKeyParam) {
			const cacheUrl = new URL(url.toString());
			cacheUrl.searchParams.set("cacheKey", cacheKeyParam);

			// Add SSR indicator to cache key to separate SSR and client-side cache entries
			cacheUrl.searchParams.set("ssr", isSSRRequest ? "1" : "0");
			cacheKeyUrl = cacheUrl.toString();

			console.log(
				JSON.stringify({
					message: "Cache lookup",
					cacheKey: cacheKeyUrl,
					isSSR: isSSRRequest,
				})
			);

			// Create a GET request for cache lookup (POST requests are not cached by default)
			// Filter out body-related headers that would conflict with GET method
			const cacheHeaders = new Headers();
			for (const [key, value] of request.headers.entries()) {
				const lowerKey = key.toLowerCase();
				if (!BLACKLIST_HEADERS_FOR_GET.includes(lowerKey)) {
					cacheHeaders.set(key, value);
				}
			}

			console.log(
				JSON.stringify({
					message: "Cache key request details",
					url: cacheKeyUrl,
					method: "GET",
					headersCount: Array.from(cacheHeaders.keys()).length,
				})
			);
			const cachedResponse = await cache.match(cacheKeyUrl);
			console.log(
				JSON.stringify({
					message: "response json",
					response: cachedResponse,
				})
			);

			if (cachedResponse) {
				console.log(
					JSON.stringify({
						message: "Cache hit",
						cacheKey: cacheKeyUrl,
						status: cachedResponse.status,
						cacheControl:
							cachedResponse.headers.get("Cache-Control"),
					})
				);
				console.log(JSON.stringify(cachedResponse));
				response = cachedResponse;
				isCacheHit = true;
			} else {
				console.log(
					JSON.stringify({
						message: "Cache miss",
						cacheKey: cacheKeyUrl,
					})
				);
			}
		}

		if (!response) {
			response = await fetchFromAlgolia(
				reqContext,
				request.headers,
				bodyStr,
				env
			);

			if (cacheKeyUrl && response.ok) {
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

				console.log(
					JSON.stringify({
						message: "Cache store",
						cacheKey: cacheKeyUrl,
						cacheTtl: cacheTtl,
						responseStatus: response.status,
					})
				);

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
	env?: Env
): Promise<Response> {
	const { pathname } = ctx;
	// Create a copy of searchParams to avoid mutating the original URL
	const algoliaParams = new URLSearchParams(ctx.searchParams.toString());
	algoliaParams.set("x-algolia-api-key", env?.ALGOLIA_API_KEY || "");
	algoliaParams.set(
		"x-algolia-application-id",
		env?.ALGOLIA_APPLICATION_ID || ""
	);
	algoliaParams.set("x-algolia-agent", AGENT);

	const search = `?${algoliaParams.toString()}`;
	const headers: Record<string, string> = {};
	for (const [key, value] of originalHeaders.entries()) {
		headers[key] = value;
	}

	if (pathname === "/1/events") {
		const insightsUrl = "https://insights.algolia.io/1/events" + search;
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
	}

	const hosts = getHosts(env?.ALGOLIA_APPLICATION_ID || "");
	return await tryAlgoliaHosts(
		pathname,
		search,
		ctx.method,
		headers,
		bodyStr,
		hosts
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
	hosts?: readonly string[]
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

			console.log(
				JSON.stringify({
					message:
						"Algolia host attempt " +
						host +
						" counter:" +
						counter++,
					host,
					status: response.status,
					ok: response.ok,
					url,
				})
			);

			if (response.ok) {
				return response;
			}
		} catch (e) {
			console.error(
				JSON.stringify({
					message: "Algolia host error",
					host,
					error: String(e),
				})
			);
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
		response.ok ? "info" : "error",
		"Algolia proxy request to " +
			ctx.pathname +
			(response.ok ? " succeeded" : " failed"),
		logContext
	);
}

async function logEvent(
	level: "info" | "error" | "warn",
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
			console.error(JSON.stringify(log));
		} else if (level === "warn") {
			console.warn(JSON.stringify(log));
		} else {
			console.log(JSON.stringify(log));
		}
	} catch (error) {
		console.error("Failed to log event:", error);
	}
}
