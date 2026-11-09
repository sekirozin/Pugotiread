import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicationCompleted, validRating } from '../src/shared/work-metadata.js';
test('PugotiQA: finalizada exige status explícito, nunca progresso ou hiato', () => {
 for(const value of ['completed','Completo','concluído','FINALIZADA']) assert.equal(isPublicationCompleted(value),true);
 for(const value of [null,'hiato','hiatus','ongoing','Em andamento','cancelled','not completed','']) assert.equal(isPublicationCompleted(value),false);
});
test('PugotiQA: ranking e votos não são avaliações; notas válidas mantêm escala', () => {
 for(const value of ['60','357','16th, it has 23K monthly views','4.8 votes',{},'6/5']) assert.equal(validRating(value),null);
 assert.equal(validRating('4,8/5'),'4.8/5'); assert.equal(validRating(0),'0'); assert.equal(validRating('9.43'),'9.43');
});
