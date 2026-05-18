# Arquitetura Inicial

Este documento registra as decisões da primeira etapa do Pugotiread.

## Decisões

- **Sem framework no backend por enquanto**: o servidor usa `node:http`. Isso reduz dependências e ajuda a entender o fluxo real de requisição e resposta.
- **Sem framework no frontend por enquanto**: a interface usa TypeScript e DOM direto. Para um leitor leve de homelab, isso mantém o bundle pequeno.
- **JSON como banco inicial**: `data/store.json` deixa permissões, bibliotecas e progresso fáceis de inspecionar. Quando o projeto crescer, SQLite será uma evolução natural.
- **Mídia montada fora da imagem Docker**: o container lê `/media`, mas os arquivos ficam no host/NAS/ZimaOS.

## Limites intencionais desta etapa

- Senhas são apenas demonstração.
- O leitor ainda não serve imagens reais.
- Admin ainda não tem painel de CRUD.
- O scanner só entende pastas com imagens diretas.

Esses limites mantêm a base pequena e legível antes de implementar regras mais sensíveis.
