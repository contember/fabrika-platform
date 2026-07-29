import { define } from '@fabrika/provider-cloudflare'
import config from './fabrika.config'

// A standalone app that consumes the IAM Worker over a service binding. In its OWN
// repo an app would add just this `IAM` binding to its existing Worker; here it is a
// whole tiny Worker so the example runs on its own.
//
// `ServiceReference('propustka-worker')` resolves to the deployed IAM Worker by name.
// Locally, lopata wires the two workers in-process (see lopata.config.ts).
export default define(({ env }) => config.resources({ env }))
