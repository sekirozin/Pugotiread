# Pugotiread

Pugotiread é a base inicial de um leitor web pessoal, leve e moderno para homelab/ZimaOS. A ideia é evoluir aos poucos: primeiro uma arquitetura clara, depois leitura real de páginas, administração completa e permissões refinadas.

## O que existe nesta primeira etapa

- Backend Node.js com TypeScript usando apenas módulos nativos do Node.
- Frontend em HTML, CSS e TypeScript sem framework pesado.
- Login simples com sessão por cookie.
- Login com conta Google para usuários convidados, quando `GOOGLE_CLIENT_ID` estiver configurado.
- Usuários `admin` e `user` de demonstração.
- Bibliotecas com permissões por usuário.
- Varredura inicial de pastas montadas em `/media`.
- Capas reais usando a primeira imagem encontrada em cada título.
- Leitor real de imagens/PDF por página e modo vertical.
- Registro inicial de progresso e páginas marcadas.
- Dockerfile e `docker-compose.yml` expondo a porta `8099`.

Credenciais demo:

```txt
admin / admin
user / user
```

> Importante: o login demo ainda não é seguro para internet. Ele existe para ensinar a estrutura e permitir que a aplicação rode cedo. A próxima etapa deve trocar isso por senha com hash real, tela de criação de usuário e migração do arquivo de dados.

## Estrutura de pastas

```txt
Pugotiread/
├── data/
│   └── store.json              # Banco inicial em JSON: usuários, bibliotecas, progresso e favoritos
├── public/
│   ├── index.html              # HTML principal carregado pelo navegador
│   └── styles.css              # Estilos da interface
├── src/
│   ├── client/
│   │   └── app.ts              # TypeScript do frontend
│   ├── server/
│   │   ├── auth.ts             # Sessão, cookie e verificação de senha demo
│   │   ├── config.ts           # Portas e caminhos configuráveis por ambiente
│   │   ├── http.ts             # Helpers HTTP e servidor de arquivos estáticos
│   │   ├── index.ts            # Entrada do backend e rotas da API
│   │   ├── media.ts            # Varredura inicial das pastas de mídia
│   │   └── store.ts            # Leitura e escrita do JSON de dados
│   └── shared/
│       └── types.ts            # Tipos usados pelo backend e frontend
├── Dockerfile                  # Build e imagem final da aplicação
├── docker-compose.yml          # Serviço pronto para homelab/ZimaOS
├── package.json                # Scripts e dependências
└── tsconfig.json               # Configuração do TypeScript
```

## Como HTML, CSS e TypeScript se conectam

O navegador abre `public/index.html`. Esse HTML carrega dois arquivos:

- `/styles.css`, vindo de `public/styles.css`.
- `/app.js`, gerado a partir de `src/client/app.ts` quando você roda `npm run build`.

O `app.ts` cria a tela inteira dentro da `div#app`. Ele conversa com o backend usando `fetch()` em rotas como:

- `POST /api/login`
- `GET /api/libraries`
- `GET /api/libraries/:id/contents`
- `PUT /api/progress`
- `POST /api/bookmarks`

## Como o backend Node.js funciona

O arquivo `src/server/index.ts` cria um servidor HTTP na porta `8099`.

Quando a URL começa com `/api/`, ele responde como API JSON. Quando não começa, ele serve arquivos do frontend, como `index.html`, `styles.css` e `app.js`.

O backend lê `data/store.json` como uma base simples. Essa escolha é proposital para a primeira etapa: fica fácil entender o fluxo antes de introduzir SQLite ou outro banco.

Fluxo básico:

1. Usuário envia login para `/api/login`.
2. Backend valida usuário e senha demo.
3. Backend grava um cookie de sessão.
4. Frontend chama `/api/me` e `/api/libraries`.
5. Backend filtra bibliotecas conforme `allowedLibraryIds`.
6. Ao abrir uma biblioteca, o backend varre a pasta configurada em `path`.
7. Cada pasta dentro da biblioteca vira um título.
8. A primeira imagem da pasta vira capa.
9. As páginas são servidas por rotas seguras como `/api/contents/:id/pages/:page`.

As imagens não são expostas diretamente como arquivos públicos. O backend confere a sessão e a permissão da biblioteca antes de entregar cada página.

