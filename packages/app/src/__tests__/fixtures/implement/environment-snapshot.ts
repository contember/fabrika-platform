// A dependency that copies the environment while its module initialises, as a configuration library does. It is
// imported only by `snapshot-app.ts`, so it initialises when `serveContract` loads that application.

export const snapshot: Readonly<Record<string, string | undefined>> = { ...process.env }
