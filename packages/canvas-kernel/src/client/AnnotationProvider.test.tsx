import { type AnnotationContextValue, useAnnotations } from '#canvas/runtime'
import { useAnnotationHost, useAnnotations as useSurfaceAnnotations } from '@fabrika/annotations/runtime'
import { mountContainer } from '@fabrika/annotations/testing/dom.ts'
import { afterEach, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { annotationDraftKey } from './annotationDraft'
import { AnnotationProvider, type PersistedState } from './AnnotationProvider'
import { CanvasHostContext, localCanvasHost } from './hostContext'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
	await act(async () => root?.unmount())
	root = undefined
})

test('annotation runtime is the sole owner of annotation and session contexts', async () => {
	const surface = await import('@fabrika/annotations')
	const runtime = await import('@fabrika/annotations/runtime')
	const canvas = await import('#canvas/runtime')
	expect(surface.AnnotationCtx).toBe(runtime.AnnotationCtx)
	expect(surface.AnnotationHostContext).toBe(runtime.AnnotationHostContext)
	expect(surface.SessionContext).toBe(runtime.SessionContext)
	expect(canvas.SessionContext).toBe(runtime.SessionContext)
	expect(canvas.AnnotationCtx).not.toBe(runtime.AnnotationCtx)
})

test('local draft hydration recovers valid entries and persists extensions without changing annotation ids', async () => {
	const key = annotationDraftKey('recovery', 1)
	const annotation = { id: 'stable-id', snippet: 'text', note: 'keep me', createdAt: 'old', extension: { anchor: 'stable' } }
	localStorage.setItem(
		key,
		JSON.stringify({
			annotations: [null, annotation],
			generalNote: 'draft',
			responses: [['invalid', {}]],
			hostExtension: 'retained',
		}),
	)
	let canvas: AnnotationContextValue | undefined
	function Probe() {
		canvas = useAnnotations()
		return null
	}
	root = createRoot(mountContainer(''))
	await act(async () =>
		root?.render(
			<AnnotationProvider sessionId="recovery" revision={1} isReadOnly={false} draftPhase="current">
				<Probe />
			</AnnotationProvider>,
		)
	)
	expect(canvas?.annotations).toEqual([{ ...annotation, source: 'local' }])
	expect(canvas?.responses.size).toBe(0)
	await act(async () => {
		await Bun.sleep(350)
	})
	const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
	expect(stored).toMatchObject({ hostExtension: 'retained', annotations: [{ ...annotation, source: 'local' }] })
	localStorage.removeItem(key)
})

test('canvas controls and annotation surface share state but not canvas responsibilities', async () => {
	let canvas: AnnotationContextValue | undefined
	const writes: PersistedState[] = []
	const host = { ...localCanvasHost, sessionId: 'bridge', uploadUrl: () => '/upload' }
	function Probe() {
		canvas = useAnnotations()
		const surface = useSurfaceAnnotations()
		expect(surface.annotations).toBe(canvas.annotations)
		expect(surface.updateAnnotation).toBe(canvas.updateAnnotation)
		expect(useAnnotationHost()).toBe(host)
		expect('responses' in surface).toBe(false)
		return null
	}
	root = createRoot(mountContainer(''))
	await act(async () =>
		root?.render(
			<CanvasHostContext.Provider value={host}>
				<AnnotationProvider
					sessionId="bridge"
					revision={1}
					isReadOnly={false}
					draftPhase="current"
					canvasFiles={['plan.jsx']}
					loadState={async () => ({
						annotations: [],
						generalNote: '',
						responses: [['old', { id: 'old', type: 'text', label: 'Old', value: 'previous' }]],
					})}
					saveState={(_session, _revision, state) => writes.push(state)}
				>
					<Probe />
				</AnnotationProvider>
			</CanvasHostContext.Provider>,
		)
	)
	expect(canvas?.submittableResponses.has('old')).toBe(true)
	await act(async () => {
		canvas?.addAnnotationWithId('note', 'text', 'comment')
		canvas?.setResponse('new', { id: 'new', type: 'text', label: 'New', value: 'answer' })
		canvas?.registerResponse('new')
		canvas?.registerCanvasRendered('plan.jsx')
	})
	expect(canvas?.submittableResponses.has('old')).toBe(false)
	expect(canvas?.submittableResponses.has('new')).toBe(true)
	await act(async () => {
		await Bun.sleep(350)
	})
	expect(writes.at(-1)?.annotations[0]?.note).toBe('comment')
	expect(writes.at(-1)?.responses.map(([id]) => id)).toEqual(['old', 'new'])
	await act(async () => canvas?.clearAll())
	expect(canvas?.responses.size).toBe(0)
	expect(canvas?.annotations).toEqual([])
	expect(writes.at(-1)).toEqual({ annotations: [], generalNote: '', responses: [], feedbackEntries: [] })
})
