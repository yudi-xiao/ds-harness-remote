import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const TEST_PASSWORD = 'local-cloudflare-test-password'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          DSH_SERVER_ACCOUNT: 'owner@example.com',
          DSH_SERVER_PASSWORD: TEST_PASSWORD,
          DSH_SERVER_PUBLIC_URL: 'http://localhost:8787',
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
})
