// @fabrika/app/client — the typed client of a contract application, for its SPA and for scripts. Browser-safe.
// The language a page may leave for its proxy's next sign-in bounce (ADR-0077).
export { isLocale, type Locale, LOCALE_COOKIE, LOCALES } from '@fabrika/auth-core'
export { type PageCaller, parsePageCaller } from './caller'
export {
	type AttachmentProcedure,
	type CallOptions,
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
export { rememberSignInLocale } from './locale'
export { shareKey } from './share'
export { type BounceOption, RpcError, type RpcFetch } from './transport'
