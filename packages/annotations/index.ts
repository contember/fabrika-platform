export { AnnotationCtx, AnnotationHostContext, SessionContext, useAnnotationHost, useAnnotations } from '@fabrika/annotations/runtime'
export { extractContext, formatSnippetInContext } from './src/annotationContext'
export {
	ANNOTATABLE_SELECTOR,
	ANNOTATION_TARGETS,
	BLOCK_SELECTOR,
	describeSnippet,
	findAnnotationElement,
	findSnippetElement,
	getBlockSnippet,
	restoreAnnotationTargets,
} from './src/annotationDom'
export { AnnotationDraftFooter } from './src/AnnotationDraftFooter'
export type { AnnotationDraftFooterProps } from './src/AnnotationDraftFooter'
export { AnnotationEditor, AttachButton, ImageThumbnails, imageToUrl } from './src/AnnotationEditor'
export { AnnotationList } from './src/AnnotationList'
export type { AnnotationListProps } from './src/AnnotationList'
export { renderAnnotation } from './src/annotationMarkdown'
export type { RenderableAnnotation } from './src/annotationMarkdown'
export { AnnotationProvider } from './src/AnnotationProvider'
export type { AnnotationProviderProps } from './src/AnnotationProvider'
export { sealTarget } from './src/annotationTarget'
export type { AnnotationTarget, SealedAnnotationTarget, TargetAnnotation } from './src/annotationTarget'
export { blockTarget } from './src/blockTarget'
export type { BlockLocator } from './src/blockTarget'
export { renameMarkId, restoreMarks, setMarkActive, unwrapMarks, updateAllMarkStates, wrapRangeWithMark } from './src/highlightRange'
export { AnnotationCreatePopover, AnnotationEditPopover, AnnotationPopover, Popover } from './src/Popover'
export {
	createRegionOverlay,
	describeRegion,
	findRegionHost,
	isDrawableRegion,
	REGION_HOST_ATTR,
	REGION_UNITS,
	regionBetween,
	regionPointIn,
	regionStyle,
	regionTarget,
} from './src/regionTarget'
export type { RegionBox, RegionLocator, RegionPoint, RegionShape } from './src/regionTarget'
export type {
	Annotation,
	AnnotationAttachment,
	AnnotationAuthor,
	AnnotationContext,
	AnnotationContextValue,
	AnnotationHost,
	AnnotationState,
} from './src/runtime'
export { textTarget } from './src/textTarget'
export type { TextLocator } from './src/textTarget'
export { useAnnotationState } from './src/useAnnotationState'
export { useRegionAnnotation } from './src/useRegionAnnotation'
export { useTextAnnotation } from './src/useTextAnnotation'
export { autoResizeTextarea, fileAnnotationPath, generateAnnotationId, hostAcceptsUploads, RESPONSE_ANNOTATION_PATH } from './src/utils'
