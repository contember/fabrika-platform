// The driver registry — the engine's ONE piece of per-platform knowledge, and it is data: a map from
// a target's `platform` discriminant to the driver that serves it (ADR-0009). Adding a platform means
// adding a key here, never a branch in `deploy.ts`.
//
// Still PARTIAL by TYPE (`DriverRegistry` is optional-keyed) on purpose: a platform may be a legitimate
// target variant before anyone has written its driver, and `deploy()` reports that as a clean error rather
// than the type system pretending a driver exists.

import type { DriverRegistry } from '../driver'
import { cloudflareDriver } from './cloudflare'
import { zeropsDriver } from './zerops'

/** The drivers `deploy()` uses when the caller doesn't supply its own registry. */
export const defaultDrivers: DriverRegistry = {
	cloudflare: cloudflareDriver,
	zerops: zeropsDriver,
}
