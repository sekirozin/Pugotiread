import test from 'node:test';
import assert from 'node:assert/strict';
import {isRpgSheetFolder,rpgSheetCopyFolder} from '../src/shared/rpg-folders.js';

test('canonical Fichas folder is recognized independently of PDF names',()=>{
  for(const folder of ['Tormenta RPG/Fichas','Daemon/fichas','Avatar Legends\\Fichas','RPG/Fichas/Personagens'])assert.equal(isRpgSheetFolder(folder),true);
  for(const folder of ['Tormenta RPG','Fichas Tormenta','Ficha','Regras de fichas'])assert.equal(isRpgSheetFolder(folder),false);
});
test('new sheets go to the system Fichas folder without nesting Fichas twice',()=>{
  assert.equal(rpgSheetCopyFolder('Tormenta RPG/Modelo.pdf'),'Tormenta RPG/Fichas');
  assert.equal(rpgSheetCopyFolder('Tormenta RPG/Fichas/Mephisto.pdf'),'Tormenta RPG/Fichas');
  assert.equal(rpgSheetCopyFolder('Tormenta RPG/Aventuras/Modelo.pdf'),'Tormenta RPG/Fichas');
  assert.equal(rpgSheetCopyFolder('Modelo.pdf'),'Fichas');
});
