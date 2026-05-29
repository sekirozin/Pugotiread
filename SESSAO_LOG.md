# Sessão — 19/05/2026

## Objetivo Geral
Clonar os controles de leitura do Kavita para o Pugotiread e corrigir bugs no reader.

---

## 1. Bug: Navegação por capítulo em vertical-scroll

**Problema:** Ao clicar em qualquer capítulo, o reader sempre mostrava o capítulo 1.

**Causa raiz:** Em modo `vertical-scroll`, TODAS as páginas da obra eram renderizadas no DOM (`renderReaderPages` iterava de 0 a `content.pageCount`). Para obras com milhares de páginas, o navegador criava milhares de `<img>` e a tentativa de scroll (`scrollReaderToPage`) falhava porque imagens com `loading="lazy"` tinham altura 0, fazendo `offsetTop` ser sempre 0.

**Solução:** Em vez de renderizar todas as páginas, `renderReaderPages` agora usa `getChapterForPage()` e renderiza **apenas as páginas do capítulo atual** (`chapter.startPage` até `chapter.startPage + chapter.pageCount`). Isso:
- Reduz o DOM de milhares de elementos para ~15-25 imagens
- A primeira página do capítulo fica em `scrollTop = 0` (natural)
- `setReaderPage()` chama `renderShell()` + scroll para navegar entre capítulos
- Navegação dentro do mesmo capítulo usa `scrollReaderToPage()` com espera recursiva via `requestAnimationFrame` até as imagens anteriores carregarem

**Arquivos:** `src/client/app.ts`
- `renderReaderPages()`: agora filtra por capítulo em vertical-scroll
- `setReaderPage()`: chama `renderShell()` seguido de scroll para vertical-scroll
- `scrollReaderToPage()`: espera imagens anteriores carregarem antes de scrollar

---

## 2. Bug: Renderização infinita no scroll

**Problema:** `scrollReaderToPage` ficava em loop infinito de `requestAnimationFrame` tentando esperar imagens carregarem.

**Causa:** Com todas as páginas renderizadas (milhares), imagens `loading="lazy"` nunca carregavam o suficiente para que o `offsetTop` da página alvo se tornasse não-zero, fazendo o RAF recursivo nunca terminar.

**Solução:** Resolvido junto com o item 1 — agora só renderiza as páginas do capítulo atual (~15-25 imagens), que carregam rápido.

---

## 3. Feature: Dark/Light mode toggle

**Mudanças:**
- Adicionado `darkMode: boolean` ao `AppState`
- Inicializado via `localStorage.getItem("pugotiread-dark-mode") !== "light"`
- Botão ☀/🌙 (Font Awesome) na topbar entre Estatísticas e Configurações
- `applyTheme()` define `data-theme="dark"` ou `"light"` no `<html>`
- Persistência em `localStorage` no clique
- CSS: `[data-theme="light"]` redefine `--bg`, `--panel`, `--panel-soft`, `--text`, `--muted`, `--line`, `--input-bg`, `--brand-strong`, `--danger`
- Removida seção "Preferências" das Configurações (toggles "Modo escuro" e "Reduzir animações" eram cosméticos/não-funcionais)
- Ajustado fallback de settingsSection para `"account"` em vez de `"preferences"`

**Arquivos:**
- `src/client/app.ts`: `AppState`, `applyTheme()`, `boot()`, `renderShell()` (topbar), `bindShellEvents()`
- `public/styles.css`: variáveis `:root` e `[data-theme="light"]`

---

## 4. Bugfix: `void boot()` removido acidentalmente

**Problema:** Página em branco ao carregar.

**Causa:** Durante edições anteriores, a chamada `void boot();` no final do arquivo foi removida acidentalmente, impedindo a inicialização do app.

**Solução:** Restaurada a chamada.

---

## 5. Bugfix: CSS responsivo quebrado

**Problema:** Layout quebrado em mobile.

