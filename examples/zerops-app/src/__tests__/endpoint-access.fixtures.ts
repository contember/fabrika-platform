// The state the generated endpoint access tests seed: only a note in the trash is restored, and an attachment is a row
// of the note the case reaches.
export const seeds = { 'api.notes.restore': { trashed: true } }
export const rows = { 'api.attachments.download': { id: 'note_attachments' }, 'api.attachments.remove': { id: 'note_attachments' } }
