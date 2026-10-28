// The fixture as a Worker module bundles it: the Postgres runtime and the application (`cloudflare-bundle.test.ts`).

export { createPostgresContractWorker, FabrikaJobObject } from '../../cloudflare-postgres'
export { cfpgApp } from './src/app'
