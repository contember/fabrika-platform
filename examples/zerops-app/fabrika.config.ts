// A worked fabrika app that targets ZEROPS.
//
// A Cloudflare app declares `resources()` — an oblaka `Worker` graph. This one declares
// `target: { platform: 'zerops', … }`, which is a set of SERVICES in a project. Each provider owns its
// authoring contract, so one config cannot accidentally mix both. On both providers the proxy alone
// evaluates route gates; the app verifies the injected token and owns only per-object checks.
// See https://github.com/contember/fabrika-platform/blob/main/docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md.
//
// ── What is deliberately NOT here ─────────────────────────────────────────────────────────────────
//
// `project`. The Zerops project already exists and its id belongs to the control-plane registry.
// Nothing in this file or the provider assumes an app→project mapping or keys off a naming convention.
// This app's services are imported INTO the project the registry names.
//
// `pipeline.vars`. That surface injects values into `process.env` before the app's configuration is
// compiled — on Cloudflare before `resources()` builds a resource graph, here before the import document
// is rendered, where a declared name becomes a `${NAME}` the deploy substitutes. This app declares none:
// the one per-installation value it needs is `FABRIKA_IAM_ISSUER`, which the platform owns and every
// deploy writes into the service (ADR-0035). A variable this file does not declare is refused where it
// is set, rather than stored and ignored.
//
// A `build` command. Zerops has its own CI; the repository-root `zerops.yaml` describes the build, and
// the deploy TRIGGERS it rather than running it.

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
 * Note also what is NOT in these names: an environment suffix. One project per environment means
 * `notesapi` in staging and `notesapi` in production are different services on different private
 * networks, and staging genuinely cannot reach production's database.
 */
const services = (_ctx: ZeropsResourceContext): ZeropsServiceSpec[] => [
	{
		hostname: NOTES_DATABASE_SERVICE,
		// One node on EVERY environment, `prod` included. Availability is encoded in the TYPE — `mode` is
		// deprecated in the published schema and is not representable in `ZeropsServiceSpec` — so moving to
		// HA is a new service and a data migration, not an edit. That is a deliberate trade: most apps are
		// small on every environment they have, and paying three DEDICATED containers on the chance one of
		// them is not costs more, every month, than the migration costs once.
		type: 'postgresql:single@18',
		// Sized, not defaulted. Omitting `profile` is not a neutral act: a single service silently gets
		// `oltp-staging` and an HA one `oltp-production` (two DEDICATED cores and 4 GB per container,
		// three containers). `oltp-hobby` is the cheapest preset this type offers, and cheap is not small:
		// every profile shares the same 8-core / 48 GB ceiling and the same autoscaler, so a profile picks
		// the FLOOR and the tuning preset, never the cap. An example is where people copy their defaults
		// from, so this one copies well.
		profile: 'oltp-hobby',
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
		// review. It does not undo one enabled by hand — a re-applied import leaves an existing service
		// untouched. The proxy is the only publicly routed service in the project.
		enableSubdomainAccess: false,
		// One container, and `maxContainers` unchanged: the floor is what an idle app pays for, the
		// ceiling is what a busy one reaches.
		minContainers: 1,
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
		 * deploy time would silently overwrite a GUI edit. These are written once, as
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
