// The child of `writeGeneratedContract`: it runs in the application root with no credential in its environment, loads
// the application module, and prints its compiled contract in the shared encoding, which the build bundles.

import { encodedArtifactJson } from '@fabrika/auth-core'
import { join } from 'node:path'
import { IMPLEMENTATION_FILE } from './build.js'
import { compileContract } from './contract/compile.js'
import { isContractImplementation } from './implement/implement.js'

const module: unknown = await import(join(process.cwd(), IMPLEMENTATION_FILE))
const app = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
if (!isContractImplementation(app)) {
	console.error(`${IMPLEMENTATION_FILE} does not default-export serve(contract, { … })`)
	process.exit(1)
}
process.stdout.write(encodedArtifactJson(compileContract(app.contract, app.database?.tables ?? {})))
