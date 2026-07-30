// A worked fabrika app that targets ZEROPS.
//
// The Cloudflare example (`examples/app`) declares `resources()` — an oblaka `Worker` graph. This one
// declares `target: { platform: 'zerops', … }`, which is a set of SERVICES in a project. The two are
// separate examples because each provider owns its authoring contract, so one config cannot accidentally
// mix both. The deployments disagree about the thing that matters most — on Cloudflare the app enforces its own gates
// in-process, and here it does not enforce them at all, because the proxy does (ADR-0007).
//
// ── What is deliberately NOT here ─────────────────────────────────────────────────────────────────
//
// `project`. The Zerops project already exists and its id is a REGISTRY field — `app_envs.zerops_project_id`
// (ADR-0006). Nothing in this file or the provider assumes an app→project mapping, and
// nothing keys off a naming convention. This app's services are imported INTO the project the registry
// names; `packages/installation-zerops/zerops/generated/apps-prod.zerops-import.yaml` is the import that created it.
//
// `pipeline.vars`. That surface exists to inject values into `process.env` before `resources()` builds a
// Cloudflare resource graph. There is no resource graph here, and per-environment configuration reaches
// a Zerops service as a service-level environment variable instead.
//
// A `build` command. Zerops has its own CI; `zerops.yaml` in this directory describes the build, and the
// deploy TRIGGERS it rather than running it (ADR-0003).

import { defineApp, type ZeropsResourceContext, type ZeropsServiceSpec } from '@fabrika/provider-zerops'
import { notesGates } from './fabrika.gates'
import { NOTES_APP_ID, notesSchema } from './fabrika.schema'

/** The runtime service — the one the app's code deploys to. Also the `zerops.yaml` setup name. */
export const NOTES_SERVICE = 'notesapi'
/** Its database. Reached at `notesdb:5432` over the project's private network; never publicly routed. */
export const NOTES_DATABASE_SERVICE = 'notesdb'

/**
 * Internal dial address the proxy forwards to once a request passes its gates. The app service has no
 * public route, so this is the ONLY way in.
 */
export const NOTES_UPSTREAM = `${NOTES_SERVICE}:3000`

/**
 * Hostname rules, from the published schema's own description: at most 25 characters, lowercase ASCII
 * letters and digits ONLY. No hyphens — `notes-api` is illegal, which is why these read the way they do.
 * There is no `pattern` in the schema, so nothing but `assertZeropsHostnames` catches a violation.
 *
 * Note also what is NOT in these names: an environment suffix. One project per environment (ADR-0006)
 * means `notesapi` in `apps-stage` and `notesapi` in `apps-prod` are different services on different
 * private networks, and staging genuinely cannot reach production's database.
 */
const services = (ctx: ZeropsResourceContext): ZeropsServiceSpec[] => [
	{
		hostname: NOTES_DATABASE_SERVICE,
		// Availability is encoded in the TYPE, deliberately: `mode` is deprecated in the published schema
		// and is not even representable in `ZeropsServiceSpec`. Production gets HA; every other
		// environment gets a single node, because a staging outage costs a retry and HA costs money in
		// every environment that has it.
		type: ctx.env === 'prod' ? 'postgresql:ha@18' : 'postgresql:single@18',
		// Higher priority is created FIRST, so the database exists before the runtime that migrates into
		// it at container start (`run.initCommands` in zerops.yaml).
		priority: 100,
	},
	{
		hostname: NOTES_SERVICE,
		type: 'alpine/bun@1.3',
		priority: 10,
		// NOT PUBLIC, and written explicitly rather than left to the platform default. The default already
		// protects a service nobody thought about; writing `false` makes turning it on a one-line diff in
		// review, and makes the re-applied import CORRECT a subdomain somebody enabled to debug something.
		// The proxy is the only publicly routed service in the project (ADR-0007).
		enableSubdomainAccess: false,
		minContainers: ctx.env === 'prod' ? 2 : 1,
		maxContainers: 4,
	},
]

export default defineApp({
	id: NOTES_APP_ID,
	// Reconciled into IAM by the deploy's last step. Its presence is what puts `reconcile-schema` in the
	// plan; the registry decides nothing about it.
	schema: notesSchema,
	pipeline: {
		/**
		 * DOCUMENTATION ON ZEROPS, NOT A DEPLOY STEP. The Zerops plan has no `sync-secrets` — the platform
		 * is the system of record for secret values and they change without a redeploy, so pushing them at
		 * deploy time would silently overwrite a GUI edit (ADR-0004). These are written once, as
		 * service-level `envSecrets` on `notesapi`, through the env API. Listing them here says what the
		 * app needs; nothing in this repo transports a value.
		 */
		secrets: ['NOTES_SESSION_PEPPER', 'NOTES_WEBHOOK_SIGNING_KEY'],
	},
	target: {
		platform: 'zerops',
		services,
		proxy: {
			upstream: NOTES_UPSTREAM,
			gates: notesGates,
		},
		// Required because the app declares more than one service: guessing which one carries the code
		// would deploy the app into the database the day someone reorders the array.
		deployService: NOTES_SERVICE,
		// Selects this app's setup from its repository-root `zerops.yaml`. Redundant while the setup name
		// equals the hostname (Zerops' own default), load-bearing the day either is renamed.
		zeropsSetup: NOTES_SERVICE,
	},
})
