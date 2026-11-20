import { compileContract } from '@fabrika/app/contract'
import { composeLocalApplication, define, stageLocalAssets } from '@fabrika/provider-cloudflare'
import config from './fabrika.config'
import { contract } from './fabrika.contract'
import { tables } from './src/db/tables'

/** Where `bun run dev` in `packages/iam` serves IAM, the issuer of the local run's tokens. */
const LOCAL_IAM_ORIGIN = 'http://localhost:18191'

// A local run of the proxy + app composition a deploy builds, over IAM's service binding. A deploy never reads this
// file: the deployer composes the same Workers from the config and the contract itself.
//
// `iamServiceReference()` resolves to the deployed IAM Worker by name, at its `PropustkaApplication` entrypoint.
// Locally, lopata wires the two workers in-process (see lopata.config.ts).
const compiled = compileContract(contract, tables)

// The `site` mount's files, staged into `fabrika/assets` by the deploy's code. oblaka imports this module before it
// calls `define`, so `bun run build:web` must have written `dist/web` first.
const assets = await stageLocalAssets(compiled, import.meta.dir)

export default define(({ env }) => composeLocalApplication({ config, contract: compiled, assets, iamOrigin: LOCAL_IAM_ORIGIN, env }))
