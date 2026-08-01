import { define } from '@fabrika/provider-cloudflare'
import config from './fabrika.config'

// A standalone proxy + app composition that consumes the IAM Worker over service bindings. In its
// OWN repo an app would keep its application Worker private and add the proxy root around it; here
// both are a whole tiny graph so the boundary runs on its own.
//
// `ServiceReference('propustka-worker')` resolves to the deployed IAM Worker by name.
// Locally, lopata wires the two workers in-process (see lopata.config.ts).
export default define(({ env }) => config.resources({ env }))
