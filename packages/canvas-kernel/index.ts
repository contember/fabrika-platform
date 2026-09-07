export { compileJsx, compilePlan, KERNEL_COMPONENTS } from './src/engine/compiler'
export type { CanvasComponents, CanvasComponentSpec, CompileOptions, CompileResult } from './src/engine/compiler'
export { createCanvasPaths } from './src/engine/paths'
export type { CanvasPaths, CanvasPathsConfig } from './src/engine/paths'
export { SessionManager } from './src/engine/session'
export type {
	CanvasFileInfo,
	CanvasScope,
	DiffStats,
	RemoteAnnotation,
	RemoteFeedbackEntry,
	RevisionInfo,
	SecretResolution,
	SessionData,
	ShareEntry,
} from './src/engine/session'
export { unwatchAll, unwatchSession, watchSession } from './src/engine/watcher'
export type { WatchOptions } from './src/engine/watcher'
export { createWebSocketManager } from './src/engine/websocket'
export type { CanvasSocket, WebSocketManagerOptions, WSData } from './src/engine/websocket'
