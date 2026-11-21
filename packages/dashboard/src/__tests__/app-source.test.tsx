// The Build config section edits an application's default branch and worker directory: only the changed fields reach
// `apps.update`, and Control's refusal (a protected environment takes a person) is shown as it is.

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SourceFields } from '../components/app-detail/BuildConfigSection'
import { ApiError, type AppDto, type ConsoleAccessDto, type ControlFetch, createControlClient } from '../lib/api'
import { saveSource, type SourceChange, sourceChange, submitSource } from '../lib/app-source'
import { ConsoleAccessContext } from '../lib/console-caller'

const app = (overrides: Partial<AppDto> = {}): AppDto => ({
	id: 'notes',
	repoUrl: 'github.com/acme/notes',
	defaultBranch: 'feat/launch',
	workerDir: null,
	buildCmd: null,
	configPath: null,
	githubInstallationId: null,
	createdAt: 0,
	...overrides,
})

const holding = (global: string[], scope?: { type: 'app' | 'environment'; value: string; actions: string[] }): ConsoleAccessDto => ({
	principal: null,
	global,
	scopes: scope === undefined ? [] : [scope],
})

const fields = (access: ConsoleAccessDto | null, readsWorkerDir = true, subject = app()): string =>
	renderToStaticMarkup(
		<ConsoleAccessContext.Provider value={access}>
			<SourceFields app={subject} readsWorkerDir={readsWorkerDir} onDone={() => undefined} />
		</ConsoleAccessContext.Provider>,
	)

describe('the source fields of an application', () => {
	test('a caller holding app.manage globally or at the app may edit them', () => {
		expect(fields(holding(['app.manage']))).toContain('Edit source</button>')
		expect(fields(holding([], { type: 'app', value: 'notes', actions: ['app.manage'] }))).toContain('Edit source</button>')
	})

	test('a caller holding it at another app or only at an environment may not, as Control checks the app scope', () => {
		expect(fields(holding([], { type: 'app', value: 'other', actions: ['app.manage'] }))).not.toContain('Edit source</button>')
		expect(fields(holding([], { type: 'environment', value: 'prod', actions: ['app.manage'] }))).not.toContain('Edit source</button>')
		expect(fields(holding(['deploy.trigger']))).not.toContain('Edit source</button>')
	})

	test('the worker directory shows only where the provider deploys from one, its root by name', () => {
		expect(fields(holding(['app.manage']))).toContain('repository root')
		expect(fields(holding(['app.manage']), true, app({ workerDir: './fabrika/' }))).toContain('<code>fabrika</code>')
		expect(fields(holding(['app.manage']), false)).not.toContain('Worker dir')
		expect(fields(holding(['app.manage']), true, app({ workerDir: '/srv/app' }))).toContain('not a path inside the repository')
	})
})

