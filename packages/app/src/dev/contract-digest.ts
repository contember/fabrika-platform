// The launcher's child that answers whether a commit changed the contract (ADR-0049). It runs in the application root
// with no credential in its environment, loads the application module the launcher itself never loads, and prints the
// digest the application's boot compares with `FABRIKA_CONTRACT_DIGEST`.

import { contractDigest } from '@fabrika/auth-core'
import { join } from 'node:path'
import { IMPLEMENTATION_FILE } from '../build.js'
import { compileContract } from '../contract/compile.js'
import { isContractImplementation } from '../implement/implement.js'

const module: unknown = await import(join(process.cwd(), IMPLEMENTATION_FILE))
const app = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
if (!isContractImplementation(app)) {
	console.error(`${IMPLEMENTATION_FILE} does not default-export serve(contract, { … })`)
	process.exit(1)
}
console.log(contractDigest(compileContract(app.contract, app.database?.tables ?? {})))
