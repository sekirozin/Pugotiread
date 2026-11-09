import test from "node:test";
import assert from "node:assert/strict";
import { findWords, indexText } from "../src/UI/Web/pdf-text-search.js";
import { outlinePage, type OutlineDocument } from "../src/UI/Web/pdf-outline.js";

test("partial queries expand every matching Unicode word, ignoring case", () => {
  const text = "Antes Desenvolvimento, desenvolvida e DeSeNtErRadO; desengajar.";
  assert.deepEqual(findWords(text, "dEsEn").map(m => text.slice(m.start, m.end)),
    ["Desenvolvimento", "desenvolvida", "DeSeNtErRadO", "desengajar"]);
  assert.equal(findWords(text, "xyz").length, 0);
  assert.equal(findWords(text, "").length, 0);
});
test("normalization preserves accent, combining mark, ligature and soft hyphen offsets", () => {
  for (const [text, query] of [["ação", "acao"], ["ação", "acao"], ["oﬃce", "off"], ["desen\u00advolvimento", "desenvol"]]) {
    assert.deepEqual(findWords(text, query), [{ start: 0, end: text.length }]);
  }
});
test("split text items join within words but stop at spaces and line boundaries", () => {
  const {text} = indexText([{str:"Desen"},{str:"volvimento"},{str:" "},{str:"desen",hasEOL:true},{str:"outra linha"}]);
  assert.deepEqual(findWords(text,"desen").map(m=>text.slice(m.start,m.end)),["Desenvolvimento","desen"]);
  assert.equal(findWords("banana", "an").length, 1);
});
test("visual gaps without text spaces also delimit words", () => {
  const {text} = indexText([{str:"Desen",transform:[12,0,0,12,50,700],width:32},
    {str:"volvida",transform:[12,0,0,12,82,700],width:40},
    {str:"outra",transform:[12,0,0,12,130,700],width:30}]);
  assert.equal(text, "Desenvolvida\noutra");
});
test("outline resolves named, referenced and zero-based integer destinations", async () => {
  const doc: OutlineDocument = {numPages:10,getOutline:async()=>null,
    getDestination:async name=>name==='chapter'?[{num:9,gen:0},{name:'Fit'}]:null,
    getPageIndex:async ref=>{assert.deepEqual(ref,{num:9,gen:0});return 4;}};
  assert.equal(await outlinePage(doc,'chapter'),5);
  assert.equal(await outlinePage(doc,[{num:9,gen:0},{name:'FitH'},50]),5);
  assert.equal(await outlinePage(doc,[0,{name:'Fit'}]),1);
  await assert.rejects(outlinePage(doc,'missing'));
  await assert.rejects(outlinePage(doc,[99,{name:'Fit'}]));
});
