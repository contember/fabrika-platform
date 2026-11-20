// @fabrika/app/client — the typed client of a contract application, for its SPA and for scripts. Browser-safe.
// `LOCALE_COOKIE` names the language a page may leave for its proxy's next sign-in bounce (ADR-0077).
export { type Locale, LOCALE_COOKIE } from '@fabrika/auth-core'
export { type PageCaller, parsePageCaller } from './caller'
export {
	type AttachmentProcedure,
	challengeUrl,
	type ClientMount,
	type ClientOptions,
	type ClientTree,
	type ContractClient,
	createClient,
	download,
	DownloadedFile,
	type DownloadInput,
	type FileProcedure,
	type InputOf,
	type LinkClientOptions,
	type ProcedureCall,
	type ResultOf,
} from './contract'
export { shareKey } from './share'
export { type BounceOption, RpcError, type RpcFetch } from './transport'
