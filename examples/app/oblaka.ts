import { compileContract } from '@fabrika/app/contract'
import { composeLocalApplication, define } from '@fabrika/provider-cloudflare'
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
export default define(({ env }) => composeLocalApplication({ config, contract: compileContract(contract, tables), iamOrigin: LOCAL_IAM_ORIGIN, env }))
