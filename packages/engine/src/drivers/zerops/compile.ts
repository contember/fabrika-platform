// Compiles an app's Zerops declaration into the `zerops-import.yaml` document the platform's
// service-import endpoint takes. PURE — no network, no filesystem, no clock.
//
// THIS FILE IS WHERE ADR-0004's TWO INVARIANTS ARE ENFORCED, and they are enforced STRUCTURALLY, at three
// layers, so that "someone forgot" is not a reachable state:
//
//   1. TYPE. `ZeropsServiceSpec` / `ZeropsProjectSpec` (@fabrika/config) are the platform's contract MINUS
//      the fields fabrika owns — an app literally cannot type `envIsolation`, `envSecrets`,
//      `dotEnvSecrets`, `override`, or a project-level `envVariables`.
//   2. CONSTRUCTION. The compiler does not COPY an authored object and patch it; it BUILDS each entry and
//      writes `envIsolation: 'service'` (and `override: true`) itself. There is no code path that emits a
//      service or a project without them, because there is only one construction site.
//   3. ASSERTION. Every document passes `assertZeropsInvariants` before it is serialized. That catches the
//      case the types cannot: a config that arrived from JSON, a hand-built document, a future edit here.
//
// The failure this prevents is concrete: with `envIsolation: none` — a legal setting, and NOT reliably the
// default — every service in the project sees every other service's SERVICE-level variables, so app A's
// credentials leak to app B. "Never write to project-level env" alone does not prevent that; the isolation
// setting is the other half.

import type {
	ResourceContext,
	ZeropsAppTarget,
	ZeropsImportProject,
	ZeropsImportService,
	ZeropsProjectSpec,
	ZeropsServiceSpec,
} from '@fabrika/config'

/** The ONLY value fabrika ever writes for `envIsolation`, at either level. Not a default — an assertion. */
export const ENV_ISOLATION: 'service' = 'service'

/** A compiled import document: exactly the two top-level keys the platform's schema defines. */
export interface ZeropsImportDocument {
	/** Present only when fabrika is creating/reconciling the project itself. */
	project?: ZeropsImportProject
	services: ZeropsImportService[]
}

/** What the compiler needs beyond the app's declaration. */
export interface CompileInput {
	target: ZeropsAppTarget
	ctx: ResourceContext
	/**
	 * Provision every service WITHOUT code — the answer to ADR-0004's "no secret can be set before the
	 * service exists" gap. Import the services, write their secrets through the env API, deploy later.
	 * Applied on top of whatever a service declared, because it is a property of THIS import, not of the app.
	 */
	startWithoutCode?: boolean
}

/**
 * Build one service entry. `envIsolation` and `override` are written HERE, by the compiler, from
 * constants — never copied from the app and never conditional. Widening the spread to `...spec` would be
 * the bug: it would let an untyped config smuggle an `envIsolation` in, which is why the fields are listed.
 */
const compileService = (spec: ZeropsServiceSpec, startWithoutCode: boolean | undefined): ZeropsImportService => {
	const service: ZeropsImportService = {
		hostname: spec.hostname,
		type: spec.type,
		// ── compiler-owned, unconditional ────────────────────────────────────────
		// Each service sees ONLY its own variables. Set at service level too (not just on the project)
		// because the schema says a service-level value overrides the project's — so this holds even for a
		// project fabrika did not create and cannot correct (`RequestPutProject` has no `envIsolation`).
		envIsolation: ENV_ISOLATION,
		// Re-applying the document updates the existing service instead of colliding with it: the whole
		// idempotency claim of the `apply-import` step (ADR-0003).
		override: true,
	}
	if (spec.nginxConfig !== undefined) {
		service.nginxConfig = spec.nginxConfig
	}
	if (spec.objectStorageSize !== undefined) {
		service.objectStorageSize = spec.objectStorageSize
	}
	if (spec.objectStoragePolicy !== undefined) {
		service.objectStoragePolicy = spec.objectStoragePolicy
	}
	if (spec.objectStorageRawPolicy !== undefined) {
		service.objectStorageRawPolicy = spec.objectStorageRawPolicy
	}
	if (spec.buildFromGit !== undefined) {
		service.buildFromGit = spec.buildFromGit
	}
	if (spec.enableSubdomainAccess !== undefined) {
		service.enableSubdomainAccess = spec.enableSubdomainAccess
	}
	if (spec.priority !== undefined) {
		service.priority = spec.priority
	}
	if (spec.verticalAutoscaling !== undefined) {
		service.verticalAutoscaling = spec.verticalAutoscaling
	}
	if (spec.minContainers !== undefined) {
		service.minContainers = spec.minContainers
	}
	if (spec.maxContainers !== undefined) {
		service.maxContainers = spec.maxContainers
	}
	if (spec.profile !== undefined) {
		service.profile = spec.profile
	}
	if (spec.profileOverrides !== undefined) {
		service.profileOverrides = spec.profileOverrides
	}
	if (spec.mount !== undefined) {
		service.mount = spec.mount
	}
	if (spec.enableCdn !== undefined) {
		service.enableCdn = spec.enableCdn
	}
	if (spec.sshIsolation !== undefined) {
		service.sshIsolation = spec.sshIsolation
	}
	if (spec.zeropsSetup !== undefined) {
		service.zeropsSetup = spec.zeropsSetup
	}
	if (spec.zeropsYaml !== undefined) {
		service.zeropsYaml = spec.zeropsYaml
	}
	// `startWithoutCode` on the IMPORT wins over the app's own value: a provisioning import must be
	// code-free even for a service that normally builds from git.
	const codeless = startWithoutCode ?? spec.startWithoutCode
	if (codeless !== undefined) {
		service.startWithoutCode = codeless
	}
	return service
}

