import { mountContainer } from '@fabrika/annotations/testing/dom.ts'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BuilderPlatformStatus } from '../../shared'
import { DeploymentPanel } from '../src/components/DeploymentPanel'
import { BuildPreview } from '../src/components/PreviewPane'
import { platformClient, PlatformClientError } from '../src/lib/platformClient'
import { usePlatform } from '../src/lib/usePlatform'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true })

const status: BuilderPlatformStatus = {
	sessionId: 'project',
	projectRoot: '/workspace/project',
	connection: null,
	credential: { available: false, expiresAt: null },
	pairing: null,
	previewUrl: null,
	deployment: null,
}
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
	await act(async () => root?.unmount())
	root = undefined
})

test('fixture controls cannot mutate or fetch platform data', async () => {
	const request = spyOn(platformClient, 'status')
	function Fixture() {
		return <DeploymentPanel platform={usePlatform('project', false)} live={false} />
	}
	const container = mountContainer('')
	root = createRoot(container)
	await act(async () => root?.render(<Fixture />))
	expect([...container.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
	expect(request).not.toHaveBeenCalled()
	request.mockRestore()
})

test('unset preview has no iframe; configured non-default URL is used exactly', () => {
	expect(renderToStaticMarkup(<BuildPreview previewUrl={null} />)).not.toContain('<iframe')
	const html = renderToStaticMarkup(<BuildPreview previewUrl="http://localhost:4321/app" />)
	expect(html).toContain('src="http://localhost:4321/app"')
	expect(html).not.toContain('5173')
})

test('pending approval proof occurs only in the consent link href', () => {
	const authorizationUrl = 'https://console.example.com/builder/connect#attempt=example&approval=private-proof&expires=9999999999'
	const html = renderToStaticMarkup(
		<DeploymentPanel
			live
			platform={{
				data: { ...status, pairing: { status: 'pending', authorizationUrl, expiresAt: 9999999999 } },
				enabled: true,
				busy: false,
				error: null,
				refresh: () => {},
				act: async () => {},
			}}
		/>,
	)
	const container = mountContainer(html)
	expect(container.querySelector('a')?.getAttribute('href')).toBe(authorizationUrl)
	expect(container.textContent).not.toContain('private-proof')
	expect(html.match(/private-proof/g)).toHaveLength(1)
})

test('unmount aborts an in-flight status request', async () => {
	let signal: AbortSignal | undefined
	const request = spyOn(platformClient, 'status').mockImplementation((_id, currentSignal) => {
		signal = currentSignal
		return new Promise(() => {})
	})
	function Live() {
		return <DeploymentPanel platform={usePlatform('project', true)} live />
	}
	root = createRoot(mountContainer(''))
	try {
		await act(async () => root?.render(<Live />))
		expect(signal?.aborted).toBe(false)
		await act(async () => root?.unmount())
		root = undefined
		expect(signal?.aborted).toBe(true)
	} finally {
		request.mockRestore()
	}
})

test('poll failure disables mutations and stops requests until explicit refresh', async () => {
	const request = spyOn(platformClient, 'status').mockResolvedValueOnce(status).mockRejectedValue(
		new PlatformClientError('Local builder unavailable.'),
	)
	function Live() {
		return <DeploymentPanel platform={usePlatform('project', true)} live />
	}
	const container = mountContainer('')
	root = createRoot(container)
	try {
		await act(async () => root?.render(<Live />))
		expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
		await act(async () => {
			await Bun.sleep(3100)
		})
		expect(container.querySelector('[role="alert"]')?.textContent).toBe('Local builder unavailable.')
		expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
		await act(async () => {
			await Bun.sleep(3100)
		})
		expect(request).toHaveBeenCalledTimes(2)
	} finally {
		request.mockRestore()
	}
}, 10000)

function ProjectPlatform({ sessionId }: { sessionId: string }) {
	const platform = usePlatform(sessionId, true)
	return (
		<>
			<output>{platform.data?.sessionId ?? 'loading'}</output>
			{platform.error && <p role="alert">{platform.error}</p>}
			<button type="button" disabled={!platform.enabled} aria-busy={platform.busy} onClick={() => void platform.act({ kind: 'disconnect' })}>
				Disconnect
			</button>
		</>
	)
}

test('switching project aborts a mutation and ignores its late completion without blocking the new project', async () => {
	const first = Promise.withResolvers<BuilderPlatformStatus>()
	const second = Promise.withResolvers<BuilderPlatformStatus>()
	let firstSignal: AbortSignal | undefined
	const request = spyOn(platformClient, 'status').mockImplementation(async (sessionId) => ({ ...status, sessionId }))
	const mutation = spyOn(platformClient, 'act').mockImplementation((sessionId, _action, signal) => {
		if (sessionId === 'projectone') {
			firstSignal = signal
			return first.promise
		}
		return second.promise
	})
	const container = mountContainer('')
	root = createRoot(container)
	try {
		await act(async () => root?.render(<ProjectPlatform sessionId="projectone" />))
		await act(async () => container.querySelector('button')?.click())
		expect(container.querySelector('button')?.getAttribute('aria-busy')).toBe('true')
		await act(async () => root?.render(<ProjectPlatform sessionId="projecttwo" />))
		expect(firstSignal?.aborted).toBe(true)
		expect(container.querySelector('output')?.textContent).toBe('projecttwo')
		expect(container.querySelector('button')?.disabled).toBe(false)
		await act(async () => container.querySelector('button')?.click())
		await act(async () => first.resolve({ ...status, sessionId: 'projectone' }))
		expect(container.querySelector('output')?.textContent).toBe('projecttwo')
		expect(container.querySelector('button')?.getAttribute('aria-busy')).toBe('true')
		await act(async () => second.resolve({ ...status, sessionId: 'projecttwo' }))
		expect(container.querySelector('button')?.disabled).toBe(false)
		expect(container.querySelector('button')?.getAttribute('aria-busy')).toBe('false')
		expect(mutation).toHaveBeenCalledTimes(2)
	} finally {
		request.mockRestore()
		mutation.mockRestore()
	}
})

test('switching project clears a previous polling error and loads the new project', async () => {
	const request = spyOn(platformClient, 'status').mockImplementation(async (sessionId) => {
		if (sessionId === 'projectone') throw new PlatformClientError('Project one unavailable.')
		return { ...status, sessionId }
	})
	const container = mountContainer('')
	root = createRoot(container)
	try {
		await act(async () => root?.render(<ProjectPlatform sessionId="projectone" />))
		expect(container.querySelector('[role="alert"]')?.textContent).toBe('Project one unavailable.')
		expect(container.querySelector('button')?.disabled).toBe(true)
		await act(async () => root?.render(<ProjectPlatform sessionId="projecttwo" />))
		expect(container.querySelector('[role="alert"]')).toBeNull()
		expect(container.querySelector('output')?.textContent).toBe('projecttwo')
		expect(container.querySelector('button')?.disabled).toBe(false)
	} finally {
		request.mockRestore()
	}
})
