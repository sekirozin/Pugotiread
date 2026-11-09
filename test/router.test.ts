import test from "node:test";
import assert from "node:assert/strict";
import { applyRouteToState, buildRoute, createRouter, parseRoute, viewPaths, type Route } from "../src/UI/Web/router.js";
import type { AppState } from "../src/UI/Web/state/types.js";

test("all real screens round trip, including public profiles and vault", () => {
  for (const [view, path] of Object.entries(viewPaths)) {
    const route = { kind: "view", view } as Route;
    assert.deepEqual(parseRoute(path), route);
    assert.equal(buildRoute(route), path);
  }
  for (const route of [
    { kind: "library", libraryId: "4" },
    { kind: "library", libraryId: "4", folder: "Tormenta RPG/Fichas" },
    { kind: "title", libraryId: "4", contentId: "152" },
    { kind: "reader", libraryId: "4", contentId: "152", page: 18 },
    { kind: "title", libraryId: "rpg", contentId: "rpg:Avatar Legends#1" },
    { kind: "person", userId: "user-2" }
  ] as Route[]) assert.deepEqual(parseRoute(buildRoute(route)), route);
  assert.equal(buildRoute({kind:"reader",libraryId:"4",contentId:"152",page:18}), "/biblioteca/4/titulo/152/ler?p=18");
});

test("invalid routes and IDs are rejected; page query is positive, safe and one-based", () => {
  assert.equal(parseRoute('/biblioteca/4?pasta=..%2FFichas').kind,'invalid');
  assert.throws(()=>buildRoute({kind:'library',libraryId:'4',folder:'../Fichas'}));
  for (const path of ["/unknown", "/bibliotecas/nova", "/biblioteca/4/config", "/biblioteca", "/biblioteca//titulo/1", "/biblioteca/%ZZ", "/biblioteca/4/titulo/%2F", "/biblioteca/4/titulo/%00", "/biblioteca/4/titulo/1/ler/extra"]) {
    assert.equal(parseRoute(path).kind, "invalid", path);
  }
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "abc"]) {
    assert.deepEqual(parseRoute(`/biblioteca/4/titulo/152/ler?p=${value}`), {kind:"reader",libraryId:"4",contentId:"152",page:1});
  }
  assert.equal(buildRoute({kind:"reader",libraryId:"4",contentId:"152",page:NaN}), "/biblioteca/4/titulo/152/ler?p=1");
  assert.throws(() => buildRoute({kind:"library",libraryId:"/"}));
  assert.deepEqual(parseRoute("/colecoes/"), {kind:"view",view:"collections"});
  for (const path of ["/reset-password/token", "/invite/token", "/api/auth/callback?code=secret", "/oauth/callback", "/auth/callback"]) assert.equal(parseRoute(path).kind, "external");
});

function mockBrowser(path = "/") {
  const browser = new EventTarget();
  const entries = [new URL(path, "https://read.test").href];
  const writes: string[] = [];
  const states: unknown[] = [null];
  let index = 0;
  const location = new URL(entries[0]);
  const history = {
    get state() { return states[index]; },
    back() { go(-1); },
    pushState(data: unknown, _unused: string, url: string) {
      writes.push("push"); entries.splice(++index); entries.push(new URL(url, location).href); location.href = entries[index];
      states.splice(index); states.push(data);
    },
    replaceState(data: unknown, _unused: string, url: string) {
      writes.push("replace"); entries[index] = new URL(url, location).href; location.href = entries[index];
      states[index] = data;
    }
  };
  Object.assign(browser, { location, history });
  const go = (delta: number) => { index += delta; location.href = entries[index]; browser.dispatchEvent(new Event("popstate")); };
  return { browser: browser as unknown as Window, entries, writes, go };
}