**Causa:** Ao limpar CSS legado do reader (overlays, pagination), a seção responsiva geral (`.app-shell`, `.topbar`, `.sidebar`) perdeu seu `@media (max-width: 760px)` wrapper.

**Solução:** Reaplicado `@media` wrapper no CSS responsivo.

---

## Backlog (da auditoria)

Prioritários:
1. `.series-meta { display: none }` no CSS — esconde número de páginas nos cards
2. `refreshProgress()` etc. sem try/catch — unhandled promise rejections
3. Separar `app.ts` (~5300 linhas) em módulos

---

## Continuação 2026-05-24

- Validado `npm run check` sem erros.
- Validado `npm run build` sem erros.
- Iniciado servidor local com `npm start`; endpoint `/` respondeu `HTTP/1.1 200 OK`.
- Corrigido lookup global de obras: `getAvailableContents()` agora inclui `state.readingNowContents`, permitindo abrir itens de "Lendo agora" mesmo quando a biblioteca é `book` ou `lightNovel` e não aparece na home global.
- Revalidado `npm run check` e `npm run build` sem erros após retomada.
- Servidor validado em porta alternativa `32111` porque `8099` e `8100` estavam ocupadas:
  - `/health` respondeu `200 OK`
  - `/` respondeu `200 OK`
  - `/app.js` respondeu `200 OK`
  - `/phosphor-sprite.svg` respondeu `200 OK`
- Retomada nova sem contexto anterior visível:
  - `npm run check` validado sem erros.
  - `npm run build` validado sem erros.
  - Servidor iniciado em `PORT=32111 npm start` após liberação fora do sandbox.
  - Smoke test HTTP validado:
    - `/health` respondeu `200 OK`
    - `/` respondeu `200 OK`
    - `/app.js` respondeu `200 OK`
    - `/phosphor-sprite.svg` respondeu `200 OK`
- Continuação 2026-05-24:
  - `npm run check` validado sem erros.
  - `npm run build` validado sem erros.
  - Servidor iniciado novamente em `PORT=32111 npm start` após `EPERM` no sandbox.
  - Smoke test HTTP validado fora do sandbox:
    - `/health` respondeu `200 OK`
    - `/` respondeu `200 OK`
    - `/app.js` respondeu `200 OK`
    - `/phosphor-sprite.svg` respondeu `200 OK`

## Download via Pugotidownloader 2026-05-24

- Adicionada aba `Downloads` em Configurações > Servidor.
- Formulário permite enviar link para Manga, Manhwa, Light Novel e Livro.
- Endpoint admin `/api/admin/downloads` valida URL http/https e dispara o Pugotidownloader em processo destacado.
- Ajustado template de comando para a CLI real do Pugotidownloader:
  - comando: `/DATA/AppData/pugotidownloader/ptd`
  - args: `{downloaderType} {url} --output {output}`
  - outputs: `Mangás`, `Manhwas`, `Lightnovels`, `Livros`
- Docker/Zima:
  - montado `/DATA/AppData/pugotidownloader` dentro do container
  - montado diretório de mídias em caminho absoluto para escrita do downloader
  - definido `HOME=/DATA` e `PYTHONDONTWRITEBYTECODE=1`
- Validação local:
  - `npm run check` OK
  - `npm run build` OK
- Deploy Zima:
  - pacote copiado para `/DATA/AppData/pugotiread-deploy-downloads-20260524.tar.gz`
  - fonte extraída em `/DATA/AppData/pugotiread-src`
  - `docker compose up -d --build` executado com `DOCKER_CONFIG=/tmp/docker-config`
  - container `pugotiread` iniciou `healthy`
  - smoke HTTP em `127.0.0.1:8099`: `/health`, `/`, `/app.js`, `/phosphor-sprite.svg` responderam `200 OK`
  - `/DATA/AppData/pugotidownloader/ptd --help` validado dentro do container

## Continuação 2026-05-25 - validação local

