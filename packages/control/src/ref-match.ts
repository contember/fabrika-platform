// Matching a registered env's `trigger_ref` against a concrete git ref. A trigger_ref is normally an
// exact ref (`refs/heads/deploy/prod`), but may be a GLOB (contains `*`) so an env can subscribe to a
// FAMILY of refs — most usefully release tags: `refs/tags/v*` deploys on every `v…` tag push (webhook)
// or the newest matching tag (poll). The concrete ref to deploy is always resolved at trigger time (the
// pushed ref, or the resolved tag) — never the pattern itself.

/** The prefix of every stored trigger_ref: a push event and the poller name a ref in full. */
const REF_PREFIX = 'refs/'

/** The branch namespace of MCP workspaces (`fabrika/<workspace id>`, ADR-0049). */
export const WORKSPACE_BRANCH_PREFIX = 'fabrika/'
const WORKSPACE_REF_PREFIX = `refs/heads/${WORKSPACE_BRANCH_PREFIX}`

/** A trigger ref `canonicalTriggerRef` refuses; its message says why. */
export class TriggerRefValidationError extends Error {
	constructor(readonly triggerRef: string, message = invalidTriggerRefMessage(triggerRef)) {
		super(message)
		this.name = 'TriggerRefValidationError'
	}
}

function invalidTriggerRefMessage(triggerRef: string): string {
	return `trigger ref "${triggerRef}" must be a branch name (deploy/prod, stored as refs/heads/deploy/prod) or a full ref `
		+ '(refs/heads/<branch>, refs/tags/<tag>, or a * glob such as refs/tags/v*)'
}

/** A ref under the workspace branch namespace. Workspaces deploy only through `deploy_stage`, never on a push. */
export function isWorkspaceRef(ref: string): boolean {
	return ref.startsWith(WORKSPACE_REF_PREFIX)
}

/**
 * The stored form of a trigger ref. A full ref (`refs/…`) is kept; a bare name is a branch, `refs/heads/<name>`, because
 * `refMatches` compares against the full ref a push names. A tag needs its full form. Throws `TriggerRefValidationError`
 * for whitespace, a control character, an empty path segment, or a ref under the workspace branch namespace.
 */
export function canonicalTriggerRef(value: string): string {
	const canonical = value.startsWith(REF_PREFIX) ? value : `refs/heads/${value}`
	const segments = canonical.split('/')
	// `refs`, a namespace (`heads`, `tags`, …), and at least one segment of the name.
	if (segments.length < 3 || segments.includes('') || /[\s\p{Cc}]/u.test(canonical)) {
		throw new TriggerRefValidationError(value)
	}
	if (isWorkspaceRef(canonical)) {
		throw new TriggerRefValidationError(
			value,
			`trigger ref "${value}" names the workspace branches (${WORKSPACE_REF_PREFIX}…), which deploy only through deploy_stage`,
		)
	}
	return canonical
}

/** A trigger_ref is a PATTERN when it contains a `*` glob; otherwise it's an exact git ref. */
export function isRefPattern(triggerRef: string): boolean {
	return triggerRef.includes('*')
}

/**
 * Does a concrete git ref match an env's `trigger_ref`? Exact string equality unless the trigger_ref is
 * a glob, where `*` matches any run of characters. The literal `refs/heads/` or `refs/tags/` prefix is
 * preserved, so a tag pattern (`refs/tags/v*`) never matches a branch ref and vice versa. A workspace
 * branch matches no trigger_ref, also one stored before `canonicalTriggerRef` refused that namespace.
 */
export function refMatches(triggerRef: string, ref: string): boolean {
	if (isWorkspaceRef(ref)) {
		return false
	}
	if (!isRefPattern(triggerRef)) {
		return triggerRef === ref
	}
	return globToRegExp(triggerRef).test(ref)
}

/** Compile a `*`-glob to an anchored RegExp: escape every regex metachar, then `\*` → `.*`. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
	return new RegExp(`^${escaped}$`)
}
