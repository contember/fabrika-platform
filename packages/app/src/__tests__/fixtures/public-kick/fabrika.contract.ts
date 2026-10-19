// Public procedures that kick a job: `signup` and `apply` start a run of `welcome` once their row committed; `notify`
// is the same kind of procedure without `kicks`, whose answer the others must match.

import { app } from './src/app-kit'
import { visitors } from './src/visitors'
import { welcome } from './src/welcome'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { visitors }),
	jobs: { welcome },
}))
