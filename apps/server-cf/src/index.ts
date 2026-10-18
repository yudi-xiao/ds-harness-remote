import { readConfig, type ServerEnv } from './types.js'

export { RemoteGateway } from './gateway.js'

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS } })
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error: { code, message: code, requestId: crypto.randomUUID(), retryable: status >= 500 } })
}

function withSecurity(response: Response): Response {
  if (response.status === 101) return response
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * HTTPS entry point for the Cloudflare self-hosted server.
 *
 * The Worker validates deployment configuration and same-origin rules, routes
 * `/api/v1/*` and `/ws/v1/connect` into the single Durable Object, and serves the
 * existing login/device UI (apps/server/web build output) through Workers Assets.
 */
export default {
  async fetch(request: Request, env: ServerEnv): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    let config
    try {
      config = readConfig(env)
    } catch {
      return withSecurity(errorResponse(503, 'SERVER_MISCONFIGURED'))
    }
    const origin = request.headers.get('Origin')
    if ((origin && origin !== config.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return withSecurity(errorResponse(403, 'AUTH_INVALID'))
    }
    if (path === '/ws/v1/connect') {
      if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') return withSecurity(errorResponse(400, 'INVALID_MESSAGE'))
      try {
        return await env.REMOTE.get(env.REMOTE.idFromName('self-hosted')).fetch(request)
      } catch {
        return withSecurity(errorResponse(500, 'INTERNAL_ERROR'))
      }
    }
    if (path.startsWith('/api/v1/')) {
      try {
        return withSecurity(await env.REMOTE.get(env.REMOTE.idFromName('self-hosted')).fetch(request))
      } catch {
        return withSecurity(errorResponse(500, 'INTERNAL_ERROR'))
      }
    }
    if (path === '/health' || path === '/healthz' || path === '/ready') {
      return withSecurity(jsonResponse(200, { status: 'ok' }))
    }
    if (request.method === 'GET' && (path === '/' || path === '/app' || path === '/app/login')) {
      try {
        const index = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString(), { headers: request.headers }))
        return withSecurity(index)
      } catch {
        return withSecurity(errorResponse(404, 'METHOD_NOT_FOUND'))
      }
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      try {
        return withSecurity(await env.ASSETS.fetch(request))
      } catch {
        return withSecurity(errorResponse(404, 'METHOD_NOT_FOUND'))
      }
    }
    return withSecurity(errorResponse(404, 'METHOD_NOT_FOUND'))
  },
} satisfies ExportedHandler<ServerEnv>
