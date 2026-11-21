/**
 * What a daemon's browser UI does when its socket drops: it asks the daemon again (`probe`), and reloads when the daemon
 * answers 401, so the browser shows the daemon's page that names the command for a fresh link; otherwise it reconnects.
 * Free of DOM and Node types, so a UI bundle imports it without the daemon's runtime.
 */
export function reconnectOrReload(probe: () => Promise<Response>, reconnect: () => void, reload: () => void): void {
	probe().then(
		(response) => {
			if (response.status === 401) reload()
			else reconnect()
		},
		() => reconnect(),
	)
}
