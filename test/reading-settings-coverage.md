# PugotiQA — configurações de leitura (19/10/2026)

Regressões desta entrega, executadas antes da publicação:
- `browser-epub-kindle.mjs`: Livros e Light Novels mostram Páginas/Rolagem, sem ajuste de imagens; mangás preservam seus modos e ajustes.
- Mesmo teste: campos sem cortes/transbordamento em 1159, 800 e 390 px; salvar preferências, abrir EPUB em conta comum com Rolagem/controles visíveis e Páginas/controles ocultos; ajuste oculto preservado ao salvar.
- `reading-settings-http.mjs`: API real em contêiner isolado; exige login, retorna apenas preferências de leitura, oferece padrão Páginas, persiste alterações e permite leitura por usuário comum sem dar acesso às configurações administrativas.
- 23 testes de `app-reader.test.ts`, `epub-progress.test.ts`, `epub-search.test.ts`, `router.test.ts`: aprovados.
- Suíte de navegador mantém regressões anteriores de paginação EPUB, progresso, zoom, aparência, fechar/restaurar aparência e alinhamento dos controles de mangá/manhwa.

Comandos: `npm run build`; `node --import tsx --test test/app-reader.test.ts test/epub-progress.test.ts test/epub-search.test.ts test/router.test.ts`; `node test/browser-epub-kindle.mjs`; `node test/reading-settings-http.mjs`.
O teste HTTP precisa da dependência better-sqlite3 compilada para o Node/plataforma em uso. Nesta entrega foi executado na imagem de produção, com banco e mídia temporários e sem volumes de dados reais.

Limites da confirmação: não existe nesta entrega auditoria completa que relacione TODOS os bugs históricos a testes. `npm test` local encontrou incompatibilidade de ABI do better-sqlite3; a execução ampla foi interrompida, não considerada aprovada. Encontrou também um teste antigo exigindo persistência de RTL, função removida por solicitação do usuário: essa expectativa obsoleta foi retirada; a ausência do botão e os dois modos válidos continuam verificados no teste de navegador. Estes testes estão versionados como arquivos de regressão, mas não se afirma que exista execução automática contínua/CI configurada.
