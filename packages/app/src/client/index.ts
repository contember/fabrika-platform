// @fabrika/app/client — the typed client of a contract application, for its SPA and for scripts. Browser-safe.
export { type PageCaller, parsePageCaller } from './caller'
export {
	type AttachmentProcedure,
	type ClientMount,
	type ClientOptions,
	type ClientTree,
	type ContractClient,
	createClient,
	download,
	type DownloadInput,
	type LinkClientOptions,
	type ProcedureCall,
} from './contract'
export { shareKey } from './share'
export { type BounceOption, RpcError, type RpcFetch } from './transport'
