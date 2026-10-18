export interface ServerEnv {
  ASSETS: Fetcher
  REMOTE: DurableObjectNamespace
  DSH_SERVER_ACCOUNT: string
  DSH_SERVER_PASSWORD: string
  DSH_SERVER_PUBLIC_URL: string
}

export interface ServerConfig {
  /** Configured account name (trimmed). */
  account: string
  /** Plain-text deployment password. Never persisted as-is. */
  password: string
  /** Canonical HTTP(S) origin used for cookie, Origin checks and descriptor output. */
  origin: string
  secure: boolean
}

/**
 * Validate the deployment configuration the same way apps/server validates its
 * environment at startup. Workers cannot refuse to start, so the Worker answers
 * 503 SERVER_MISCONFIGURED before any request reaches the Durable Object.
 */
export function readConfig(env: ServerEnv): ServerConfig {
  const account = (env.DSH_SERVER_ACCOUNT ?? '').trim()
  const password = env.DSH_SERVER_PASSWORD ?? ''
  if (!account) throw new Error('DSH_SERVER_ACCOUNT is required.')
  if (password.length < 12) throw new Error('DSH_SERVER_PASSWORD must be at least 12 characters.')
  const url = new URL(env.DSH_SERVER_PUBLIC_URL ?? '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DSH_SERVER_PUBLIC_URL must be an HTTP(S) origin.')
  }
  return { account, password, origin: url.origin, secure: url.protocol === 'https:' }
}