/**
 * Build the project entry. Note what is NOT here: `envVariables`. A project-level variable is injected
 * into EVERY service in the project and one project holds many apps, so writing one would hand app A's
 * credentials to app B (ADR-0004). There is no field to set and no branch that could set it.
 */
const compileProject = (spec: ZeropsProjectSpec): ZeropsImportProject => {
	const project: ZeropsImportProject = {
		name: spec.name,
		// Compiler-owned, unconditional. Settable at project CREATION only — `RequestPutProject` has no
		// `envIsolation` — so getting it wrong here is not correctable through the project API afterwards.
		envIsolation: ENV_ISOLATION,
	}
	if (spec.description !== undefined) {
		project.description = spec.description
	}
	if (spec.corePackage !== undefined) {
		project.corePackage = spec.corePackage
	}
	if (spec.tags !== undefined) {
		project.tags = spec.tags
	}
	if (spec.sshIsolation !== undefined) {
		project.sshIsolation = spec.sshIsolation
	}
	if (spec.sharedIpv4 !== undefined) {
		project.sharedIpv4 = spec.sharedIpv4
	}
	if (spec.location !== undefined) {
		project.location = spec.location
	}
	return project
}

/**
 * The last gate before serialization: re-check ADR-0004's invariants on the FINISHED document. The types
 * make a violation unauthorable and the construction makes it unemittable; this catches everything else —
 * a config deserialized from JSON, a document assembled by hand, a future edit to this file.
 *
 * Deliberately checks the emitted document rather than the input: it is the document that reaches Zerops.
 */
export const assertZeropsInvariants = (document: ZeropsImportDocument): void => {
	const project = document.project
	if (project !== undefined) {
		if (project.envVariables !== undefined) {
			throw new Error('zerops: refusing to write PROJECT-level env variables — they reach every service in the project (ADR-0004)')
		}
		if (project.envIsolation !== ENV_ISOLATION) {
			throw new Error(`zerops: project envIsolation must be \`${ENV_ISOLATION}\`, got \`${String(project.envIsolation)}\` (ADR-0004)`)
		}
	}
	if (document.services.length === 0) {
		throw new Error('zerops: import document declares no services')
	}
	const seen = new Set<string>()
	for (const service of document.services) {
		if (service.envIsolation !== ENV_ISOLATION) {
			throw new Error(
				`zerops: service \`${service.hostname}\` envIsolation must be \`${ENV_ISOLATION}\`, got \`${String(service.envIsolation)}\` (ADR-0004)`,
			)
		}
		if (service.envSecrets !== undefined || service.dotEnvSecrets !== undefined) {
			// Never assert on the VALUE — only that the field is present.
			throw new Error(
				`zerops: service \`${service.hostname}\` carries secrets in the import document; secrets are written through the env API (ADR-0004)`,
			)
		}
		if (seen.has(service.hostname)) {
			throw new Error(`zerops: duplicate service hostname \`${service.hostname}\` in the import document`)
		}
		seen.add(service.hostname)
	}
}

/** Compile an app's Zerops declaration into the import document, invariants already checked. */
export const compileImport = (input: CompileInput): ZeropsImportDocument => {
	const services = input.target.services(input.ctx).map((spec) => compileService(spec, input.startWithoutCode))
	const document: ZeropsImportDocument = input.target.project === undefined
		? { services }
		: { project: compileProject(input.target.project), services }
	assertZeropsInvariants(document)
	return document
}

// ── YAML serialization ──────────────────────────────────────────────────────────

