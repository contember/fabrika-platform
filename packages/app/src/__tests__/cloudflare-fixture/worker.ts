// The fixture as a Worker module bundles it: the runtime and the application (`cloudflare-bundle.test.ts`).

export { createContractWorker, FabrikaApplication } from '../../cloudflare'
export { notesApp } from './src/app'
