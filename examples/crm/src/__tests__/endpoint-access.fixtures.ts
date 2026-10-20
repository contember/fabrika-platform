// The state the generated endpoint access tests seed: a closed deal does not move, and only a closed deal reopens. A
// picked person is a member of the object's org; an attachment is a row of the deal the case reaches.
export const seeds = { 'api.deals.move': { stage: 'lead' }, 'api.deals.reopen': { stage: 'won' } }
export const members = { 'api.deals.assign': ['newOwner'], 'api.tasks.create': ['assignee'] }
export const rows = { 'api.attachments.download': { id: 'deal_attachments' }, 'api.attachments.remove': { id: 'deal_attachments' } }
