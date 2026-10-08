import { define } from '@fabrika/provider-cloudflare'
import { buildExampleProxy } from './fabrika.config'

// A standalone proxy + app composition that consumes the IAM Worker over service bindings. A deploy
// takes only the application Worker and the gates, and the platform builds the proxy (ADR-0048); this
// local run puts the same proxy in front so the boundary runs on its own.
//
// `iamServiceReference()` resolves to the deployed IAM Worker by name, at its `PropustkaApplication` entrypoint.
// Locally, lopata wires the two workers in-process (see lopata.config.ts).
export default define(({ env }) => buildExampleProxy({ env }))
