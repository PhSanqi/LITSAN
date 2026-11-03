import assert from 'node:assert/strict';
import {conditionalStateCandidates} from '../scripts/memora-state.mjs';
const kinds=['preference','calendar','expense','goal','steps','project_proposal'];
const state=kinds.map(demandKind=>({demandKind,item:demandKind}));
for(const query of ['Where should I travel next?','What should I read next?','Which movie should I watch?','I\'m looking for a good book to read.','I am looking for something to watch.','Can you recommend a film?','Suggest a trip.']){
 assert.deepEqual(conditionalStateCandidates(state,query).map(r=>r.demandKind),['preference']);
}
for(const [query,kind] of [['What calendar events should I attend?','calendar'],['Which expense should I review?','expense'],['Which goal should I prioritize?','goal'],['How many steps?','steps'],['Write a project proposal with suggestions.','project_proposal']]){
 assert.deepEqual(conditionalStateCandidates(state,query).map(r=>r.demandKind),[kind]);
}
assert.equal(conditionalStateCandidates(state,'Where did I travel last year?'),state);
assert.equal(conditionalStateCandidates(state,'Which movie did I watch?'),state);
const noPreferences=state.filter(r=>r.demandKind!=='preference');
assert.equal(conditionalStateCandidates(noPreferences,'Where should I travel next?'),noPreferences);
console.log('15 recommendation intent and fallback checks passed');
