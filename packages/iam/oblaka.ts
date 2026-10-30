// Standalone Oblaka adapter for IAM. The environment contract and resource graph live in
// `fabrika.config.ts`; this file only supplies Oblaka's `{ env }` plus the deploy hostname.

import { define } from '@fabrika/provider-cloudflare'
import { buildIamWorker } from './fabrika.config'

export default define(({ env }) => buildIamWorker({ env, domain: process.env['FABRIKA_IAM_HOSTNAME'] }))
