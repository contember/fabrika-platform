export const invitations = { 'api.workspaces.cancel': ['invitationId'] }
export const links = { 'api.notes.unshare': ['linkId'] }
export const rows = {
	'api.notes.editComment': { commentId: 'note_comments' },
	'api.notes.lookUp': { noteId: 'notes' },
	'api.notes.thread': { rootId: 'notes' },
	'api.notes.relate#source': { noteId: 'notes' },
	'api.notes.relate#target': { intoId: 'workspaces' },
}
export const appRows = {
	'api.notes.notice': { notices: { slug: 'welcome', published: true } },
	'shared.notice': { notices: { slug: 'welcome', published: true } },
}
