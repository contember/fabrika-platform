// @fabrika/app/testing/isolation — the kits behind the tests `fabrika db test-scaffold` generates: the policy isolation
// kit (the data layer enforces each table policy) and the endpoint access kit (the application's own endpoints refuse
// another scope). A subpath of its own: it loads `@fabrika/db/testing`, which needs Bun and Postgres.

import { refuseInProduction } from '@fabrika/db/production'

refuseInProduction('@fabrika/app/testing/isolation')

export { type DeniedOutcome, type EndpointAccessKit, endpointAccessKit, type LeakOutcome } from './endpoint-access'
export {
	type ChildIsolationRow,
	type CountOutcome,
	type IsolationOutcome,
	type IsolationRow,
	type ListOutcome,
	type MisuseOutcome,
	type PolicyIsolationKit,
	policyIsolationKit,
	type ReadOutcome,
} from './policy-isolation'
