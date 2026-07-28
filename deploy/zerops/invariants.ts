// Invariants asserted on a COMPILED Zerops import document, on top of the two the engine's compiler
// already enforces (`assertZeropsInvariants` — no project-level env, `envIsolation: service`, no secret
// values, no duplicate hostnames; ADR-0004).
//
// These three are here rather than in `@fabrika/engine` because each needs a fact the compiler does not
// have:
//
//   • WHICH service is allowed to be public is a property of the topology (ADR-0007 says "the proxy"),
//     not of any single document. The compiler cannot know the proxy's hostname.
//   • The hostname RULE is in the schema's prose (`description`), not in its `pattern` — there is no
//     `pattern` keyword anywhere in the published document, so schema validation cannot catch it.
//   • `corePackage` cannot be DOWNGRADED once a project exists, so "did you mean to say SERIOUS?" is a
//     question worth failing on rather than a comment (ADR-0006).
//
// Everything here throws rather than returning a report: these are all cases where emitting the
// document would be worse than emitting nothing.

import type { ZeropsImportDocument } from '@fabrika/engine'

/**
 * The hostname rule, quoted from the published schema's own description: "duplicates in the same
 * project forbidden; maximum 25 characters, lowercase ASCII letters (a-z) or numbers (0-9) only".
 *
 * NOTE THE ABSENT HYPHEN. It is the one that bites — `run-logs` and `apps-prod` are natural names and
 * both are illegal. The schema does not encode this as a `pattern`, so nothing but this check catches it.
 */
const HOSTNAME = /^[a-z0-9]{1,25}$/

export const assertZeropsHostnames = (document: ZeropsImportDocument): void => {
	for (const service of document.services) {
		if (!HOSTNAME.test(service.hostname)) {
			throw new Error(
				`zerops: hostname \`${service.hostname}\` is illegal — max 25 chars, lowercase a-z and 0-9 only (no hyphens, no underscores, no dots)`,
			)
		}
	}
}

/**
 * ADR-0007: **only the proxy is publicly routed.** App services, the IAM service, the control plane and
 * the databases stay internal and are reached over the project's private network.
 *
 * Zerops makes this the default — a service is not publicly accessible until you opt in — so the failure
 * this guards against is not "we forgot to lock something down" but "someone added
 * `enableSubdomainAccess: true` to debug a service and it shipped". That is a one-word diff and it is
 * exactly the kind of thing review misses.
 *
 * `publicService` may be absent, which asserts that NOTHING in the document is publicly routed — the
 * right assertion for a document whose public entry point lives in another import.
 */
export const assertOnlyPublicService = (document: ZeropsImportDocument, publicService?: string): void => {
	for (const service of document.services) {
		if (service.enableSubdomainAccess === true && service.hostname !== publicService) {
			throw new Error(
				`zerops: service \`${service.hostname}\` enables public subdomain access; only \`${
					publicService ?? '(none)'
				}\` may be publicly routed (ADR-0007)`,
			)
		}
	}
	if (publicService !== undefined && !document.services.some((service) => service.hostname === publicService)) {
		throw new Error(`zerops: \`${publicService}\` is named as the public service but the document declares no such service`)
	}
}

/**
 * `corePackage` is per-project, upgrade-only, and its upgrade is partially destructive (logs and
 * statistics are lost) — so it is the one field in this document that a later `PUT` cannot fix
 * (ADR-0006). Require it to be stated rather than inherited from the platform default (`LIGHT`).
 */
export const assertCorePackageIsExplicit = (document: ZeropsImportDocument): void => {
	const project = document.project
	if (project === undefined) {
		return
	}
	if (project.corePackage === undefined) {
		throw new Error(`zerops: project \`${project.name}\` must state its corePackage — it defaults to LIGHT and cannot be downgraded later (ADR-0006)`)
	}
}

/** All three, for a document that creates its own project. */
export const assertTopologyInvariants = (document: ZeropsImportDocument, publicService?: string): void => {
	assertZeropsHostnames(document)
	assertOnlyPublicService(document, publicService)
	assertCorePackageIsExplicit(document)
}