describe('what the form sends', () => {
	test('a new default branch is the only field sent', () => {
		expect(sourceChange(app(), { defaultBranch: ' main ', workerDir: '' })).toEqual({ change: { defaultBranch: 'main' } })
	})

	test('an unchanged form sends nothing, however the worker directory is spelled', () => {
		expect(sourceChange(app(), { defaultBranch: 'feat/launch', workerDir: null })).toEqual({ change: null })
		expect(sourceChange(app({ workerDir: 'fabrika' }), { defaultBranch: 'feat/launch', workerDir: './fabrika/' })).toEqual({ change: null })
		expect(sourceChange(app({ workerDir: '.' }), { defaultBranch: 'feat/launch', workerDir: '' })).toEqual({ change: null })
	})

	test('a worker directory is sent normalized, and its root as `.`', () => {
		expect(sourceChange(app(), { defaultBranch: 'feat/launch', workerDir: 'apps/web/' })).toEqual({ change: { workerDir: 'apps/web' } })
		expect(sourceChange(app({ workerDir: 'fabrika' }), { defaultBranch: 'feat/launch', workerDir: '' })).toEqual({ change: { workerDir: '.' } })
	})

	test('a value no deploy could use is refused before anything is sent', () => {
		expect(sourceChange(app(), { defaultBranch: '  ', workerDir: null })).toEqual({ problem: 'Name the default branch.' })
		expect(sourceChange(app(), { defaultBranch: 'my branch', workerDir: null })).toEqual({ problem: 'A branch name has no whitespace.' })
		expect(sourceChange(app(), { defaultBranch: 'refs/heads/main', workerDir: null })).toEqual({
			problem: 'Name the branch alone, without refs/heads/.',
		})
		expect(sourceChange(app(), { defaultBranch: 'main', workerDir: '../other' })).toHaveProperty('problem')
		expect(sourceChange(app(), { defaultBranch: 'main', workerDir: '/abs' })).toHaveProperty('problem')
		expect(sourceChange(app(), { defaultBranch: 'main', workerDir: 'my app' })).toHaveProperty('problem')
		expect(sourceChange(app(), { defaultBranch: 'main', workerDir: 'app\tdir' })).toHaveProperty('problem')
	})

	test('saving calls apps.update with the change alone', async () => {
		const calls: unknown[] = []
		const fetcher: ControlFetch = async (_input, init) => {
			if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
			calls.push(JSON.parse(init.body))
			return Response.json({ result: app({ defaultBranch: 'main' }) })
		}
		const saved = await saveSource(createControlClient(fetcher), 'notes', { defaultBranch: 'main' })
		expect(saved.defaultBranch).toBe('main')
		expect(calls).toEqual([{ method: 'apps.update', input: { appId: 'notes', app: { defaultBranch: 'main' } } }])
	})

	test("Control's refusal rejects with its message, which the form shows", async () => {
		const message = "environment `prod` is protected: only a person changes its application's defaultBranch"
		const fetcher: ControlFetch = async () => Response.json({ error: { type: 'forbidden', message } }, { status: 403 })
		const refusal = saveSource(createControlClient(fetcher), 'notes', { defaultBranch: 'main' })
		await expect(refusal).rejects.toBeInstanceOf(ApiError)
		await expect(refusal).rejects.toThrow(message)
	})
})

describe('submitting the form', () => {
	const recorder = () => {
		const sent: SourceChange[] = []
		return { sent, save: async (change: SourceChange) => void sent.push(change) }
	}

	test('a changed field is saved and closes the form', async () => {
		const { sent, save } = recorder()
		expect(await submitSource(app({ workerDir: 'fabrika' }), { defaultBranch: 'main', workerDir: ' ./fabrika ' }, save)).toEqual({ kind: 'saved' })
		expect(sent).toEqual([{ defaultBranch: 'main' }])
	})

	test('an unchanged form closes without sending', async () => {
		const { sent, save } = recorder()
		expect(await submitSource(app(), { defaultBranch: 'feat/launch', workerDir: '' }, save)).toEqual({ kind: 'unchanged' })
		expect(sent).toEqual([])
	})

	test('an invalid value stays in the form with its reason, and nothing is sent', async () => {
		const { sent, save } = recorder()
		expect(await submitSource(app(), { defaultBranch: 'refs/heads/main', workerDir: null }, save)).toEqual({
			kind: 'refused',
			message: 'Name the branch alone, without refs/heads/.',
		})
		expect(sent).toEqual([])
	})

	test("Control's refusal is shown with its message, anything else as a failed save", async () => {
		const message = "environment `prod` is protected: only a person changes its application's defaultBranch"
		const refused: ControlFetch = async () => Response.json({ error: { type: 'forbidden', message } }, { status: 403 })
		const client = createControlClient(refused)
		expect(await submitSource(app(), { defaultBranch: 'main', workerDir: null }, (change) => saveSource(client, 'notes', change))).toEqual({
			kind: 'refused',
			message,
		})
		const broken = async () => {
			throw new TypeError('network down')
		}
		expect(await submitSource(app(), { defaultBranch: 'main', workerDir: null }, broken)).toEqual({ kind: 'refused', message: 'Save failed.' })
	})
})