## Login com Google por convite

Para liberar o login com Google, crie um OAuth Client ID no Google Cloud Console do tipo "Web application" e configure o domínio/origem onde o Pugotiread vai rodar. Depois defina:

```bash
GOOGLE_CLIENT_ID="seu-client-id.apps.googleusercontent.com"
```

Com essa variável ativa, o link de convite permite que a pessoa entre com a conta Google do mesmo e-mail convidado e escolha o nickname. O backend valida o ID token com as chaves públicas do Google antes de criar a conta e marcar o convite como usado.

## Como montar a pasta de mídias

O `docker-compose.yml` monta `./media` do seu host em `/media` dentro do container.

Crie uma estrutura assim:

```txt
media/
├── mangas/
│   └── COLORIST/
│       ├── Capa.webp
│       ├── metadata.json
│       ├── Cap. 01/
│       │   ├── 001.webp
│       │   └── 002.webp
│       └── Cap. 02/
│           ├── 001.webp
│           └── 002.webp
└── livros/
    ├── Meu Livro/
    │   ├── 001.jpg
    │   └── 002.webp
    └── A Espera de um Milagre.pdf
```

Para mangás/manhwas, a biblioteca aponta para a pasta raiz, por exemplo `/media/mangas`. Cada pasta dentro dela vira uma obra. Dentro de cada obra, o Pugotiread procura:

- `Capa.jpg`, `Capa.png`, `Capa.webp` ou `cover.*` para a capa.
- `metadata.json` para título, descrição, autores, data, nota e gêneros.
- Pastas de capítulos, como `Cap. 01`, `Cap. 02`, com páginas numeradas.

Arquivos `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif` e `.pdf` contam como páginas. Os capítulos são lidos em ordem natural.

A primeira imagem encontrada aparece como capa. Se o conteúdo for apenas PDF, ele aparece com capa placeholder e abre o PDF no leitor. Paginação interna de PDF será uma etapa posterior com PDF.js ou conversão server-side.

No ZimaOS, troque o volume do compose para apontar para sua pasta real, por exemplo:

```yaml
volumes:
  - ./data:/app/data
  - /DATA/Media/Leituras:/media:ro
```

Se suas bibliotecas finais ficarem dentro de uma pasta sincronizada pelo Nextcloud no ZimaOS, monte essa pasta no `/media`. Exemplo:

```yaml
volumes:
  - ./data:/app/data
  - /DATA/AppData/nextcloud/data/seu-usuario/files/Leituras:/media:ro
```

Depois ajuste `data/store.json` para apontar cada biblioteca para uma subpasta:

```json
{
  "id": "mangas",
  "name": "Mangás",
  "kind": "manga",
  "path": "/media/mangas"
}
```

## Como rodar localmente

Instale as dependências:

```bash
npm install
```

Rode em modo desenvolvimento:

```bash
npm run dev
```

Acesse:

```txt
http://localhost:8099
```

Para compilar e rodar como produção local:

```bash
npm run build
npm start
```

## Como subir com Docker

Crie as pastas locais:

```bash
mkdir -p media/mangas media/livros data
```

Suba o serviço:

```bash
docker compose up -d --build
```

Acesse:

```txt
http://localhost:8099
```

Para ver logs:

```bash
docker compose logs -f pugotiread
```

Para parar:

```bash
docker compose down
```

## ZimaOS

Para rodar no ZimaOS, use o mesmo `docker-compose.yml` e aponte os volumes para as pastas reais do sistema. Exemplo:

```yaml
volumes:
  - /DATA/AppData/pugotiread/data:/app/data
  - /DATA/Media/Leituras:/media:ro
```

Se o app estiver rodando a partir do compose do repositório, o `GOOGLE_CLIENT_ID` já pode ficar no arquivo. Depois de salvar, recrie o container para ele receber a variável e as pastas corretas.

## Próximas etapas recomendadas

1. Trocar senha demo por hash real e tela de gerenciamento de usuários.
2. Criar ação de escanear biblioteca e cache de metadados.
3. Criar painel Admin para bibliotecas e permissões.
4. Melhorar progresso automático no modo vertical.
5. Substituir JSON por SQLite quando o modelo estabilizar.
