import type { AppDto, createControlClient } from './api'

/** What the source form holds: a branch name, and the worker directory where the provider reads one (else null). */
export interface SourceDraft {
	readonly defaultBranch: string
	readonly workerDir: string | null
}

export interface SourceChange {
	defaultBranch?: string
	workerDir?: string
}

/** The worker directory as a deploy reads it: relative to the checkout, `''` for its root. */
export function workerDirPath(value: string | null): string {
	return (value ?? '').split('/').filter((segment) => segment !== '' && segment !== '.').join('/')
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
		const dir = draft.workerDir.trim()
		if (dir.startsWith('/') || dir.split('/').includes('..')) {
			return { problem: 'The worker directory stays inside the repository: a relative path without "..".' }
		}
		const path = workerDirPath(dir)
		// The checkout's root is sent as `.`, which a deploy reads as the root, as it reads an unset worker directory.
		if (path !== workerDirPath(app.workerDir)) change.workerDir = path === '' ? '.' : path
	}
	return { change: Object.keys(change).length === 0 ? null : change }
}

export function saveSource(client: ReturnType<typeof createControlClient>, appId: string, change: SourceChange): Promise<AppDto> {
	return client.apps.update({ appId, app: change })
}