- `npm run check` validado sem erros.
- `npm run build` validado sem erros.
- Servidor iniciado em `PORT=32111 npm start` após `EPERM` no sandbox.
- Smoke HTTP validado fora do sandbox:
  - `/health` respondeu `200 OK`
  - `/` respondeu `200 OK`
  - `/app.js` respondeu `200 OK`
  - `/phosphor-sprite.svg` respondeu `200 OK`

## Continuação 2026-05-24 - revalidação

- `npm run check` validado sem erros.
- `npm run build` validado sem erros.
- `npm start` no sandbox falhou com `EPERM` em `0.0.0.0:8099`, como nas validações anteriores.
- `PORT=32111 npm start` fora do sandbox falhou porque a porta já estava em uso.
- Servidor iniciado em `PORT=32112 npm start`.
- Smoke HTTP validado fora do sandbox:
  - `/health` respondeu `200 OK`
  - `/` respondeu `200 OK`
  - `/app.js` respondeu `200 OK`
  - `/phosphor-sprite.svg` respondeu `200 OK`

## Remoção do Pugotidownloader 2026-05-24

- Removida a aba `Downloads` em Configurações > Servidor.
- Removido endpoint admin `/api/admin/downloads`.
- Removidas variáveis e volumes `PUGOTIDOWNLOADER_*` do `docker-compose.yml`.
- Mantida permissão antiga `canDownload` dos usuários, pois é independente da integração com Pugotidownloader.
- Validação local:
  - `npm run check` OK
  - `npm run build` OK
- ZimaOS:
  - Confirmado diretório `/DATA/AppData/pugotidownloader` com `ptd`, `env` e `source`.
  - Removido `/DATA/AppData/pugotidownloader`.

## Continuação 2026-05-25 - revalidação local

- `npm run check` validado sem erros.
- `npm run build` validado sem erros.
- `npm start` no sandbox falhou com `EPERM` em `0.0.0.0:32113`, como nas validações anteriores.
- Servidor iniciado fora do sandbox em `PORT=32113 npm start`.
- Smoke HTTP validado fora do sandbox:
  - `/health` respondeu `200 OK`
  - `/` respondeu `200 OK`
  - `/app.js` respondeu `200 OK`
  - `/phosphor-sprite.svg` respondeu `200 OK`
- Processo local de teste finalizado após a validação.

## Continuação 2026-05-26 - revalidação local

- `npm run check` validado sem erros.
- `npm run build` validado sem erros.
- `PORT=32114 npm start` no sandbox falhou com `EPERM` em `0.0.0.0:32114`, como nas validações anteriores.
- Servidor iniciado fora do sandbox em `PORT=32114 npm start`.
- Smoke HTTP validado fora do sandbox:
  - `/health` respondeu `200 OK`
  - `/` respondeu `200 OK`
  - `/app.js` respondeu `200 OK`
  - `/phosphor-sprite.svg` respondeu `200 OK`
- Processo local de teste finalizado após a validação.

## Ajustes visuais e lançamentos 2026-05-26

- Dark mode ajustado para fundo preto real:
  - `--bg: #000000`
  - superfícies/painéis escurecidos para tons próximos de preto.
- Página inicial alterada para `Lançamentos`.
- Home agora mostra apenas obras com capítulos atualizados e ordena pela data mais recente (`chapter.addedAt`) em ordem decrescente.
- Lista de capítulos exibida na home também ordena pelos capítulos atualizados mais recentes.
- Validação local:
  - `npm run check` OK
  - `npm run build` OK
- Deploy ZimaOS:
  - pacote limpo enviado para `sekiro@100.98.213.19`
  - fonte extraída em `/DATA/AppData/pugotiread-src`
  - `docker compose up -d --build` executado com `sudo` e `DOCKER_CONFIG=/tmp/docker-config`
  - container `pugotiread` rebuildado e iniciado
  - smoke HTTP em `100.98.213.19:8099`: `/health`, `/`, `/app.js`, `/styles.css` responderam `200 OK`
  - confirmado `/styles.css` publicado com `--bg: #000000`
  - confirmado `/UI/Web/views/home.js` publicado com `Lançamentos` e ordenação por `updatedAt`