/** Keys/scalars that are safe unquoted in YAML. Everything else gets a double-quoted, JSON-escaped form. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_./@+-]*$/

const scalar = (value: string): string => {
	// Reserved plain scalars that YAML would read as booleans/null, plus anything with structure.
	const reserved = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'])
	if (value !== '' && PLAIN.test(value) && !reserved.has(value.toLowerCase())) {
		return value
	}
	return JSON.stringify(value)
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value)

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !isArray(value)

/**
 * Serialize a compiled document to YAML. Deliberately hand-rolled and tiny: the value space is closed
 * (strings, numbers, booleans, arrays, plain objects — no dates, no cycles, no anchors), a YAML dependency
 * for that would be all risk and no benefit, and the emitter is exercised by every compiler test.
 *
 * Multi-line strings (an inline `nginxConfig`, a `zerops.yaml` command) are emitted as a literal block so
 * their newlines survive intact.
 */
const emit = (value: unknown, indent: number): string[] => {
	const pad = '  '.repeat(indent)
	if (isArray(value)) {
		if (value.length === 0) {
			return [`${pad}[]`]
		}
		const lines: string[] = []
		for (const item of value) {
			const rendered = emit(item, indent + 1)
			const first = rendered[0] ?? ''
			lines.push(`${pad}- ${first.trimStart()}`)
			lines.push(...rendered.slice(1))
		}
		return lines
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
		if (entries.length === 0) {
			return [`${pad}{}`]
		}
		const lines: string[] = []
		for (const [key, entry] of entries) {
			if (isPlainObject(entry) || isArray(entry)) {
				const rendered = emit(entry, indent + 1)
				// An empty collection renders inline so the key never dangles.
				if (rendered.length === 1 && (rendered[0]?.trim() === '{}' || rendered[0]?.trim() === '[]')) {
					lines.push(`${pad}${scalar(key)}: ${rendered[0]?.trim() ?? ''}`)
					continue
				}
				lines.push(`${pad}${scalar(key)}:`)
				lines.push(...rendered)
				continue
			}
			lines.push(...emit(entry, indent).map((line, index) => (index === 0 ? `${pad}${scalar(key)}: ${line.trimStart()}` : line)))
		}
		return lines
	}
	if (typeof value === 'string') {
		if (value.includes('\n')) {
			const body = value.replace(/\n$/, '').split('\n').map((line) => `${pad}  ${line}`)
			return [`${pad}|-`, ...body]
		}
		return [`${pad}${scalar(value)}`]
	}
	if (value === null) {
		return [`${pad}null`]
	}
	return [`${pad}${String(value)}`]
}

/**
 * Render an arbitrary Zerops document (a `zerops.yaml`, a fragment) with the SAME emitter the import
 * document uses. Exported so nothing outside this file has to grow a second YAML writer: two emitters
 * disagreeing about quoting or block scalars is a class of bug worth spending one export to avoid.
 *
 * Deliberately does NOT assert the import invariants — it does not know it is looking at an import
 * document. `renderImportYaml` is the entry point that does, and it is the one the driver calls.
 */
export const renderYaml = (value: unknown): string => `${emit(value, 0).join('\n')}\n`

/**
 * Render a compiled document as the `zerops-import.yaml` text the API takes. Re-asserts the invariants:
 * this is the last place the document is still inspectable, and the only place it becomes a string.
 */
export const renderImportYaml = (document: ZeropsImportDocument): string => {
	assertZeropsInvariants(document)
	const lines: string[] = []
	if (document.project !== undefined) {
		lines.push('project:')
		lines.push(...emit(document.project, 1))
	}
	lines.push('services:')
	lines.push(...emit(document.services, 1))
	return `${lines.join('\n')}\n`
}

/** Compile + render in one step — what the driver's `apply-import` step actually calls. */
export const compileImportYaml = (input: CompileInput): { document: ZeropsImportDocument; yaml: string } => {
	const document = compileImport(input)
	return { document, yaml: renderImportYaml(document) }
}

/**
 * Compile the PROVISIONING import: the same document with every service forced `startWithoutCode: true`.
 *
 * This is ADR-0004's recorded gap closed. The ADR accepted a cost — "no secret can be set before the
 * Zerops service exists, so registration must provision" — and `startWithoutCode` makes that provisioning
 * cheap and code-free. The order becomes: register the app → import its services with no code → write
 * their secrets through the SERVICE-level env API → deploy later. No local secret buffer, no secret in
 * this document, and no secret held anywhere fabrika could leak it.
 *
 * Called by the control plane at EDIT time, not by the driver: on Zerops, pushing secrets is not a deploy
 * step at all.
 */
export const compileProvisioningYaml = (input: Omit<CompileInput, 'startWithoutCode'>): { document: ZeropsImportDocument; yaml: string } =>
	compileImportYaml({ ...input, startWithoutCode: true })
