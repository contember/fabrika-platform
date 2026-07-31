import { ApiError } from '../lib/api'
import { Icon, type IconName } from './Icon'

interface RouteErrorProps {
	error: Error
}

/** Title + body for a route error, mapped by type — never echoing a raw server message. */
function describe(error: Error): { title: string; body: string; icon: IconName } {
	if (error instanceof ApiError) {
		if (error.httpStatus === 403) {
			return {
				title: "You don't have permission to view this",
				body: 'Your account is missing the permission this page requires. Ask a fabrika admin if you think this is wrong.',
				icon: 'lock',
			}
		}
		if (error.httpStatus === 404) {
			return {
				title: 'Not found',
				body: "The thing you're looking for doesn't exist, or was removed.",
				icon: 'search',
			}
		}
		if (error.httpStatus === 0) {
			return {
				title: 'Network error',
				body: "Couldn't reach the control plane. Check your connection and try again.",
				icon: 'globe',
			}
		}
	}
	return {
		title: 'Something went wrong',
		body: 'This page failed to load. Try again, and if it keeps happening, contact a fabrika admin.',
		icon: 'alert',
	}
}

/**
 * Styled fallback for loader/render failures, wired as the layout `<Outlet errorFallback>`. Maps the
 * error by type/status — it never renders the raw `error.message`, which can carry an internal server
 * string. A short status hint is shown for `ApiError`s for support. (401 / Access bounces are handled
 * inside the RPC client via a guarded SSO navigation, so they normally never reach here.)
 */
export function RouteError({ error }: RouteErrorProps) {
	const { title, body, icon } = describe(error)
	const status = error instanceof ApiError && error.httpStatus !== 0 ? error.httpStatus ?? null : null

	return (
		<div className="gate-screen">
			<p className="gate-glyph">
				<Icon name={icon} size={20} />
			</p>
			<h1>{title}</h1>
			<p>{body}</p>
			{status !== null && <p className="muted small">Status {status}</p>}
			<button type="button" onClick={() => location.reload()}>
				<Icon name="refresh" size={14} />
				Retry
			</button>
		</div>
	)
}
