// Standalone Oblaka adapter for IAM. The environment contract and resource graph live in
// `fabrika.config.ts`; this file only supplies Oblaka's `{ env }` plus the deploy hostname.

import { environmentAliases } from '@fabrika/platform'
import { define } from '@fabrika/provider-cloudflare'
import { buildPropustkaWorker } from './fabrika.config'

export default define(({ env }) =>
	buildPropustkaWorker({
		env,
		domain: environmentAliases.read(process.env, { canonical: 'FABRIKA_IAM_HOSTNAME', legacy: 'PROPUSTKA_HOSTNAME' }),
	})
)
