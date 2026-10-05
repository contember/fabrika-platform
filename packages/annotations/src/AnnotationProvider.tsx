import { AnnotationCtx, SessionContext, useAnnotationHost } from '@fabrika/annotations/runtime'
import React, { useEffect, useRef, useState } from 'react'
import type { Annotation, AnnotationState } from './runtime'
import { annotationStateSchema } from './schemas'
import { useAnnotationState } from './useAnnotationState'

export { useAnnotations } from '@fabrika/annotations/runtime'
export type { Annotation, AnnotationContext, AnnotationContextValue, AnnotationState } from './runtime'

export interface AnnotationProviderProps {
	scope: string
	isReadOnly?: boolean
	remoteAnnotations?: Annotation[]
	loadState: (scope: string) => Promise<AnnotationState | null>
	saveState: (scope: string, state: AnnotationState) => void
	children: React.ReactNode
}

export function AnnotationProvider(props: AnnotationProviderProps) {
	return <AnnotationDraft key={props.scope} {...props} />
}

function AnnotationDraft({ scope, isReadOnly = false, remoteAnnotations, loadState, saveState, children }: AnnotationProviderProps) {
	const host = useAnnotationHost()
	const [annotations, setAnnotations] = useState<Annotation[]>([])
	const [generalNote, setGeneralNote] = useState('')
	const [hydrated, setHydrated] = useState(false)
	const savedState = useRef<AnnotationState | null>(null)
	const value = useAnnotationState({
		annotations,
		setAnnotations,
		generalNote,
		setGeneralNote,
		remoteAnnotations,
		isReadOnly,
		onClear: () => saveState(scope, { annotations: [], generalNote: '' }),
	})

	useEffect(() => {
		let cancelled = false
		setHydrated(false)
		loadState(scope).then((saved) => {
			if (cancelled) return
			const result = annotationStateSchema.safeParse(saved)
			savedState.current = result.success ? result.data : null
			setAnnotations(result.success ? result.data.annotations : [])
			setGeneralNote(result.success ? result.data.generalNote : '')
			setHydrated(true)
		})
		return () => {
			cancelled = true
		}
	}, [scope, loadState])

	useEffect(() => {
		if (!hydrated || isReadOnly) return
		const timer = setTimeout(() => saveState(scope, { ...savedState.current, annotations, generalNote }), 300)
		return () => clearTimeout(timer)
	}, [scope, annotations, generalNote, hydrated, isReadOnly, saveState])

	return (
		<SessionContext.Provider value={host.sessionId}>
			<AnnotationCtx.Provider value={value}>{children}</AnnotationCtx.Provider>
		</SessionContext.Provider>
	)
}
