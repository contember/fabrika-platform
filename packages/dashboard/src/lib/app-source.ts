import { ApiError, type AppDto, type createControlClient } from './api'

/** What the source form holds: a branch name, and the worker directory where the provider reads one (else null). */
export interface SourceDraft {
	readonly defaultBranch: string
	readonly workerDir: string | null
}

export interface SourceChange {
	defaultBranch?: string
	workerDir?: string
}

const hasUnsafeChars = (value: string): boolean =>
	/\s/.test(value) || [...value].some((char) => {
		const code = char.codePointAt(0) ?? 0
		return code < 0x20 || code === 0x7f
	})

/**
 * The worker directory as a Cloudflare deploy reads it: relative to the checkout, `''` for its root, `null` for a value
 * it refuses (absolute, climbing out with `..`, or holding whitespace or a control character). It mirrors the provider's
 * `checkoutRelativeDirectory` and the runner job's path check, which the console cannot import.
 */
export function workerDirPath(value: string | null): string | null {
	const raw = value ?? ''
	if (raw.startsWith('/') || hasUnsafeChars(raw)) return null
	const segments = raw.split('/')
	if (segments.includes('..')) return null
	return segments.filter((segment) => segment !== '' && segment !== '.').join('/')
}

/**
 * The fields the form changes, `null` when it changes none, or why it cannot be sent. Only changed fields are sent,
 * because each one decides what a deploy runs, and on an application with a protected environment only a person may
 * change it.
 */
export function sourceChange(app: AppDto, draft: SourceDraft): { readonly change: SourceChange | null } | { readonly problem: string } {
	const branch = draft.defaultBranch.trim()
	if (branch === '') return { problem: 'Name the default branch.' }
	if (/\s/.test(branch)) return { problem: 'A branch name has no whitespace.' }
	if (branch.startsWith('refs/')) return { problem: 'Name the branch alone, without refs/heads/.' }
	const change: SourceChange = branch === app.defaultBranch ? {} : { defaultBranch: branch }
	if (draft.workerDir !== null) {
		const path = workerDirPath(draft.workerDir.trim())
		if (path === null) {
			return { problem: 'The worker directory is a path inside the repository: relative, without "..", spaces or control characters.' }
		}
		// The checkout's root is sent as `.`: Control keeps the stored value for a null, and a deploy reads `.` as the root.
		if (path !== workerDirPath(app.workerDir)) change.workerDir = path === '' ? '.' : path
	}
	return { change: Object.keys(change).length === 0 ? null : change }
}

export type SourceOutcome = { readonly kind: 'unchanged' } | { readonly kind: 'saved' } | { readonly kind: 'refused'; readonly message: string }

/** Checks the draft, sends what changed through `save`, and says what the form shows next. */
export async function submitSource(app: AppDto, draft: SourceDraft, save: (change: SourceChange) => Promise<unknown>): Promise<SourceOutcome> {
	const result = sourceChange(app, draft)
	if ('problem' in result) return { kind: 'refused', message: result.problem }
	if (result.change === null) return { kind: 'unchanged' }
	try {
		await save(result.change)
		return { kind: 'saved' }
	} catch (cause) {
		return { kind: 'refused', message: cause instanceof ApiError ? cause.message : 'Save failed.' }
	}
}

export function saveSource(client: ReturnType<typeof createControlClient>, appId: string, change: SourceChange): Promise<AppDto> {
	return client.apps.update({ appId, app: change })
}
