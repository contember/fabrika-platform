// @fabrika/app/react — the paved road's data layer of an SPA: a provider over the typed clients, query and mutation
// hooks typed from the contract, one error union, and the caller document. Browser-safe; React is a peer dependency.
export { type Caller, callerOf, type CallerScope, Can, type CanProps, useCaller } from './caller'
export { type FabrikaError, type FabrikaErrorKind, fieldError, toFabrikaError } from './errors'
export {
	type DownloadArgument,
	type InfiniteQueryOptions,
	type InfiniteQueryState,
	type MutationOptions,
	type MutationResult,
	type MutationState,
	type QueryOptions,
	type QueryState,
	skip,
	useAction,
	useDownload,
	useInfiniteQuery,
	useInvalidate,
	useMutation,
	useQuery,
} from './hooks'
export { FabrikaProvider, type FabrikaProviderProps } from './provider'
export type {
	ClientGroup,
	ClientProcedure,
	InputArgument,
	InvalidateTarget,
	PageAnswer,
	PagedProcedure,
	PageInput,
	ProcedureInput,
	ProcedureResult,
	TypedProcedure,
} from './types'