test("reader pages replace, Back/Forward restore without pushing, boot preserves deep link", async () => {
  const mock = mockBrowser();
  let state: Route | undefined;
  const router = createRouter(mock.browser, route => { state = route; });
  await router.start();
  await router.navigate({kind:"library",libraryId:"4"});
  await router.navigate({kind:"title",libraryId:"4",contentId:"152"});
  await router.navigate({kind:"reader",libraryId:"4",contentId:"152",page:1});
  for (let page = 2; page <= 50; page++) await router.replaceRoute({kind:"reader",libraryId:"4",contentId:"152",page}, false);
  assert.equal(mock.entries.length, 4);
  assert.equal(mock.writes.filter(w => w === "push").length, 3);
  assert.equal(new URL(mock.entries[3]).search, "?p=50");
  const writes = mock.writes.length;
  mock.go(-1); assert.equal(state?.kind, "title");
  mock.go(-1); assert.equal(state?.kind, "library");
  mock.go(-1); assert.deepEqual(state, {kind:"view",view:"home"});
  mock.go(1); mock.go(1); mock.go(1);
  assert.deepEqual(state, {kind:"reader",libraryId:"4",contentId:"152",page:50});
  assert.equal(mock.writes.length, writes);
  await router.navigate(state!); assert.equal(mock.entries.length, 4);
  router.backTo({kind:"title",libraryId:"4",contentId:"152"});
  assert.equal(state?.kind, "title");
  assert.equal(mock.writes.length, writes);
  router.dispose();
  const deep = mockBrowser("/biblioteca/4/titulo/152/ler?p=18");
  await createRouter(deep.browser, route => {state = route;}).start();
  assert.equal(deep.writes.length, 0);
  assert.deepEqual(state, {kind:"reader",libraryId:"4",contentId:"152",page:18});
});

test("direct reader opening inserts its title once; invalid routes replace safely; auth is untouched", async () => {
  const mock = mockBrowser();
  const router = createRouter(mock.browser, () => {});
  await router.navigate({kind:"reader",libraryId:"4",contentId:"152",page:8});
  assert.deepEqual(mock.entries.map(url => new URL(url).pathname), ["/", "/biblioteca/4/titulo/152", "/biblioteca/4/titulo/152/ler"]);
  const invalid = mockBrowser("/wrong");
  await createRouter(invalid.browser, route => assert.deepEqual(route, {kind:"view",view:"home"})).start();
  assert.deepEqual(invalid.writes, ["replace"]);
  const auth = mockBrowser("/invite/test");
  await createRouter(auth.browser, () => assert.fail("auth must not render app")).start();
  assert.equal(auth.writes.length, 0);
});

test("new navigation invalidates asynchronous route work and applies only screen state", async () => {
  const mock = mockBrowser();
  const pending: Array<() => void> = [];
  const rendered: Route[] = [];
  const router = createRouter(mock.browser, (route, context) => new Promise<void>(resolve => pending.push(() => {
    if (context.isCurrent()) rendered.push(route);
    resolve();
  })));
  const first = router.navigate({kind:"library",libraryId:"slow"});
  const second = router.navigate({kind:"view",view:"people"});
  pending[1](); pending[0](); await Promise.all([first, second]);
  assert.deepEqual(rendered, [{kind:"view",view:"people"}]);
  const state = { activeView:"home", reader:{}, activePeopleUserId:"old", search:"keep" } as AppState;
  applyRouteToState(state, {kind:"reader",libraryId:"4",contentId:"152",page:18});
  assert.equal(state.activeView, "library");
  assert.equal(state.activeLibraryId, "4");
  assert.equal(state.activeSeriesId, "152");
  assert.equal(state.reader, null); // content/defaults are resolved by the existing app reader.
  assert.equal(state.activePeopleUserId, null);
  applyRouteToState(state, {kind:"view",view:"home"});
  assert.equal(state.activeSeriesId, null);
  assert.equal(state.activeLibraryId, null);
});

test("startup library replaces root only once and preserves deep links and Back", async () => {
  const mock = mockBrowser();
  let current: Route | undefined;
  const router = createRouter(mock.browser, route => { current = route; });
  const initial: Route = { kind: "library", libraryId: "rpg" };
  await router.start(initial);
  assert.equal(mock.browser.location.pathname, "/biblioteca/rpg");
  assert.deepEqual(mock.writes, ["replace"]);
  await router.navigate({ kind: "view", view: "home" });
  await router.start(initial);
  assert.equal(mock.browser.location.pathname, "/");
  mock.go(-1);
  assert.deepEqual(current, initial);
  for (const path of ["/colecoes", "/biblioteca/4/titulo/152/ler?p=18", "/invite/token", "/?code=oauth"]) {
    const deep = mockBrowser(path);
    await createRouter(deep.browser, () => {}).start(initial);
    assert.notEqual(deep.browser.location.pathname, "/biblioteca/rpg");
  }
});
