// The state the generated endpoint access tests seed: a closed deal does not move, and only a closed deal reopens. A
// picked person is a member of the object's org.
export const seeds = { 'api.deals.move': { stage: 'lead' }, 'api.deals.reopen': { stage: 'won' } }
export const members = { 'api.deals.assign': ['newOwner'], 'api.tasks.create': ['assignee'] }
