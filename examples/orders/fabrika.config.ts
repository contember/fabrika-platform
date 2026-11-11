import { defineApp } from '@fabrika/provider-cloudflare'

// The application Worker that `defineApp` builds, on Cloudflare: one Durable Object over SQLite. Locally,
// `fabrika app dev` serves the same contract through its test kit on an in-memory SQLite database, with no cloud and
// no database server. The deploy builds the SPA first (`dist/web`).
export default defineApp({ id: 'orders', pipeline: { build: 'bun run build:web' } })
