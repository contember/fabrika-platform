// The names fabrika's own components take on a Cloudflare account. Every remote name is `${env}-${name}`, except the
// oblaka state namespaces, which are used verbatim. An installation keeps the scheme it was created with: renaming a
// live resource would orphan its data (a D1 database, a bucket, a queue's messages), so nothing here moves one.

/**
 * The installation-level switch, read from the platform deploy's environment. `platform init` writes `fabrika` into a
 * new installation's GitHub Environment; an installation created before the switch existed has none and keeps `legacy`.
 */
export const PLATFORM_NAMES_ENV = 'FABRIKA_CLOUDFLARE_NAMES'

export type PlatformNameScheme = 'legacy' | 'fabrika'

export interface PlatformNames {
	readonly controlWorker: string
	readonly controlProxy: string
	readonly controlDatabase: string
	readonly runLogs: string
	readonly deployQueue: string
	readonly mailQueue: string
	readonly mailContent: string
	readonly runnerWorker: string
	readonly runnerContainer: string
	readonly iamWorker: string
	readonly iamDatabase: string
	readonly operationsWorker: string
	readonly operationsProxy: string
	readonly operationsDatabase: string
	readonly operationsPayloads: string
	readonly operationsIngest: string
	readonly operationsIngestDlq: string
	/** oblaka's state namespace of each component's deploy, by the component's IAM application id. */
	readonly stateNamespaces: Readonly<Record<string, string>>
}

const LEGACY: PlatformNames = {
	controlWorker: 'vozka',
	controlProxy: 'vozka-proxy',
	controlDatabase: 'vozka',
	runLogs: 'vozka-run-logs',
	deployQueue: 'vozka-deploy',
	mailQueue: 'fabrika-mail',
	mailContent: 'fabrika-mail-content',
	runnerWorker: 'vozka-runner',
	runnerContainer: 'vozka-deploy-runner',
	iamWorker: 'propustka-worker',
	iamDatabase: 'propustka',
	operationsWorker: 'operations',
	operationsProxy: 'operations-proxy',
	operationsDatabase: 'operations',
	operationsPayloads: 'operations-payloads',
	operationsIngest: 'operations-ingest',
	operationsIngestDlq: 'operations-ingest-dlq',
	// IAM's is the one the scaffolded workflow always named; the others are oblaka's `<app id>-state` default.
	stateNamespaces: {
		propustka: 'propustka-state',
		vozka: 'vozka-state',
		'vozka-runner': 'vozka-runner-state',
		operations: 'operations-state',
	},
}

const FABRIKA: PlatformNames = {
	controlWorker: 'fabrika-control',
	controlProxy: 'fabrika-control-proxy',
	controlDatabase: 'fabrika-control',
	runLogs: 'fabrika-run-logs',
	deployQueue: 'fabrika-deploy',
	mailQueue: 'fabrika-control-mail',
	mailContent: 'fabrika-control-mail-content',
	runnerWorker: 'fabrika-runner',
	runnerContainer: 'fabrika-deploy-runner',
	iamWorker: 'fabrika-iam',
	iamDatabase: 'fabrika-iam',
	operationsWorker: 'fabrika-operations',
	operationsProxy: 'fabrika-operations-proxy',
	operationsDatabase: 'fabrika-operations',
	operationsPayloads: 'fabrika-operations-payloads',
	operationsIngest: 'fabrika-operations-ingest',
	operationsIngestDlq: 'fabrika-operations-ingest-dlq',
	// One namespace per component: oblaka keys its state by env, and every component deploys in the same env.
	stateNamespaces: {
		propustka: 'fabrika-iam-state',
		vozka: 'fabrika-control-state',
		'vozka-runner': 'fabrika-runner-state',
		operations: 'fabrika-operations-state',
	},
}

/** The scheme the switch names. Unset or empty is `legacy`; any other value is refused, never guessed. */
export const platformNameScheme = (source: Readonly<Record<string, string | undefined>>): PlatformNameScheme => {
	const value = source[PLATFORM_NAMES_ENV]
	if (value === undefined || value === '' || value === 'legacy') return 'legacy'
	if (value === 'fabrika') return 'fabrika'
	throw new Error(`${PLATFORM_NAMES_ENV} must be \`fabrika\` or \`legacy\`, not \`${value}\``)
}

export const platformNamesOf = (scheme: PlatformNameScheme): PlatformNames => scheme === 'fabrika' ? FABRIKA : LEGACY

/** The names of the installation whose platform deploy reads `source`. */
export const platformNames = (source: Readonly<Record<string, string | undefined>>): PlatformNames => platformNamesOf(platformNameScheme(source))

const namesOf = (names: PlatformNames): string[] => {
	const { stateNamespaces, ...resources } = names
	return [...Object.values(resources), ...Object.values(stateNamespaces)]
}

/**
 * Every name either scheme gives fabrika's own components. oblaka ADOPTS an existing `${env}-${name}`, so an
 * application that names one would take over the platform's own Worker, database or bucket; both schemes are refused
 * whatever the installation uses, because an account may hold an older installation of the other scheme.
 */
export const PLATFORM_RESOURCE_NAMES: ReadonlySet<string> = new Set([...namesOf(LEGACY), ...namesOf(FABRIKA)])
