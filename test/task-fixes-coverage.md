# PugotiQA — tarefa 7399b7f1-5956-4646-9c18-1e77a2ac97f7

Origem: Pugotitasks, sekiro, “Bug fixes e Melhorias”, tag Pugotiread, nota de 20/10/2026.

- `work-metadata.test.ts`: conclusão explícita versus hiato/em andamento, rejeição de ranking/votos como nota.
- `work-metadata-integration.mjs`: scanner real com metadados BOM, sinopse, status, capítulos/páginas, cache atualizado; executado em contêiner isolado com arquivos temporários.
- `browser-series-details.mjs`: sinopse completa, nota da fonte, avaliação pessoal, capítulos antes de páginas, finalizada na obra e biblioteca, ausente em hiato, dados vazios, larguras 1280/800/390 e ausência de erros JS.
- `browser-epub-kindle.mjs`: regressões anteriores dos controles continuam verificadas.
- Downloader `tests/test_task_regressions.py`: JSON BOM, sinopse integral, votos/ranking, prefixo Manga Livre, SPY×FAMILY, recuperação explícita de falha recente. 117 testes Python aprovados; quatro novos cenários falharam antes da correção.
- Auditoria e recuperação reais: `../pugotidownloader-task-fixes-20261020/release/audit.json` e `recovery.json`; a conclusão do código não significa que todas as páginas externas existam. A recuperação usa lock compartilhado, duas páginas simultâneas e reserva de 4 GiB.
