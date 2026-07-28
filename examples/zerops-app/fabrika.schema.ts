// The app's authorization VOCABULARY, declared in code and reconciled into the IAM service by the
// deploy's last step (`reconcile-schema` — the one step the Cloudflare and Zerops plans share, because
// it talks to fabrika's own IAM service rather than to a cloud).
//
// The first reconcile is what REGISTERS the app with IAM. Afterwards it is idempotent: it upserts the
// app's scopes/actions/`origin='app'` roles, deletes app-origin rows that were removed, and never
// touches the `origin='custom'` policies an admin composed in the admin UI.
//
// Keep these true or a push 400s (the admin endpoint validates them with core's `isActionAllowed`):
//   - every role permission is `*`, an exact catalog action, or a `prefix.*` whose prefix covers at
//     least one catalog action;
//   - a scope `type` is a dimension the app's own code passes to `can(action, { type, value })`.

import type { AppSchema } from '@fabrika/auth-core'

/**
 * The app id. It is the primary key in three places at once, and they must agree: the control plane's
 * registry, the minted token's `aud`, and the `?app=` pin in the proxy's generated Caddy route. Get it
 * wrong and the proxy asks IAM for a token for an app the request is not for.
 */
export const NOTES_APP_ID = 'notes'

export const notesSchema: AppSchema = {
	// One scope dimension. Values are opaque app-owned ids — IAM stores and matches them, never
	// interprets them.
	scopes: [{ type: 'workspace', label: 'Workspace' }],

	// The actions the app actually checks. Every `can()` call in `src/` names one of these.
	actions: [
		{ action: 'notes.read', description: 'Read notes' },
		{ action: 'notes.write', description: 'Create and edit notes' },
		{ action: 'notes.delete', description: 'Delete notes' },
		{ action: 'notes.settings.update', description: 'Change workspace settings' },
	],

	// `origin='app'` roles — the bundles the app ships. An admin may layer custom policies on top.
	roles: {
		reader: { name: 'Reader', description: 'Read-only', permissions: ['notes.read'] },
		author: { name: 'Author', description: 'Read and write notes', permissions: ['notes.read', 'notes.write'] },
		// `notes.*` covers every action in the namespace, including ones added later — which is the point
		// of a prefix wildcard, and also the reason to use it sparingly.
		admin: { name: 'Admin', description: 'Full access', permissions: ['notes.*'] },
	},
}
