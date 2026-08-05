// Standalone Oblaka adapter for IAM. The environment contract and resource graph live in
// `fabrika.config.ts`; this file only supplies Oblaka's `{ env }` plus the deploy hostname.

import { define } from '@fabrika/provider-cloudflare'
import { buildPropustkaWorker } from './fabrika.config'

export default define(({ env }) => buildPropustkaWorker({ env, domain: process.env['FABRIKA_IAM_HOSTNAME'] }))
