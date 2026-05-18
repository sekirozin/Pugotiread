import type { Bookmark, ContentItem, Invitation, Library, LibraryKind, PublicContentReview, PublicUser, ReadingProgress, ServerSettings } from "../shared/types.js";

type UserCollection = {
  id: string;
  userId: string;
  name: string;
  description: string;
  sharedWithUserIds: string[];
  ownerDisplayName: string;
  contentIds: string[];
};

type ReaderMode = "horizontal" | "paged-vertical" | "vertical-scroll";

type AppState = {
  user: PublicUser | null;
  libraries: Library[];
  personalLibraries: Library[];
  adminUsers: PublicUser[];
  peopleUsers: PublicUser[];
  contents: ContentItem[];
  homeContents: ContentItem[];
  activeLibraryId: string | null;
  activeSeriesId: string | null;
  activeView:
    | "home"
    | "want"
    | "collections"
    | "lists"
    | "bookmarks"
    | "all"
    | "vault"
    | "people"
    | "library"
    | "profile"
    | "settings";
  settingsSection: "account" | "preferences" | "server";
  serverSection: "libraries" | "users" | "vault";
  accountMenuOpen: boolean;
  openLibraryMenuId: string | null;
  vaultMenuOpen: boolean;
  openSeriesMenuId: string | null;
  openSeriesAddMenuId: string | null;
  openSeriesRemoveMenuId: string | null;
  libraryModalOpen: boolean;
  libraryModalError: string;
  editingLibraryId: string | null;
  collectionModalOpen: boolean;
  collectionModalError: string;
  collectionShareModalOpen: boolean;
  collectionShareError: string;
  collectionShareUsers: PublicUser[];
  sharingCollectionId: string | null;
  deletingCollectionId: string | null;
  collectionDeleteError: string;
  editingCollectionId: string | null;
  collectionEditError: string;
  peopleShareError: string;
  activePeopleUserId: string | null;
  scanMessage: string;
  libraryModalStep: "general" | "folder" | "cover" | "advanced";
  libraryDraft: {
    name: string;
    kind: LibraryKind;
    path: string;
    isPersonal: boolean;
  };
  collectionDraft: {
    name: string;
    description: string;
  };
  collectionEditDraft: {
    name: string;
    description: string;
  };
  folderBrowser: {
    path: string;
    parent: string | null;
    directories: Array<{ name: string; path: string }>;
  } | null;
  sidebarCollapsed: boolean;
  search: string;
  progress: ReadingProgress[];
  bookmarks: Bookmark[];
  seriesMarks: string[];
  wantToRead: string[];
  readingList: string[];
  collections: UserCollection[];
  seriesChapterOrder: "asc" | "desc" | "last-read";
  seriesChapterLayout: "list" | "grid";
  seriesTab: "chapters" | "specials" | "reviews";
  seriesReviews: Record<string, PublicContentReview[]>;
  profileReviews: PublicContentReview[];
  seriesReviewError: string;
  profileEditing: boolean;
  profileError: string;
  profileFavoriteSearch: string;
  invitePathToken: string | null;
  inviteData: Invitation | null;
  inviteError: string;
  inviteCreateAccountOpen: boolean;
  vaultUnlocked: boolean;
  vaultToken: string;
  vaultError: string;
  vaultTimeoutMinutes: number;
  vaultSettingsDraft: string;
  vaultSettingsMessage: string;
  vaultSettingsError: string;
  adminUserModalOpen: boolean;
  adminUserModalMode: "create" | "edit" | "invite";
  adminUserEditingId: string | null;
  adminUserDeleteId: string | null;
  adminUserModalError: string;
  adminUserInviteUrl: string;
  adminUserDraft: {
    email: string;
    displayName: string;
    username: string;
    password: string;
    allowedLibraryIds: string[];
    canLogin: boolean;
    canDownload: boolean;
    canChangePassword: boolean;
  };
  reader: { content: ContentItem; page: number; mode: ReaderMode; controlsVisible: boolean } | null;
};

const defaultVaultTimeoutMinutes = 5;
let vaultInactivityTimer: number | null = null;
let lastVaultTouchAt = 0;
let vaultTouchInFlight = false;

type ParsedSearch = {
  libraryId: string | null;
  query: string;
};

type GoogleCredentialResponse = {
  credential?: string;
};

type GoogleConfig = {
  enabled: boolean;
  clientId: string;
};

type GoogleAccounts = {
  accounts: {
    id: {
      initialize(options: { client_id: string; callback: (response: GoogleCredentialResponse) => void }): void;
      renderButton(element: HTMLElement, options: { theme: string; size: string; width: number; text?: string }): void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleAccounts;
  }
}

let googleConfigPromise: Promise<GoogleConfig> | null = null;
let googleScriptPromise: Promise<void> | null = null;

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) {
  throw new Error("Elemento #app não encontrado.");
}

const app = appElement;

const ICONS = {
  menu: "☰",
  badge: "▣",
  stats: "⌁",
  settings: "⚙",
  caret: "⌄",
  home: "⌂",
  want: "★",
  collections: "☷",
  lists: "≡",
  bookmarks: "▮",
  all: "▤",
  lock: "▣",
  people: "♟",
  libraryBook: "▰",
  libraryManga: "▣",
  close: "×",
  mark: "▣",
  file: "▧",
  author: "✎",
  release: "◷",
  genres: "▣",
  progress: "▸",
  rating: "★",
  continue: "▤",
  share: "↗"
} as const;

function renderIcon(name: keyof typeof ICONS): string {
  return ICONS[name];
}

function renderReaderModeIcon(): string {
  if (!state.reader) {
    return "↕";
  }
  if (state.reader.mode === "horizontal") {
    return "↔";
  }
  return "↕";
}

const SIDEBAR_ICON_PATHS = {
  home: "/icons/home/home_32x32.png",
  want: "/icons/star/star_32x32.png",
  collections: "/icons/medal/medal_32x32.png",
  lists: "/icons/list/list_32x32.png",
  bookmarks: "/icons/markbook/markbook_32x32.png",
  all: "/icons/book/book_32x32.png",
  people: "/icons/users/users_32x32.png",
  book: "/icons/book/book_32x32.png",
  pencil: "/icons/pencil/pencil_32x32.png",
  vaultOpen: "/icons/lock_open/lock_open_32x32.png",
  vaultClosed: "/icons/lock_closed/lock_closed_32x32.png",
  trash: "/icons/trash/trash_32x32.png"
} as const;

function renderSidebarIcon(name: keyof typeof SIDEBAR_ICON_PATHS, label: string): string {
  return `<img class="nav-image-icon" src="${SIDEBAR_ICON_PATHS[name]}" alt="" aria-hidden="true" title="${escapeHtml(label)}" />`;
}

const state: AppState = {
  user: null,
  libraries: [],
  personalLibraries: [],
  adminUsers: [],
  peopleUsers: [],
  contents: [],
  homeContents: [],
  activeLibraryId: null,
  activeSeriesId: null,
  activeView: "home",
  settingsSection: "server",
  serverSection: "libraries",
  accountMenuOpen: false,
  openLibraryMenuId: null,
  vaultMenuOpen: false,
  openSeriesMenuId: null,
  openSeriesAddMenuId: null,
  openSeriesRemoveMenuId: null,
  libraryModalOpen: false,
  libraryModalError: "",
  editingLibraryId: null,
  collectionModalOpen: false,
  collectionModalError: "",
  collectionShareModalOpen: false,
  collectionShareError: "",
  collectionShareUsers: [],
  sharingCollectionId: null,
  deletingCollectionId: null,
  collectionDeleteError: "",
  editingCollectionId: null,
  collectionEditError: "",
  peopleShareError: "",
  activePeopleUserId: null,
  scanMessage: "",
  libraryModalStep: "general",
  libraryDraft: {
    name: "",
    kind: "manga",
    path: "",
    isPersonal: false
  },
  collectionDraft: {
    name: "",
    description: ""
  },
  collectionEditDraft: {
    name: "",
    description: ""
  },
  folderBrowser: null,
  sidebarCollapsed: false,
  search: "",
  progress: [],
  bookmarks: [],
  seriesMarks: [],
  wantToRead: [],
  readingList: [],
  collections: [],
  seriesChapterOrder: "asc",
  seriesChapterLayout: "list",
  seriesTab: "chapters",
  seriesReviews: {},
  profileReviews: [],
  seriesReviewError: "",
  profileEditing: false,
  profileError: "",
  profileFavoriteSearch: "",
  invitePathToken: null,
  inviteData: null,
  inviteError: "",
  inviteCreateAccountOpen: false,
  vaultUnlocked: false,
  vaultToken: "",
  vaultError: "",
  vaultTimeoutMinutes: defaultVaultTimeoutMinutes,
  vaultSettingsDraft: String(defaultVaultTimeoutMinutes),
  vaultSettingsMessage: "",
  vaultSettingsError: "",
  adminUserModalOpen: false,
  adminUserModalMode: "create",
  adminUserEditingId: null,
  adminUserDeleteId: null,
  adminUserModalError: "",
  adminUserInviteUrl: "",
  adminUserDraft: {
    email: "",
    displayName: "",
    username: "",
    password: "",
    allowedLibraryIds: [],
    canLogin: true,
    canDownload: true,
    canChangePassword: true
  },
  reader: null
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(state.vaultToken ? { "X-Vault-Token": state.vaultToken } : {}),
      ...(init?.headers ?? {})
    },
    credentials: "same-origin"
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: "Erro inesperado." }))) as { error?: string };
    throw new Error(payload.error ?? "Erro inesperado.");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function getGoogleConfig(): Promise<GoogleConfig> {
  googleConfigPromise ??= api<GoogleConfig>("/api/auth/google/config");
  return googleConfigPromise;
}

async function ensureGoogleScript(): Promise<void> {
  if (window.google) {
    return;
  }

  googleScriptPromise ??= new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>("script[data-google-identity]");
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Não foi possível carregar o login do Google.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Não foi possível carregar o login do Google.")), { once: true });
    document.head.append(script);
  });
  await googleScriptPromise;
}

async function mountGoogleButton(
  containerId: string,
  callback: (credential: string) => Promise<void>,
  unavailableMessage: string
): Promise<void> {
  const container = document.querySelector<HTMLElement>(`#${containerId}`);
  if (!container) {
    return;
  }

  try {
    const config = await getGoogleConfig();
    if (!config.enabled || !config.clientId) {
      container.innerHTML = `<p class="google-unavailable">${escapeHtml(unavailableMessage)}</p>`;
      return;
    }

    await ensureGoogleScript();
    if (!window.google) {
      throw new Error("Login do Google indisponível.");
    }

    window.google.accounts.id.initialize({
      client_id: config.clientId,
      callback: (response) => {
        if (!response.credential) {
          container.innerHTML = `<p class="google-unavailable">Credencial do Google não recebida.</p>`;
          return;
        }
        void callback(response.credential);
      }
    });
    window.google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      width: Math.min(360, container.clientWidth || 360),
      text: "signin_with"
    });
  } catch (error) {
    container.innerHTML = `<p class="google-unavailable">${escapeHtml(error instanceof Error ? error.message : unavailableMessage)}</p>`;
  }
}

function closeFloatingMenusFromOutside(target: EventTarget | null): void {
  const element = target instanceof HTMLElement ? target : null;
  if (!element || element.closest("[data-series-menu-key], .series-context-menu, .series-add-menu, .series-remove-menu")) {
    return;
  }

  if (!state.openSeriesMenuId && !state.openSeriesAddMenuId && !state.openSeriesRemoveMenuId) {
    return;
  }

  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  renderShell();
}

document.addEventListener("click", (event) => {
  closeFloatingMenusFromOutside(event.target);
});

["click", "keydown", "pointermove", "scroll"].forEach((eventName) => {
  document.addEventListener(eventName, registerVaultActivity, { passive: true });
});

async function boot(): Promise<void> {
  if (window.location.pathname.startsWith("/invite/")) {
    state.invitePathToken = decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
    await loadInviteFlow();
    return;
  }

  try {
    const payload = await api<{ user: PublicUser }>("/api/me");
    state.user = payload.user;
    if (state.user.needsNickname) {
      renderNicknameSetup();
      return;
    }
    await loadHome();
  } catch {
    renderLogin();
  }
}

async function loadInviteFlow(): Promise<void> {
  if (!state.invitePathToken) {
    renderLogin("Convite inválido.");
    return;
  }

  try {
    const payload = await api<{ invitation: Invitation }>(`/api/invites/${encodeURIComponent(state.invitePathToken)}`);
    state.inviteData = payload.invitation;
    renderInviteRegistration();
  } catch (error) {
    state.inviteError = error instanceof Error ? error.message : "Convite inválido.";
    renderInviteRegistration();
  }
}

async function loadHome(): Promise<void> {
  const requests: Promise<unknown>[] = [
    api<{ libraries: Library[] }>("/api/libraries"),
    api<{ progress: ReadingProgress[] }>("/api/continue"),
    api<{ bookmarks: Bookmark[] }>("/api/bookmarks"),
    api<{ seriesMarks: string[] }>("/api/series-marks"),
    api<{ wantToRead: string[]; readingList: string[]; collections: UserCollection[] }>("/api/user-lists"),
    api<{ reviews: PublicContentReview[] }>("/api/me/reviews"),
    api<{ users: PublicUser[] }>("/api/users")
  ];

  if (state.user?.role === "admin") {
    requests.push(api<{ users: PublicUser[]; libraries: Library[] }>("/api/admin/users"));
    requests.push(api<{ settings: ServerSettings }>("/api/admin/settings"));
  }

  const [librariesPayload, progressPayload, bookmarksPayload, seriesMarksPayload, userListsPayload, reviewsPayload, usersPayload, adminPayload, settingsPayload] = await Promise.all(requests);
  const { libraries } = librariesPayload as { libraries: Library[] };
  const { progress } = progressPayload as { progress: ReadingProgress[] };
  const { bookmarks } = bookmarksPayload as { bookmarks: Bookmark[] };
  const { seriesMarks } = seriesMarksPayload as { seriesMarks: string[] };
  const userLists = userListsPayload as { wantToRead: string[]; readingList: string[]; collections: UserCollection[] };
  const { reviews } = reviewsPayload as { reviews: PublicContentReview[] };
  const { users } = usersPayload as { users: PublicUser[] };

  state.libraries = libraries;
  state.progress = progress;
  state.bookmarks = bookmarks;
  state.seriesMarks = seriesMarks;
  state.wantToRead = userLists.wantToRead;
  state.readingList = userLists.readingList;
  state.collections = userLists.collections;
  state.profileReviews = reviews;
  state.peopleUsers = users;
  if (adminPayload) {
    const payload = adminPayload as { users: PublicUser[]; libraries: Library[] };
    state.adminUsers = payload.users;
    state.libraries = payload.libraries;
  }
  if (settingsPayload) {
    const { settings } = settingsPayload as { settings: ServerSettings };
    state.vaultTimeoutMinutes = settings.vaultTimeoutMinutes;
    state.vaultSettingsDraft = String(settings.vaultTimeoutMinutes);
  }
  state.homeContents = await loadLibraryContents(libraries);
  state.activeLibraryId = null;
  state.activeSeriesId = null;
  state.activeView = "home";
  renderShell();
}

async function loadLibraryContents(libraries: Library[]): Promise<ContentItem[]> {
  const responses = await Promise.all(
    libraries.map((library) =>
      api<{ contents: ContentItem[] }>(`/api/libraries/${library.id}/contents`).catch(() => ({ contents: [] }))
    )
  );

  return responses.flatMap((response) => response.contents);
}

async function loadLibrary(libraryId: string): Promise<void> {
  state.activeLibraryId = libraryId;
  state.activeSeriesId = null;
  state.activeView = "library";
  state.reader = null;
  const { contents } = await api<{ contents: ContentItem[] }>(`/api/libraries/${libraryId}/contents`);
  state.contents = contents;
  renderShell();
}

function renderLogin(error = ""): void {
  app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel" id="login-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Leitor pessoal do Pugotilab para mangás, manhwas e livros.</p>
        <label class="form-row">
          <span>Usuário</span>
          <input class="input" name="username" autocomplete="username" value="admin" />
        </label>
        <label class="form-row">
          <span>Senha</span>
          <input class="input" type="password" name="password" autocomplete="current-password" value="admin" />
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <button class="button" type="submit">Entrar</button>
      </form>
    </main>
  `;

  document.querySelector<HTMLFormElement>("#login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);

    try {
      const payload = await api<{ user: PublicUser }>("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: String(form.get("username")),
          password: String(form.get("password"))
        })
      });
      state.user = payload.user;
      if (state.user.needsNickname) {
        renderNicknameSetup();
        return;
      }
      await loadHome();
    } catch (loginError) {
      renderLogin(loginError instanceof Error ? loginError.message : "Falha no login.");
    }
  });
}

function renderInviteRegistration(): void {
  const invitation = state.inviteData;
  if (state.inviteCreateAccountOpen) {
    renderInviteAccountCreation(invitation);
    return;
  }

  app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="invite-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Entrar com convite</p>
        ${
          invitation
            ? `
              <p class="invite-summary">${escapeHtml(invitation.displayName)} / ${escapeHtml(invitation.email)}</p>
            `
            : ""
        }
        <button class="invite-create-link" id="open-invite-create-account" type="button">Criar conta</button>
        <div class="login-divider"><span>ou</span></div>
        <div class="google-button-slot" id="google-invite-button"></div>
        <p class="error">${escapeHtml(state.inviteError)}</p>
      </form>
    </main>
  `;

  document.querySelector("#open-invite-create-account")?.addEventListener("click", () => {
    state.inviteCreateAccountOpen = true;
    state.inviteError = "";
    renderInviteRegistration();
  });

  document.querySelector<HTMLFormElement>("#invite-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
  });

  void mountGoogleButton("google-invite-button", async (credential) => {
    try {
      const payload = await api<{ user: PublicUser }>("/api/auth/google", {
        method: "POST",
        body: JSON.stringify({
          credential,
          inviteToken: state.invitePathToken
        })
      });
      state.user = payload.user;
      state.inviteData = null;
      state.inviteError = "";
      if (state.user.needsNickname) {
        renderNicknameSetup();
        return;
      }
      await loadHome();
    } catch (inviteError) {
      state.inviteError = inviteError instanceof Error ? inviteError.message : "Não foi possível concluir o cadastro com Google.";
      renderInviteRegistration();
    }
  }, "Login com Google ainda não configurado.");
}

function renderInviteAccountCreation(invitation: Invitation | null): void {
  app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="invite-create-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Criar conta</p>
        <label class="form-row">
          <span>Nickname</span>
          <input class="input" name="nickname" maxlength="40" autocomplete="nickname" placeholder="Seu nome público" required />
        </label>
        <label class="form-row">
          <span>E-mail</span>
          <input class="input" name="email" type="email" autocomplete="email" value="${escapeHtml(invitation?.email ?? "")}" ${invitation?.email ? "readonly" : ""} required />
        </label>
        <label class="form-row">
          <span>Senha</span>
          <input class="input" name="password" type="password" autocomplete="new-password" required />
        </label>
        <p class="error">${escapeHtml(state.inviteError)}</p>
        <div class="invite-form-actions">
          <button class="button secondary" id="back-to-google-invite" type="button">Voltar</button>
          <button class="button" type="submit">Criar conta</button>
        </div>
      </form>
    </main>
  `;

  document.querySelector("#back-to-google-invite")?.addEventListener("click", () => {
    state.inviteCreateAccountOpen = false;
    state.inviteError = "";
    renderInviteRegistration();
  });

  document.querySelector<HTMLFormElement>("#invite-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      const payload = await api<{ user: PublicUser }>(`/api/invites/${encodeURIComponent(state.invitePathToken ?? "")}`, {
        method: "POST",
        body: JSON.stringify({
          nickname: String(form.get("nickname") ?? ""),
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? "")
        })
      });
      state.user = payload.user;
      state.inviteData = null;
      state.inviteError = "";
      state.inviteCreateAccountOpen = false;
      await loadHome();
    } catch (error) {
      state.inviteError = error instanceof Error ? error.message : "Não foi possível criar a conta.";
      renderInviteAccountCreation(invitation);
    }
  });
}

function renderNicknameSetup(error = ""): void {
  const user = state.user;
  app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="nickname-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Digite seu nickname</p>
        <label class="form-row">
          <span>Nickname</span>
          <input class="input" name="nickname" maxlength="40" autocomplete="nickname" placeholder="Seu nome público" required autofocus />
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <button class="button" type="submit">Entrar</button>
      </form>
    </main>
  `;

  document.querySelector<HTMLFormElement>("#nickname-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const nickname = String(formData.get("nickname") ?? "").trim();
    if (!nickname || nickname.length > 40) {
      renderNicknameSetup("Escolha um nickname com até 40 caracteres.");
      return;
    }

    try {
      const payload = await api<{ user: PublicUser }>("/api/me/profile", {
        method: "PATCH",
        body: JSON.stringify({
          avatarUrl: user?.avatarUrl ?? "",
          nickname,
          biography: user?.biography ?? "",
          location: user?.location ?? "",
          favoriteContentIds: user?.favoriteContentIds ?? []
        })
      });
      state.user = payload.user;
      await loadHome();
    } catch (error) {
      renderNicknameSetup(error instanceof Error ? error.message : "Não foi possível salvar o nickname.");
    }
  });
}

function renderShell(): void {
  const activeLibrary = [...state.libraries, ...state.personalLibraries].find((library) => library.id === state.activeLibraryId);
  const activeSeries = getSelectedSeries();
  const filtered = filterContents(state.contents, state.search);
  const userName = state.user?.nickname || state.user?.displayName || state.user?.username || "Usuário";

  app.innerHTML = `
    <div class="app-shell${state.activeView === "settings" ? " settings-shell" : ""}${state.sidebarCollapsed ? " sidebar-collapsed" : ""}${state.reader ? " reader-active" : ""}">
      <header class="topbar">
        <div class="topbar-brand">
          <button class="icon-button" id="menu-button" type="button" title="Menu">${renderIcon("menu")}</button>
          <button class="topbar-home" id="home-button" type="button">
            <span class="brand-badge" aria-hidden="true">${renderSidebarIcon("book", "Pugotiread")}</span>
            <span>Pugotiread</span>
          </button>
        </div>
        <label class="search-shell">
          <span class="visually-hidden">Pesquisar</span>
          <input class="search" id="search" placeholder="Search (Procurar)" value="" />
          <span class="search-ghost" id="search-ghost" aria-hidden="true"></span>
          <kbd>Ctrl+Y</kbd>
        </label>
        <div class="topbar-actions">
          <button class="icon-button" type="button" title="Estatísticas">${renderIcon("stats")}</button>
          <button class="icon-button" id="settings-button" type="button" title="Configurações">${renderIcon("settings")}</button>
          <div class="account-menu-shell">
            <button class="avatar-button" id="account-button" type="button" aria-expanded="${state.accountMenuOpen}" title="${escapeHtml(userName)}">
              ${renderAvatar(state.user)}
              <span class="avatar-caret" aria-hidden="true">${renderIcon("caret")}</span>
            </button>
            ${state.accountMenuOpen ? renderAccountMenu(userName) : ""}
          </div>
        </div>
      </header>
      <aside class="sidebar">
        ${state.activeView === "settings" ? renderSettingsSidebar() : renderMainSidebar()}
      </aside>
      <main class="main">
        ${state.scanMessage ? `<p class="scan-message global-scan-message">${escapeHtml(state.scanMessage)}</p>` : ""}
        ${
          state.reader
            ? renderReader(state.reader.content, state.reader.page, state.reader.mode)
            : renderMainView(activeLibrary, filtered, activeSeries)
        }
      </main>
      ${state.libraryModalOpen ? renderLibraryModal() : ""}
      ${state.collectionModalOpen ? renderCollectionModal() : ""}
      ${state.collectionShareModalOpen ? renderCollectionShareModal() : ""}
      ${state.deletingCollectionId ? renderCollectionDeleteModal() : ""}
      ${state.adminUserModalOpen ? renderAdminUserModal() : ""}
      ${state.adminUserDeleteId ? renderUserDeleteModal() : ""}
    </div>
  `;

  bindShellEvents();
}

function renderMainSidebar(): string {
  return `
    <nav class="side-nav" aria-label="Menu principal">
      ${renderNavButton("home", renderSidebarIcon("home", "Início"), "Início")}
      ${renderNavButton("want", renderSidebarIcon("want", "Quero ler"), "Quero ler")}
      ${renderNavButton("collections", renderSidebarIcon("collections", "Coleções"), "Coleções")}
      ${renderNavButton("lists", renderSidebarIcon("lists", "Listas de leitura"), "Listas de leitura")}
      ${renderNavButton("bookmarks", renderSidebarIcon("bookmarks", "Marcadores"), "Marcadores")}
      ${renderNavButton("all", renderSidebarIcon("all", "Todos os títulos"), "Todos os títulos")}
      ${state.user?.role === "admin" ? renderVaultNavButton() : ""}
      ${renderNavButton("people", renderSidebarIcon("people", "Pessoas"), "Pessoas")}
    </nav>
    <div class="side-section">
      <p class="nav-title">Bibliotecas</p>
      <nav class="library-list" aria-label="Bibliotecas criadas pelo admin">
        ${state.libraries.map(renderLibraryButton).join("")}
      </nav>
    </div>
    ${
      state.user?.role === "admin"
        ? `<button class="sidebar-admin" type="button" title="Configurações de servidor">Admin</button>`
        : ""
    }
  `;
}

function renderSettingsSidebar(): string {
  const isAdmin = state.user?.role === "admin";
  return `
    <nav class="settings-sidebar" aria-label="Configurações">
      <div class="settings-group">
        <h3>Conta</h3>
        ${renderSettingsButton("account", "Conta")}
        ${renderSettingsButton("preferences", "Preferências")}
      </div>
      ${
        isAdmin
          ? `
            <div class="settings-group">
              <h3>Servidor</h3>
              ${renderServerSectionButton("libraries", "Bibliotecas")}
              ${renderServerSectionButton("users", "Usuários")}
              ${renderServerSectionButton("vault", "Cofre pessoal")}
            </div>
          `
          : ""
      }
    </nav>
  `;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "U";
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
  return `${first}${second}`.toUpperCase();
}

function avatarStyle(name: string): string {
  const variants = [
    ["#1c31a5", "#101f78"],
    ["#101f78", "#020f59"],
    ["#1c31a5", "#020f59"],
    ["#101f78", "#000524"]
  ];
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) % variants.length;
  }

  const [first, second] = variants[hash] ?? variants[0];
  return `--avatar-a: ${first}; --avatar-b: ${second};`;
}

function renderAvatar(user: PublicUser | null, className = "avatar"): string {
  const userName = user?.nickname || user?.displayName || user?.username || "Usuário";
  if (user?.avatarUrl) {
    return `<span class="${className} photo-avatar" style="background-image: url('${escapeHtml(user.avatarUrl)}')"></span>`;
  }

  return `<span class="${className}" style="${avatarStyle(userName)}">${escapeHtml(getInitials(userName))}</span>`;
}

function renderAccountMenu(userName: string): string {
  return `
    <div class="account-menu" role="menu">
      <div class="account-summary">
        ${renderAvatar(state.user, "avatar account-avatar")}
        <div>
          <strong>${escapeHtml(userName)}</strong>
          <p>${escapeHtml(state.user?.role === "admin" ? "Administrador" : "Usuário")}</p>
        </div>
      </div>
      <button class="account-menu-item" id="profile-button" type="button" role="menuitem">Perfil</button>
      <button class="account-menu-item danger" id="logout-button" type="button" role="menuitem">Logout</button>
    </div>
  `;
}

function renderNavButton(view: AppState["activeView"], icon: string, label: string): string {
  const active = state.activeView === view ? " active" : "";
  return `
    <button class="nav-button${active}" data-nav-view="${view}" title="${escapeHtml(label)}">
      <span class="nav-icon" aria-hidden="true">${icon}</span>
      <span class="nav-label">${label}</span>
    </button>
  `;
}

function renderLibraryButton(library: Library): string {
  const active = state.activeView === "library" && library.id === state.activeLibraryId ? " active" : "";
  return `
    <button class="nav-button library-button${active}" data-library-id="${library.id}" title="${escapeHtml(library.name)}">
      <span class="nav-icon" aria-hidden="true">${renderSidebarIcon("book", library.name)}</span>
      <span class="nav-label">${escapeHtml(library.name)}</span>
      ${
        state.user?.role === "admin"
          ? `
            <span class="nav-more" data-library-menu-id="${library.id}" role="button" tabindex="0" title="Opções da biblioteca">⋮</span>
            ${state.openLibraryMenuId === library.id ? renderLibraryContextMenu(library) : ""}
          `
          : ""
      }
    </button>
  `;
}

function renderVaultNavButton(): string {
  const active = state.activeView === "vault" ? " active" : "";
  return `
    <button class="nav-button library-button${active}" data-nav-view="vault" title="Cofre pessoal">
      <span class="nav-icon" aria-hidden="true">${renderSidebarIcon(state.vaultUnlocked ? "vaultOpen" : "vaultClosed", "Cofre pessoal")}</span>
      <span class="nav-label">Cofre pessoal</span>
      <span class="nav-more vault-nav-more" data-vault-menu role="button" tabindex="0" title="Opções do cofre">⋮</span>
      ${state.vaultMenuOpen ? renderVaultContextMenu() : ""}
    </button>
  `;
}

function renderVaultContextMenu(): string {
  return `
    <span class="library-context-menu" role="menu" aria-label="Opções do cofre pessoal">
      ${
        state.vaultUnlocked
          ? `<span class="library-menu-item" id="lock-vault-sidebar-button" role="menuitem">Bloquear cofre</span>`
          : `<span class="library-menu-item disabled" role="menuitem">Cofre bloqueado</span>`
      }
    </span>
  `;
}

function renderLibraryContextMenu(library: Library): string {
  return `
    <span class="library-context-menu" role="menu" aria-label="Opções de ${escapeHtml(library.name)}">
      <span class="library-menu-item" data-scan-library-id="${library.id}" role="menuitem">Scan Library</span>
      <span class="library-menu-item disabled" role="menuitem">Reading Profiles ›</span>
      <span class="library-menu-item disabled" role="menuitem">Others ›</span>
      <span class="library-menu-item disabled" role="menuitem">Settings</span>
    </span>
  `;
}

function renderMainView(activeLibrary: Library | undefined, contents: ContentItem[], activeSeries: ContentItem | null): string {
  if (activeSeries) {
    return renderSeriesView(activeSeries, activeLibrary);
  }

  if (state.activeView === "library") {
    return renderLibraryView(activeLibrary, contents);
  }

  if (state.activeView === "bookmarks") {
    const contentIds = new Set(state.bookmarks.map((bookmark) => bookmark.contentId));
    return renderContentListView("Marcadores", "Obras com páginas marcadas por este usuário.", getContentsByIds([...contentIds]));
  }

  if (state.activeView === "home") {
    return renderHomeView();
  }

  if (state.activeView === "all") {
    const contents = getFilteredHomeContents();
    return `
      <section class="section-heading">
        <div>
          <h2>Todos os títulos</h2>
          <p class="muted">Todos os conteúdos disponíveis nas bibliotecas permitidas.</p>
        </div>
        <span class="muted">${contents.length} títulos</span>
      </section>
      ${contents.length ? `<section class="content-grid">${contents.map((content, index) => renderSeriesCard(content, `all-${content.id}-${index}`)).join("")}</section>` : state.search ? renderNoSearchResults() : renderEmptyMedia()}
    `;
  }

  if (state.activeView === "vault") {
    return renderVaultView();
  }

  if (state.activeView === "want") {
    return renderContentListView("Quero ler", "Obras salvas para ler depois.", getContentsByIds(state.wantToRead));
  }

  if (state.activeView === "lists") {
    return renderContentListView("Lista de leitura", "Fila de leitura pessoal na ordem em que as obras foram adicionadas.", getContentsByIds(state.readingList));
  }

  if (state.activeView === "collections") {
    return renderCollectionsView();
  }

  if (state.activeView === "people") {
    return renderPeopleView();
  }

  if (state.activeView === "profile") {
    return renderProfileView();
  }

  if (state.activeView === "settings") {
    return renderSettingsView();
  }

  const labels: Record<AppState["activeView"], string> = {
    home: "Início",
    want: "Quero ler",
    collections: "Coleções",
    lists: "Listas de leitura",
    bookmarks: "Marcadores",
    all: "Todos os títulos",
    vault: "Cofre pessoal",
    people: "Pessoas",
    library: "Biblioteca",
    profile: "Perfil",
    settings: "Configurações"
  };

  return renderPlaceholderView(labels[state.activeView], "Esta área está reservada para a próxima etapa da interface.");
}

function renderSettingsView(): string {
  const sectionTitle = getSettingsSectionTitle();

  return `
    <section class="settings-content">
      <h1>${escapeHtml(sectionTitle)}</h1>
      ${renderSettingsSection()}
    </section>
  `;
}

function renderVaultView(): string {
  if (!state.vaultUnlocked) {
    return `
      <section class="settings-content vault-content">
        <h1>Cofre pessoal</h1>
        <p class="settings-lead">Confirme sua senha para acessar bibliotecas pessoais ocultas.</p>
        <form class="vault-unlock-form" id="vault-unlock-form">
          <label class="form-row">
            <span>Senha</span>
            <input class="input" name="password" type="password" autocomplete="current-password" required />
          </label>
          <p class="error">${escapeHtml(state.vaultError)}</p>
          <button class="button" type="submit">Desbloquear cofre</button>
        </form>
      </section>
    `;
  }

  const contents = state.contents.filter((content) => state.personalLibraries.some((library) => library.id === content.libraryId));
  return `
    <section class="section-heading">
      <div>
        <h2>Cofre pessoal</h2>
        <p class="muted">Bibliotecas pessoais ficam ocultas fora desta área.</p>
      </div>
      <div class="vault-heading-actions">
        <button class="icon-button vault-lock-button" id="lock-vault-button" type="button" title="Bloquear cofre" aria-label="Bloquear cofre">${renderSidebarIcon("vaultClosed", "Bloquear cofre")}</button>
        <button class="button" id="add-personal-library-button" type="button">+ Biblioteca pessoal</button>
      </div>
    </section>
    ${
      state.personalLibraries.length
        ? `<section class="library-vault-list">${state.personalLibraries.map(renderPersonalLibraryRow).join("")}</section>`
        : `<p class="empty">Nenhuma biblioteca pessoal cadastrada.</p>`
    }
    ${contents.length ? `<section class="content-grid">${contents.map((content, index) => renderSeriesCard(content, `vault-${content.id}-${index}`)).join("")}</section>` : ""}
  `;
}

function renderPersonalLibraryRow(library: Library): string {
  const contentCount = state.contents.filter((content) => content.libraryId === library.id).length;
  return `
    <article class="personal-library-row">
      <button class="personal-library-main" data-library-id="${escapeHtml(library.id)}" type="button">
        <span class="nav-icon" aria-hidden="true">${renderIcon("lock")}</span>
        <strong>${escapeHtml(library.name)}</strong>
        <span>${contentCount} títulos</span>
      </button>
      <div class="personal-library-actions">
        <button class="icon-button" data-edit-personal-library="${escapeHtml(library.id)}" type="button" title="Editar biblioteca" aria-label="Editar biblioteca">${renderSidebarIcon("pencil", "Editar biblioteca")}</button>
        <button class="icon-button danger" data-delete-personal-library="${escapeHtml(library.id)}" type="button" title="Apagar biblioteca" aria-label="Apagar biblioteca">${renderSidebarIcon("trash", "Apagar biblioteca")}</button>
      </div>
    </article>
  `;
}

function renderProfileView(): string {
  const user = state.user;
  const favorites = getContentsByIds(user?.favoriteContentIds ?? []);
  return `
    <section class="profile-page">
      <div class="profile-hero">
        ${renderAvatar(user, "profile-avatar")}
        <div class="profile-hero-info">
          <h2>${escapeHtml(user?.nickname || user?.displayName || "Usuário")}</h2>
          <p>${escapeHtml(user?.biography || "Sem biografia cadastrada.")}</p>
          <span>${escapeHtml(user?.location || "Local não informado")}</span>
        </div>
        <button class="icon-button profile-edit-button" id="edit-profile-button" type="button" title="Editar perfil">${renderSidebarIcon("pencil", "Editar perfil")}</button>
      </div>
      ${state.profileEditing ? renderProfileForm(favorites) : ""}
      <section class="settings-panel">
        <div class="series-section-heading">
          <h2>Obras preferidas</h2>
          <span>${favorites.length}/3</span>
        </div>
        ${
          favorites.length
            ? `<div class="profile-favorites">${favorites.map(renderProfileFavorite).join("")}</div>`
            : `<p class="empty compact">Nenhuma obra preferida fixada.</p>`
        }
      </section>
      <section class="settings-panel">
        <div class="series-section-heading">
          <h2>Minhas Reviews</h2>
          <span>${state.profileReviews.length}</span>
        </div>
        ${
          state.profileReviews.length
            ? `<div class="profile-review-list">${state.profileReviews.map(renderProfileReview).join("")}</div>`
            : `<p class="empty compact">Nenhuma review publicada ainda.</p>`
        }
      </section>
    </section>
  `;
}

function renderProfileForm(favorites: ContentItem[]): string {
  const user = state.user;
  const selectedIds = user?.favoriteContentIds ?? [];

  return `
    <form class="profile-form" id="profile-form">
      <section class="settings-panel">
        <div class="series-section-heading">
          <h2>Editar perfil</h2>
          <button class="button secondary" id="cancel-profile-edit" type="button">Cancelar</button>
        </div>
        <label class="form-row">
            <span>Avatar</span>
            <input class="input" id="profile-avatar-input" name="avatar" type="file" accept="image/*" />
        </label>
        ${user?.avatarUrl ? `<button class="button secondary" id="remove-profile-avatar" type="button">Remover avatar</button>` : ""}
        <label class="form-row">
            <span>Nickname</span>
            <input class="input" name="nickname" maxlength="40" value="${escapeHtml(user?.nickname ?? "")}" placeholder="Seu nome público" />
        </label>
        <label class="form-row">
            <span>Biografia</span>
            <textarea class="input" name="biography" maxlength="280" rows="4" placeholder="Conte um pouco sobre você">${escapeHtml(user?.biography ?? "")}</textarea>
        </label>
        <label class="form-row">
            <span>Local onde mora</span>
            <input class="input" name="location" maxlength="80" value="${escapeHtml(user?.location ?? "")}" placeholder="Cidade, Estado" />
        </label>
        <label class="form-row">
            <span>3 obras preferidas</span>
            <input class="input" id="profile-favorite-search" value="${escapeHtml(state.profileFavoriteSearch)}" placeholder="Pesquisar obra para fixar" autocomplete="off" />
        </label>
        <div class="profile-favorite-picker">
          <div class="profile-favorite-selected">
              ${
                favorites.length
                  ? favorites.map((content) => `
                      <span class="profile-favorite-chip">
                        ${escapeHtml(content.title)}
                        <button data-remove-profile-favorite="${escapeHtml(content.id)}" type="button" aria-label="Remover ${escapeHtml(content.title)}">×</button>
                      </span>
                    `).join("")
                  : `<span class="muted">Nenhuma obra selecionada.</span>`
              }
          </div>
          ${renderProfileFavoriteResults(selectedIds)}
          ${selectedIds.map((contentId) => `<input type="hidden" name="favoriteContentIds" value="${escapeHtml(contentId)}" />`).join("")}
        </div>
        ${state.profileError ? `<p class="error">${escapeHtml(state.profileError)}</p>` : ""}
        <div class="profile-actions">
          <button class="button" type="submit">Salvar perfil</button>
        </div>
      </section>
    </form>
  `;
}

function renderProfileFavorite(content: ContentItem): string {
  return `
    <article class="profile-favorite-card">
      ${
        content.coverUrl
          ? `<img src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" />`
          : `<div class="cover-placeholder">${escapeHtml(content.title.slice(0, 1).toUpperCase())}</div>`
      }
      <strong>${escapeHtml(content.title)}</strong>
    </article>
  `;
}

function renderProfileReview(review: PublicContentReview): string {
  const content = findContentById(review.contentId);
  return `
    <article class="profile-review-card">
      ${
        content?.coverUrl
          ? `<img src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" />`
          : `<div class="cover-placeholder">${escapeHtml((content?.title ?? "R").slice(0, 1).toUpperCase())}</div>`
      }
      <div>
        <div class="profile-review-header">
          <strong>${escapeHtml(content?.title ?? "Obra indisponível")}</strong>
          <span>${escapeHtml(review.rating.toFixed(1))}</span>
        </div>
        <p>${escapeHtml(review.comment)}</p>
        <small>${escapeHtml(new Date(review.updatedAt).toLocaleString("pt-BR"))}</small>
      </div>
    </article>
  `;
}

function renderProfileFavoriteResults(selectedIds: string[]): string {
  const selected = new Set(selectedIds);
  const query = normalizeText(state.profileFavoriteSearch);
  if (!query) {
    return `<p class="empty compact">Digite para buscar uma obra.</p>`;
  }

  const results = getAvailableContents()
    .filter((content) => !selected.has(content.id) && normalizeText(content.title).includes(query))
    .slice(0, 8);

  if (selected.size >= 3) {
    return `<p class="empty compact">Limite de 3 obras preferidas atingido.</p>`;
  }

  if (results.length === 0) {
    return `<p class="empty compact">Nenhuma obra encontrada.</p>`;
  }

  return `
    <div class="profile-favorite-results">
      ${results.map((content) => `
        <button class="profile-favorite-result" data-add-profile-favorite="${escapeHtml(content.id)}" type="button">
          ${
            content.coverUrl
              ? `<img src="${escapeHtml(content.coverUrl)}" alt="" />`
              : `<span>${escapeHtml(content.title.slice(0, 1).toUpperCase())}</span>`
          }
          <strong>${escapeHtml(content.title)}</strong>
        </button>
      `).join("")}
    </div>
  `;
}

function renderSettingsButton(section: AppState["settingsSection"], label: string): string {
  const active = state.settingsSection === section ? " active" : "";
  return `<button class="settings-nav-button${active}" data-settings-section="${section}" type="button">${escapeHtml(label)}</button>`;
}

function renderServerSectionButton(section: AppState["serverSection"], label: string): string {
  const active = state.settingsSection === "server" && state.serverSection === section ? " active" : "";
  return `<button class="settings-nav-button${active}" data-server-section="${section}" type="button">${escapeHtml(label)}</button>`;
}

function getSettingsSectionTitle(): string {
  const titles: Record<AppState["settingsSection"], string> = {
    account: "Conta",
    preferences: "Preferências",
    server: state.serverSection === "users" ? "Usuários" : state.serverSection === "vault" ? "Cofre pessoal" : "Bibliotecas"
  };

  return titles[state.settingsSection];
}

function renderSettingsSection(): string {
  if (state.settingsSection === "server") {
    if (state.user?.role !== "admin") {
      return `<p class="empty">Esta área é exclusiva para administradores.</p>`;
    }
    if (state.serverSection === "users") return renderUsersSettings();
    if (state.serverSection === "vault") return renderVaultSettings();
    return renderLibrariesSettings();
  }

  if (state.settingsSection === "account") {
    return `
      <p class="settings-lead">Dados básicos da conta logada. Personalização completa fica para a próxima etapa.</p>
      <div class="settings-panel">
        <div class="settings-row">
          <span>Usuário</span>
          <strong>${escapeHtml(state.user?.displayName ?? "Usuário")}</strong>
        </div>
        <div class="settings-row">
          <span>Tipo</span>
          <strong>${escapeHtml(state.user?.role === "admin" ? "Administrador" : "Usuário padrão")}</strong>
        </div>
      </div>
    `;
  }

  return `
    <p class="settings-lead">Preferências globais vinculadas à sua conta.</p>
    <div class="settings-panel">
      <label class="toggle-row">
        <input type="checkbox" checked />
        <span>Usar modo escuro</span>
      </label>
      <label class="toggle-row">
        <input type="checkbox" />
        <span>Reduzir animações</span>
      </label>
    </div>
  `;
}

function renderLibrariesSettings(): string {
  return `
    <div class="settings-toolbar">
      <p class="settings-lead">Bibliotecas cadastradas pelo administrador. Cada biblioteca aponta para uma pasta real montada no servidor.</p>
      <button class="button" id="add-library-button" type="button">+ Adicionar biblioteca</button>
    </div>
    ${state.scanMessage ? `<p class="scan-message">${escapeHtml(state.scanMessage)}</p>` : ""}
    ${
      state.libraries.length
        ? `<div class="library-settings-list">${state.libraries.map(renderLibrarySettingsRow).join("")}</div>`
        : `<p class="empty">Nenhuma biblioteca cadastrada. Crie uma biblioteca apontando para uma pasta dentro de /media.</p>`
    }
  `;
}

function renderUsersSettings(): string {
  return `
    <div class="settings-toolbar">
      <p class="settings-lead">Usuários cadastrados no sistema. Aqui o administrador define acesso, permissões e convites.</p>
      <div class="settings-toolbar-actions">
        <button class="button secondary" id="invite-user-button" type="button">+ Convite</button>
        <button class="button" id="add-user-button" type="button">+ Adicionar usuário</button>
      </div>
    </div>
    ${state.adminUserInviteUrl ? renderInviteBanner(state.adminUserInviteUrl) : ""}
    ${
      state.adminUsers.length
        ? `<div class="user-table">${state.adminUsers.map(renderUserRow).join("")}</div>`
        : `<p class="empty">Nenhum usuário cadastrado.</p>`
    }
  `;
}

function renderVaultSettings(): string {
  return `
    <form class="settings-panel vault-settings-form" id="vault-settings-form">
      <p class="settings-lead">Defina por quanto tempo o cofre pessoal fica aberto sem atividade antes de bloquear automaticamente.</p>
      <label class="form-row">
        <span>Tempo sem atividade em minutos</span>
        <input class="input" name="vaultTimeoutMinutes" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(state.vaultSettingsDraft)}" required />
      </label>
      ${state.vaultSettingsError ? `<p class="error">${escapeHtml(state.vaultSettingsError)}</p>` : ""}
      ${state.vaultSettingsMessage ? `<p class="scan-message">${escapeHtml(state.vaultSettingsMessage)}</p>` : ""}
      <div class="settings-actions">
        <button class="button" type="submit">Salvar configuração</button>
      </div>
    </form>
  `;
}

function renderInviteBanner(inviteUrl: string): string {
  return `
    <div class="invite-banner">
      <strong>Link de convite gerado</strong>
      <div class="invite-banner-row">
        <input class="input" value="${escapeHtml(inviteUrl)}" readonly />
        <button class="button secondary" data-copy-invite type="button">Copiar</button>
      </div>
    </div>
  `;
}

function renderUserRow(user: PublicUser): string {
  const libraryNames = user.allowedLibraryIds
    .map((libraryId) => state.libraries.find((library) => library.id === libraryId)?.name)
    .filter((value): value is string => Boolean(value));
  return `
    <article class="user-row">
      <div class="user-main">
        ${renderAvatar(user, "avatar user-avatar")}
        <div>
          <strong>${escapeHtml(user.displayName || user.username)}</strong>
          <p>${escapeHtml(user.email || "Sem e-mail")}</p>
          <small>${escapeHtml(user.lastActiveAt ? `Ultimo acesso: ${new Date(user.lastActiveAt).toLocaleString("pt-BR")}` : "Nunca acessou")}</small>
        </div>
      </div>
      <div class="user-libraries">
        ${libraryNames.length ? libraryNames.map((name) => `<span>${escapeHtml(name)}</span>`).join("") : `<span class="muted">Sem bibliotecas</span>`}
      </div>
      <div class="user-permissions">
        <span class="${user.canLogin ? "active" : ""}">Login</span>
        <span class="${user.canDownload ? "active" : ""}">Download</span>
        <span class="${user.canChangePassword ? "active" : ""}">Senha</span>
      </div>
      <div class="user-actions">
        <button class="icon-button" data-edit-user="${escapeHtml(user.id)}" type="button" title="Editar usuário" aria-label="Editar usuário">${renderSidebarIcon("pencil", "Editar usuário")}</button>
        <button class="icon-button danger" data-delete-user="${escapeHtml(user.id)}" type="button" title="Apagar usuário" aria-label="Apagar usuário">${renderSidebarIcon("trash", "Apagar usuário")}</button>
      </div>
    </article>
  `;
}

function renderLibrarySettingsRow(library: Library): string {
  const contentCount = state.homeContents.filter((content) => content.libraryId === library.id).length;
  return `
    <article class="library-settings-row">
      <div>
        <strong>${escapeHtml(library.name)}</strong>
        <p>${escapeHtml(library.path)}</p>
      </div>
      <span>${escapeHtml(library.kind)}</span>
      <span>${contentCount} títulos</span>
      <button class="button secondary" type="button" data-scan-library-id="${library.id}">Escanear</button>
    </article>
  `;
}

function renderLibraryModal(): string {
  const isEditing = Boolean(state.editingLibraryId);
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel library-modal" role="dialog" aria-modal="true" aria-labelledby="library-modal-title">
        <header class="modal-header">
          <h2 id="library-modal-title">${
            isEditing
              ? (state.libraryDraft.isPersonal ? "Editar biblioteca pessoal" : "Editar biblioteca")
              : (state.libraryDraft.isPersonal ? "Adicionar biblioteca pessoal" : "Adicionar biblioteca")
          }</h2>
          <button class="icon-button" id="close-library-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <div class="modal-body">
          <nav class="library-modal-tabs" aria-label="Etapas da biblioteca">
            ${renderLibraryModalStepButton("general", "Geral")}
            ${renderLibraryModalStepButton("folder", "Pasta")}
            ${renderLibraryModalStepButton("cover", "Capa")}
            ${renderLibraryModalStepButton("advanced", "Avançado")}
          </nav>
          <div class="library-modal-content">
            ${renderLibraryModalStep()}
            <p class="error">${escapeHtml(state.libraryModalError)}</p>
          </div>
        </div>
        <footer class="modal-actions">
          <button class="button secondary" id="library-back-button" type="button" ${state.libraryModalStep === "general" ? "disabled" : ""}>Voltar</button>
          <button class="button secondary" id="cancel-library-modal" type="button">Cancelar</button>
          ${
            state.libraryModalStep === "advanced"
              ? `<button class="button" id="create-library-button" type="button">${isEditing ? "Salvar biblioteca" : "Criar biblioteca"}</button>`
              : `<button class="button" id="library-next-button" type="button">Próximo</button>`
          }
        </footer>
      </section>
    </div>
  `;
}

function renderLibraryModalStepButton(step: AppState["libraryModalStep"], label: string): string {
  const active = state.libraryModalStep === step ? " active" : "";
  return `<button class="library-step-button${active}" data-library-modal-step="${step}" type="button">${escapeHtml(label)}</button>`;
}

function renderLibraryModalStep(): string {
  if (state.libraryModalStep === "folder") {
    return renderLibraryFolderStep();
  }

  if (state.libraryModalStep === "cover") {
    return `
      <p class="modal-help">A capa será detectada automaticamente pela primeira imagem encontrada dentro de cada obra.</p>
      <p class="modal-help">Configuração manual de capa da biblioteca será implementada depois.</p>
    `;
  }

  if (state.libraryModalStep === "advanced") {
    return `
      <p class="modal-help">Revise os dados antes de criar a biblioteca.</p>
      <div class="review-list">
        <span>Nome</span><strong>${escapeHtml(state.libraryDraft.name || "Não definido")}</strong>
        <span>Tipo</span><strong>${escapeHtml(getLibraryKindLabel(state.libraryDraft.kind))}</strong>
        <span>Visibilidade</span><strong>${state.libraryDraft.isPersonal ? "Cofre pessoal" : "Biblioteca pública"}</strong>
        <span>Pasta</span><strong>${escapeHtml(state.libraryDraft.path || "Não selecionada")}</strong>
      </div>
    `;
  }

  return `
    <label class="form-row">
      <span>Nome</span>
      <input class="input" id="library-name-input" value="${escapeHtml(state.libraryDraft.name)}" placeholder="Mangás" required />
    </label>
    <label class="form-row">
      <span>Tipo</span>
      <select class="input" id="library-kind-input" required>
        <option value="manga" ${state.libraryDraft.kind === "manga" ? "selected" : ""}>Mangás</option>
        <option value="book" ${state.libraryDraft.kind === "book" ? "selected" : ""}>Livros</option>
        <option value="manhwa" ${state.libraryDraft.kind === "manhwa" ? "selected" : ""}>Manhwas</option>
      </select>
    </label>
    <p class="modal-help">${state.libraryDraft.isPersonal ? "Esta biblioteca ficará oculta fora do cofre pessoal." : "Escolha o nome e o tipo da biblioteca. A pasta real será selecionada na próxima etapa."}</p>
  `;
}

function renderLibraryFolderStep(): string {
  const browser = state.folderBrowser;
  return `
    <p class="modal-help">Selecione uma pasta real dentro da raiz de mídia do servidor.</p>
    <label class="form-row">
      <span>Pasta selecionada</span>
      <input class="input" id="library-path-input" value="${escapeHtml(state.libraryDraft.path)}" placeholder="Selecione uma pasta abaixo" readonly />
    </label>
    <div class="folder-browser">
      <div class="folder-browser-header">
        <strong>${escapeHtml(browser?.path ?? "Carregando...")}</strong>
        <button class="button secondary" type="button" id="select-current-folder" ${browser ? "" : "disabled"}>Usar esta pasta</button>
      </div>
      <div class="folder-list">
        ${browser?.parent ? `<button class="folder-row" data-folder-path="${escapeHtml(browser.parent)}" type="button">..</button>` : ""}
        ${
          browser
            ? browser.directories.length
              ? browser.directories.map((directory) => `<button class="folder-row" data-folder-path="${escapeHtml(directory.path)}" type="button">${escapeHtml(directory.name)}</button>`).join("")
              : `<p class="empty compact">Esta pasta não possui subpastas.</p>`
            : `<p class="empty compact">Lendo pastas...</p>`
        }
      </div>
    </div>
  `;
}

function getLibraryKindLabel(kind: LibraryKind): string {
  const labels: Record<LibraryKind, string> = {
    manga: "Mangás",
    book: "Livros",
    manhwa: "Manhwas",
    other: "Outros"
  };

  return labels[kind];
}

function getNextLibraryModalStep(step: AppState["libraryModalStep"]): AppState["libraryModalStep"] {
  const steps: AppState["libraryModalStep"][] = ["general", "folder", "cover", "advanced"];
  return steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)] ?? "advanced";
}

function getPreviousLibraryModalStep(step: AppState["libraryModalStep"]): AppState["libraryModalStep"] {
  const steps: AppState["libraryModalStep"][] = ["general", "folder", "cover", "advanced"];
  return steps[Math.max(steps.indexOf(step) - 1, 0)] ?? "general";
}

function resetLibraryDraft(): void {
  state.libraryModalStep = "general";
  state.libraryModalError = "";
  state.editingLibraryId = null;
  state.libraryDraft = { name: "", kind: "manga", path: "", isPersonal: false };
  state.folderBrowser = null;
}

async function loadFolderBrowser(path?: string): Promise<void> {
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  } else if (state.libraryDraft.isPersonal) {
    params.set("scope", "vault");
  }
  const query = params.toString() ? `?${params.toString()}` : "";
  state.folderBrowser = await api<{ path: string; parent: string | null; directories: Array<{ name: string; path: string }> }>(`/api/admin/folders${query}`);
}

async function openLibraryModal(): Promise<void> {
  resetLibraryDraft();
  state.libraryModalOpen = true;
  renderShell();
  try {
    await loadFolderBrowser();
    renderShell();
  } catch (error) {
    state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar as pastas.";
    renderShell();
  }
}

async function openPersonalLibraryModal(): Promise<void> {
  resetLibraryDraft();
  state.libraryDraft.isPersonal = true;
  state.libraryModalOpen = true;
  renderShell();
  try {
    await loadFolderBrowser();
    renderShell();
  } catch (error) {
    state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar as pastas.";
    renderShell();
  }
}

async function openPersonalLibraryEditModal(libraryId: string): Promise<void> {
  const library = state.personalLibraries.find((item) => item.id === libraryId);
  if (!library) {
    return;
  }

  resetLibraryDraft();
  state.editingLibraryId = library.id;
  state.libraryDraft = {
    name: library.name,
    kind: library.kind,
    path: library.path,
    isPersonal: true
  };
  state.libraryModalOpen = true;
  renderShell();
  try {
    await loadFolderBrowser(library.path);
    renderShell();
  } catch (error) {
    state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar as pastas.";
    renderShell();
  }
}

function resetCollectionDraft(): void {
  state.collectionModalError = "";
  state.collectionDraft = { name: "", description: "" };
}

function openCollectionModal(): void {
  resetCollectionDraft();
  state.collectionModalOpen = true;
  renderShell();
}

function closeCollectionModal(): void {
  state.collectionModalOpen = false;
  resetCollectionDraft();
  renderShell();
}

async function openCollectionShareModal(collectionId: string): Promise<void> {
  const collection = state.collections.find((item) => item.id === collectionId);
  if (!collection || collection.userId !== state.user?.id) {
    return;
  }

  state.sharingCollectionId = collectionId;
  state.collectionShareModalOpen = true;
  state.collectionShareError = "";
  renderShell();

  try {
    const { users } = await api<{ users: PublicUser[] }>("/api/users");
    state.collectionShareUsers = users;
    renderShell();
  } catch (error) {
    state.collectionShareError = error instanceof Error ? error.message : "Não foi possível carregar usuários.";
    renderShell();
  }
}

function closeCollectionShareModal(): void {
  state.collectionShareModalOpen = false;
  state.collectionShareError = "";
  state.collectionShareUsers = [];
  state.sharingCollectionId = null;
  renderShell();
}

function openCollectionDeleteModal(collectionId: string): void {
  const collection = state.collections.find((item) => item.id === collectionId);
  if (!collection || collection.userId !== state.user?.id) {
    return;
  }

  state.deletingCollectionId = collectionId;
  state.collectionDeleteError = "";
  renderShell();
}

function closeCollectionDeleteModal(): void {
  state.deletingCollectionId = null;
  state.collectionDeleteError = "";
  renderShell();
}

function resetAdminUserDraft(): void {
  state.adminUserDraft = {
    email: "",
    displayName: "",
    username: "",
    password: "",
    allowedLibraryIds: [],
    canLogin: true,
    canDownload: true,
    canChangePassword: true
  };
  state.adminUserModalError = "";
  state.adminUserInviteUrl = "";
  state.adminUserEditingId = null;
}

function openAdminUserModal(mode: AppState["adminUserModalMode"], userId: string | null = null): void {
  state.adminUserModalMode = mode;
  state.adminUserModalOpen = true;
  state.adminUserModalError = "";
  state.adminUserInviteUrl = "";
  state.adminUserEditingId = userId;

  if (mode === "edit" && userId) {
    const user = state.adminUsers.find((item) => item.id === userId);
    if (user) {
      state.adminUserDraft = {
        email: user.email,
        displayName: user.displayName,
        username: user.username,
        password: "",
        allowedLibraryIds: [...user.allowedLibraryIds],
        canLogin: user.canLogin,
        canDownload: user.canDownload,
        canChangePassword: user.canChangePassword
      };
    }
  } else {
    resetAdminUserDraft();
  }

  renderShell();
}

function closeAdminUserModal(): void {
  state.adminUserModalOpen = false;
  resetAdminUserDraft();
  renderShell();
}

function openAdminUserDeleteModal(userId: string): void {
  state.adminUserDeleteId = userId;
  state.adminUserModalError = "";
  renderShell();
}

function closeAdminUserDeleteModal(): void {
  state.adminUserDeleteId = null;
  state.adminUserModalError = "";
  renderShell();
}

function syncAdminUserDraftFromInputs(form: HTMLFormElement): void {
  const formData = new FormData(form);
  state.adminUserDraft = {
    email: String(formData.get("email") ?? ""),
    displayName: String(formData.get("displayName") ?? ""),
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
    allowedLibraryIds: formData.getAll("allowedLibraryIds").map((value) => String(value)),
    canLogin: formData.get("canLogin") === "on",
    canDownload: formData.get("canDownload") === "on",
    canChangePassword: formData.get("canChangePassword") === "on"
  };
}

async function submitAdminUserForm(form: HTMLFormElement): Promise<void> {
  syncAdminUserDraftFromInputs(form);
  const mode = state.adminUserModalMode;
  const payload = {
    email: state.adminUserDraft.email.trim(),
    displayName: state.adminUserDraft.displayName.trim(),
    username: state.adminUserDraft.username.trim(),
    password: state.adminUserDraft.password,
    allowedLibraryIds: state.adminUserDraft.allowedLibraryIds,
    canLogin: state.adminUserDraft.canLogin,
    canDownload: state.adminUserDraft.canDownload,
    canChangePassword: state.adminUserDraft.canChangePassword
  };

  try {
    state.adminUserModalError = "";
    state.adminUserInviteUrl = "";
    if (mode === "invite") {
      const { inviteUrl } = await api<{ inviteUrl: string }>("/api/admin/invites", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      state.adminUserInviteUrl = inviteUrl;
      state.adminUserModalOpen = true;
      await refreshAdminUsers();
      renderShell();
      return;
    }

    if (mode === "edit" && state.adminUserEditingId) {
      await api<{ user: PublicUser }>(`/api/admin/users/${encodeURIComponent(state.adminUserEditingId)}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
    } else {
      await api<{ user: PublicUser }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }
    state.adminUserModalOpen = false;
    resetAdminUserDraft();
    await refreshAdminUsers();
    renderShell();
  } catch (error) {
    state.adminUserModalError = error instanceof Error ? error.message : "Não foi possível salvar o usuário.";
    renderShell();
  }
}

async function createLinkOnlyInvite(form: HTMLFormElement): Promise<void> {
  syncAdminUserDraftFromInputs(form);

  try {
    state.adminUserModalError = "";
    state.adminUserInviteUrl = "";
    const { inviteUrl } = await api<{ inviteUrl: string }>("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify({
        linkOnly: true,
        allowedLibraryIds: state.adminUserDraft.allowedLibraryIds,
        canLogin: true,
        canDownload: true,
        canChangePassword: false
      })
    });
    state.adminUserInviteUrl = inviteUrl;
    state.adminUserModalOpen = true;
    renderShell();
  } catch (error) {
    state.adminUserModalError = error instanceof Error ? error.message : "Não foi possível gerar o link de convite.";
    renderShell();
  }
}

async function deleteAdminUser(): Promise<void> {
  if (!state.adminUserDeleteId) {
    return;
  }

  try {
    state.adminUserModalError = "";
    await api<void>(`/api/admin/users/${encodeURIComponent(state.adminUserDeleteId)}`, { method: "DELETE" });
    state.adminUserDeleteId = null;
    await refreshAdminUsers();
    renderShell();
  } catch (error) {
    state.adminUserModalError = error instanceof Error ? error.message : "Não foi possível apagar o usuário.";
    renderShell();
  }
}

async function refreshAdminUsers(): Promise<void> {
  if (state.user?.role !== "admin") {
    return;
  }

  const { users } = await api<{ users: PublicUser[] }>("/api/admin/users");
  state.adminUsers = users;
}

async function deleteCollection(): Promise<void> {
  const collectionId = state.deletingCollectionId;
  if (!collectionId) {
    return;
  }

  try {
    state.collectionDeleteError = "";
    await api<void>(`/api/collections/${encodeURIComponent(collectionId)}`, { method: "DELETE" });
    state.deletingCollectionId = null;
    await refreshUserLists();
    renderShell();
  } catch (error) {
    state.collectionDeleteError = error instanceof Error ? error.message : "Não foi possível apagar a coleção.";
    renderShell();
  }
}

async function readAvatarInput(input: HTMLInputElement): Promise<string | null> {
  const file = input.files?.[0];
  if (!file) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(new Error("Não foi possível ler a imagem.")));
    reader.readAsDataURL(file);
  });
}

async function saveProfile(form: HTMLFormElement): Promise<void> {
  const formData = new FormData(form);
  const favoriteContentIds = formData.getAll("favoriteContentIds").map((value) => String(value)).slice(0, 3);
  const avatarInput = form.querySelector<HTMLInputElement>("#profile-avatar-input");

  try {
    state.profileError = "";
    const avatarFromInput = avatarInput ? await readAvatarInput(avatarInput) : null;
    const payload = await api<{ user: PublicUser }>("/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify({
        avatarUrl: avatarFromInput ?? state.user?.avatarUrl ?? "",
        nickname: String(formData.get("nickname") ?? ""),
        biography: String(formData.get("biography") ?? ""),
        location: String(formData.get("location") ?? ""),
        favoriteContentIds
      })
    });
    state.user = payload.user;
    state.profileEditing = false;
    state.profileFavoriteSearch = "";
    renderShell();
  } catch (error) {
    state.profileError = error instanceof Error ? error.message : "Não foi possível salvar o perfil.";
    renderShell();
  }
}

async function removeProfileAvatar(): Promise<void> {
  if (!state.user) {
    return;
  }

  try {
    state.profileError = "";
    const payload = await api<{ user: PublicUser }>("/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify({
        avatarUrl: "",
        nickname: state.user.nickname,
        biography: state.user.biography,
        location: state.user.location,
        favoriteContentIds: state.user.favoriteContentIds
      })
    });
    state.user = payload.user;
    renderShell();
  } catch (error) {
    state.profileError = error instanceof Error ? error.message : "Não foi possível remover o avatar.";
    renderShell();
  }
}

function addProfileFavorite(contentId: string): void {
  if (!state.user || !contentId || state.user.favoriteContentIds.includes(contentId) || state.user.favoriteContentIds.length >= 3) {
    return;
  }

  state.user = {
    ...state.user,
    favoriteContentIds: [...state.user.favoriteContentIds, contentId]
  };
  state.profileFavoriteSearch = "";
  renderShell();
}

function removeProfileFavorite(contentId: string): void {
  if (!state.user || !contentId) {
    return;
  }

  state.user = {
    ...state.user,
    favoriteContentIds: state.user.favoriteContentIds.filter((item) => item !== contentId)
  };
  renderShell();
}

async function saveCollectionSharing(form: HTMLFormElement): Promise<void> {
  const collectionId = state.sharingCollectionId;
  if (!collectionId) {
    return;
  }

  const formData = new FormData(form);
  const userIds = formData.getAll("userId").map((value) => String(value));

  try {
    state.collectionShareError = "";
    await api<{ collection: UserCollection }>(`/api/collections/${encodeURIComponent(collectionId)}/sharing`, {
      method: "PUT",
      body: JSON.stringify({ userIds })
    });
    state.collectionShareModalOpen = false;
    state.collectionShareUsers = [];
    state.sharingCollectionId = null;
    await refreshUserLists();
    renderShell();
  } catch (error) {
    state.collectionShareError = error instanceof Error ? error.message : "Não foi possível compartilhar a coleção.";
    renderShell();
  }
}

function syncCollectionDraftFromInputs(): void {
  const nameInput = document.querySelector<HTMLInputElement>("#collection-name-input");
  const descriptionInput = document.querySelector<HTMLTextAreaElement>("#collection-description-input");
  if (nameInput) {
    state.collectionDraft.name = nameInput.value;
  }
  if (descriptionInput) {
    state.collectionDraft.description = descriptionInput.value;
  }
}

async function createCollection(): Promise<void> {
  syncCollectionDraftFromInputs();
  const name = state.collectionDraft.name.trim();
  const description = state.collectionDraft.description.trim();

  if (!name) {
    state.collectionModalError = "Informe o nome da coleção.";
    renderShell();
    return;
  }

  try {
    state.collectionModalError = "";
    await api<{ collection: UserCollection }>("/api/collections", {
      method: "POST",
      body: JSON.stringify({ name, description })
    });
    state.collectionModalOpen = false;
    resetCollectionDraft();
    await refreshUserLists();
    renderShell();
  } catch (error) {
    state.collectionModalError = error instanceof Error ? error.message : "Não foi possível criar a coleção.";
    renderShell();
  }
}

function startCollectionEdit(collectionId: string): void {
  const collection = state.collections.find((item) => item.id === collectionId);
  if (!collection) {
    return;
  }

  state.editingCollectionId = collection.id;
  state.collectionEditError = "";
  state.collectionEditDraft = {
    name: collection.name,
    description: collection.description
  };
  renderShell();
}

function cancelCollectionEdit(): void {
  state.editingCollectionId = null;
  state.collectionEditError = "";
  state.collectionEditDraft = { name: "", description: "" };
  renderShell();
}

async function saveCollectionEdit(form: HTMLFormElement): Promise<void> {
  const collectionId = form.dataset.collectionEditForm ?? "";
  const formData = new FormData(form);
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!collectionId || !name) {
    state.collectionEditError = "Informe o nome da coleção.";
    renderShell();
    return;
  }

  try {
    state.collectionEditError = "";
    await api<{ collection: UserCollection }>(`/api/collections/${encodeURIComponent(collectionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name, description })
    });
    state.editingCollectionId = null;
    state.collectionEditDraft = { name: "", description: "" };
    await refreshUserLists();
    renderShell();
  } catch (error) {
    state.collectionEditError = error instanceof Error ? error.message : "Não foi possível salvar a coleção.";
    renderShell();
  }
}

function syncLibraryDraftFromInputs(): void {
  const nameInput = document.querySelector<HTMLInputElement>("#library-name-input");
  const kindInput = document.querySelector<HTMLSelectElement>("#library-kind-input");
  if (nameInput) {
    state.libraryDraft.name = nameInput.value;
  }
  if (kindInput) {
    state.libraryDraft.kind = kindInput.value as LibraryKind;
  }
}

function canMoveLibraryStep(nextStep: AppState["libraryModalStep"]): boolean {
  syncLibraryDraftFromInputs();
  state.libraryModalError = "";
  if ((nextStep === "folder" || nextStep === "cover" || nextStep === "advanced") && !state.libraryDraft.name.trim()) {
    state.libraryModalError = "Informe o nome da biblioteca.";
    return false;
  }
  if ((nextStep === "cover" || nextStep === "advanced") && !state.libraryDraft.path.trim()) {
    state.libraryModalError = "Selecione a pasta da biblioteca.";
    return false;
  }
  return true;
}

async function refreshLibraries(): Promise<void> {
  const { libraries } = await api<{ libraries: Library[] }>("/api/libraries");
  state.libraries = libraries;
  state.homeContents = await loadLibraryContents(libraries);
}

async function refreshPersonalVault(): Promise<void> {
  if (!state.vaultUnlocked) {
    return;
  }

  state.contents = await loadLibraryContents(state.personalLibraries);
}

async function deletePersonalLibrary(libraryId: string): Promise<void> {
  const library = state.personalLibraries.find((item) => item.id === libraryId);
  if (!library || !confirm(`Apagar a biblioteca "${library.name}" do cofre? Os arquivos da pasta não serão removidos.`)) {
    return;
  }

  try {
    await api<void>(`/api/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
    state.personalLibraries = state.personalLibraries.filter((item) => item.id !== libraryId);
    state.contents = state.contents.filter((content) => content.libraryId !== libraryId);
    if (state.activeLibraryId === libraryId) {
      state.activeLibraryId = null;
      state.activeSeriesId = null;
      state.reader = null;
      state.activeView = "vault";
    }
    renderShell();
  } catch (error) {
    state.vaultError = error instanceof Error ? error.message : "Não foi possível apagar a biblioteca.";
    renderShell();
  }
}

async function unlockPersonalVault(form: HTMLFormElement): Promise<void> {
  const formData = new FormData(form);
  try {
    state.vaultError = "";
    const payload = await api<{ libraries: Library[]; vaultToken: string; vaultTimeoutMinutes: number }>("/api/personal-vault/unlock", {
      method: "POST",
      body: JSON.stringify({ password: String(formData.get("password") ?? "") })
    });
    state.personalLibraries = payload.libraries;
    state.vaultToken = payload.vaultToken;
    state.vaultTimeoutMinutes = payload.vaultTimeoutMinutes;
    state.vaultSettingsDraft = String(payload.vaultTimeoutMinutes);
    state.vaultUnlocked = true;
    lastVaultTouchAt = Date.now();
    startVaultInactivityTimer();
    state.contents = await loadLibraryContents(payload.libraries);
    renderShell();
  } catch (error) {
    state.vaultError = error instanceof Error ? error.message : "Não foi possível desbloquear o cofre.";
    renderShell();
  }
}

async function lockPersonalVault(): Promise<void> {
  await api<void>("/api/personal-vault/lock", { method: "POST" }).catch(() => undefined);
  clearVaultInactivityTimer();
  state.vaultUnlocked = false;
  state.vaultToken = "";
  state.vaultError = "";
  state.vaultMenuOpen = false;
  lastVaultTouchAt = 0;
  state.personalLibraries = [];
  state.contents = [];
  state.activeLibraryId = null;
  state.activeSeriesId = null;
  state.reader = null;
  renderShell();
}

function clearVaultInactivityTimer(): void {
  if (vaultInactivityTimer) {
    window.clearTimeout(vaultInactivityTimer);
    vaultInactivityTimer = null;
  }
}

function startVaultInactivityTimer(): void {
  clearVaultInactivityTimer();
  if (!state.vaultUnlocked) {
    return;
  }

  vaultInactivityTimer = window.setTimeout(() => {
    void lockPersonalVault();
  }, state.vaultTimeoutMinutes * 60 * 1000);
}

function registerVaultActivity(): void {
  if (state.vaultUnlocked) {
    startVaultInactivityTimer();
    void touchPersonalVault();
  }
}

async function touchPersonalVault(): Promise<void> {
  if (!state.vaultUnlocked || vaultTouchInFlight) {
    return;
  }

  const minTouchIntervalMs = Math.max(30_000, Math.min(60_000, state.vaultTimeoutMinutes * 30_000));
  if (Date.now() - lastVaultTouchAt < minTouchIntervalMs) {
    return;
  }

  vaultTouchInFlight = true;
  try {
    const payload = await api<{ vaultToken: string; vaultTimeoutMinutes: number }>("/api/personal-vault/touch", { method: "POST" });
    state.vaultToken = payload.vaultToken;
    state.vaultTimeoutMinutes = payload.vaultTimeoutMinutes;
    state.vaultSettingsDraft = String(payload.vaultTimeoutMinutes);
    lastVaultTouchAt = Date.now();
  } catch {
    await lockPersonalVault();
  } finally {
    vaultTouchInFlight = false;
  }
}

async function saveVaultSettings(form: HTMLFormElement): Promise<void> {
  const formData = new FormData(form);
  const rawMinutes = String(formData.get("vaultTimeoutMinutes") ?? "").trim();
  const minutes = Number(rawMinutes);
  state.vaultSettingsDraft = rawMinutes;

  if (!Number.isInteger(minutes) || minutes < 1) {
    state.vaultSettingsError = "Informe um número inteiro maior que zero.";
    state.vaultSettingsMessage = "";
    renderShell();
    return;
  }

  try {
    const { settings } = await api<{ settings: ServerSettings }>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ vaultTimeoutMinutes: minutes })
    });
    state.vaultTimeoutMinutes = settings.vaultTimeoutMinutes;
    state.vaultSettingsDraft = String(settings.vaultTimeoutMinutes);
    state.vaultSettingsError = "";
    state.vaultSettingsMessage = "Configuração salva.";
    if (state.vaultUnlocked) {
      lastVaultTouchAt = 0;
      startVaultInactivityTimer();
      void touchPersonalVault();
    }
    renderShell();
  } catch (error) {
    state.vaultSettingsError = error instanceof Error ? error.message : "Não foi possível salvar a configuração.";
    state.vaultSettingsMessage = "";
    renderShell();
  }
}

async function scanLibraryById(libraryId: string): Promise<void> {
  const library = state.libraries.find((item) => item.id === libraryId);
  state.scanMessage = library ? `Escaneando ${library.name}...` : "Escaneando biblioteca...";
  renderShell();

  try {
    const { contents } = await api<{ contents: ContentItem[]; scannedAt: string }>(`/api/libraries/${libraryId}/scan`, {
      method: "POST"
    });
    await refreshLibraries();
    if (state.activeLibraryId === libraryId) {
      state.contents = contents;
    }
    state.scanMessage = library
      ? `${library.name}: ${contents.length} obras detectadas.`
      : `${contents.length} obras detectadas.`;
    renderShell();
  } catch (error) {
    state.scanMessage = error instanceof Error ? error.message : "Não foi possível escanear a biblioteca.";
    renderShell();
  }
}

function closeLibraryModal(): void {
  state.libraryModalOpen = false;
  resetLibraryDraft();
  renderShell();
}

function renderHomeView(): string {
  const contents = getFilteredHomeContents();
  const reading = state.progress
    .map((progress) => contents.find((content) => content.id === progress.contentId))
    .filter((content): content is ContentItem => Boolean(content));
  const onDeck = reading.length > 0 ? reading.slice(0, 8) : contents.slice(0, 5);
  const recentlyAdded = contents.slice(0, 12);

  if (state.search && contents.length === 0) {
    return renderNoSearchResults();
  }

  return `
    ${renderShelf("Lendo agora", onDeck, reading.length === 0 ? "Comece uma leitura para fixar progresso aqui." : "")}
    ${renderShelf("Séries adicionadas recentemente", recentlyAdded, "Monte suas mídias em /media para popular esta galeria.")}
  `;
}

function getFilteredHomeContents(): ContentItem[] {
  return filterContents(state.homeContents, state.search);
}

function filterContents(contents: ContentItem[], search: string): ContentItem[] {
  const parsed = parseSearch(search);
  const query = normalizeText(parsed.query);

  return contents.filter((content) => {
    if (parsed.libraryId && content.libraryId !== parsed.libraryId) {
      return false;
    }

    return query.length === 0 || normalizeText(content.title).includes(query);
  });
}

function parseSearch(search: string): ParsedSearch {
  const trimmed = search.trim();
  if (!trimmed.startsWith(">")) {
    return { libraryId: null, query: trimmed };
  }

  const scopedText = trimmed.slice(1).trimStart();
  const normalizedScopedText = normalizeText(scopedText);
  const library = state.libraries.find((item) => {
    const libraryName = normalizeText(item.name);
    return (
      normalizedScopedText === libraryName ||
      normalizedScopedText.startsWith(`${libraryName} `)
    );
  });

  if (!library) {
    return { libraryId: null, query: trimmed };
  }

  return {
    libraryId: library.id,
    query: scopedText.slice(library.name.length).trimStart()
  };
}

function getScopedLibraryOnly(search: string): Library | null {
  const parsed = parseSearch(search);
  if (!parsed.libraryId || parsed.query.length > 0) {
    return null;
  }

  return state.libraries.find((library) => library.id === parsed.libraryId) ?? null;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function getLibraryAutocomplete(value: string): string | null {
  const trimmedStart = value.trimStart();
  if (!trimmedStart.startsWith(">")) {
    return null;
  }

  const afterMarker = trimmedStart.slice(1);
  if (afterMarker.includes(" ")) {
    return null;
  }

  const partial = normalizeText(afterMarker);
  const library = state.libraries.find((item) => normalizeText(item.name).startsWith(partial));
  if (!library || normalizeText(library.name) === partial) {
    return null;
  }

  return `>${library.name} `;
}

function updateSearchSuggestion(input: HTMLInputElement): void {
  const ghost = document.querySelector<HTMLSpanElement>("#search-ghost");
  if (!ghost) {
    return;
  }

  const suggestion = getLibraryAutocomplete(input.value);
  if (!suggestion) {
    ghost.textContent = "";
    return;
  }

  const typed = input.value;
  const completion = suggestion.slice(typed.length);
  ghost.innerHTML = `
    <span class="search-ghost-typed">${escapeHtml(typed)}</span><span>${escapeHtml(completion)}</span><span class="search-tab-hint">Tab</span>
  `;
}

function renderShelf(title: string, contents: ContentItem[], emptyText: string): string {
  return `
    <section class="shelf">
      <h2>${escapeHtml(title)}</h2>
      ${
        contents.length
          ? `<div class="shelf-row">${contents.map((content, index) => renderSeriesCard(content, `shelf-${title}-${content.id}-${index}`)).join("")}</div>`
          : `<p class="empty">${escapeHtml(emptyText)}</p>`
      }
    </section>
  `;
}

function renderPlaceholderView(title: string, description: string): string {
  return `
    <section class="section-heading">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(description)}</p>
      </div>
    </section>
    <p class="empty">Base visual criada. A regra de dados desta área será implementada por etapa.</p>
  `;
}

function renderContentListView(title: string, description: string, contents: ContentItem[]): string {
  const filtered = filterContents(contents, state.search);
  return `
    <section class="section-heading">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(description)}</p>
      </div>
      <span class="muted">${filtered.length} títulos</span>
    </section>
    ${filtered.length ? `<section class="content-grid">${filtered.map((content, index) => renderSeriesCard(content, `list-${state.activeView}-${content.id}-${index}`)).join("")}</section>` : state.search ? renderNoSearchResults() : `<p class="empty">Nenhuma obra nesta área.</p>`}
  `;
}

function renderCollectionsView(): string {
  return `
    <section class="section-heading">
      <div>
        <h2>Minhas Coleções</h2>
        <p class="muted">Crie listas pessoais para organizar obras por tema, recomendação ou qualquer critério seu.</p>
      </div>
      <div class="section-actions">
        <span class="muted">${state.collections.length} coleções</span>
        <button class="button" id="add-collection-button" type="button">Nova coleção</button>
      </div>
    </section>
    ${
      state.collections.length
        ? `<div class="collection-list">${state.collections.map(renderCollectionSection).join("")}</div>`
        : `<p class="empty">Nenhuma coleção criada ainda.</p>`
    }
  `;
}

function getUserLabel(user: PublicUser): string {
  return user.nickname || user.displayName || user.username || "Usuário";
}

function renderPeopleView(): string {
  if (state.activePeopleUserId) {
    const user = state.peopleUsers.find((item) => item.id === state.activePeopleUserId);
    if (user) {
      return renderPublicUserProfile(user);
    }
  }

  const ownedCollections = state.collections.filter((collection) => collection.userId === state.user?.id);
  const people = state.peopleUsers.filter((user) => user.id !== state.user?.id);
  const sharedCollections = ownedCollections.filter((collection) => collection.sharedWithUserIds.length > 0);

  return `
    <section class="section-heading">
      <div>
        <h2>Pessoas</h2>
        <p class="muted">Compartilhe suas coleções pessoais com outros usuários.</p>
      </div>
      <span class="muted">${people.length} pessoas</span>
    </section>
    ${state.peopleShareError ? `<p class="error">${escapeHtml(state.peopleShareError)}</p>` : ""}
    ${
      ownedCollections.length
        ? people.length
          ? sharedCollections.length
            ? `<div class="people-list">${people.map((user) => renderPersonCard(user, sharedCollections)).join("")}</div>`
            : `<p class="empty">Nenhuma coleção compartilhada ainda.</p>`
          : `<p class="empty">Nenhum outro usuário cadastrado.</p>`
        : `<p class="empty">Crie uma coleção pessoal antes de compartilhar com outras pessoas.</p>`
    }
  `;
}

function renderPersonCard(user: PublicUser, sharedCollections: UserCollection[]): string {
  const userName = getUserLabel(user);
  const visibleCollections = sharedCollections.filter((collection) => collection.sharedWithUserIds.includes(user.id));
  if (visibleCollections.length === 0) {
    return "";
  }

  return `
    <article class="person-card">
      <button class="person-card-open" data-open-person="${escapeHtml(user.id)}" type="button">
        ${renderAvatar(user, "avatar user-avatar")}
        <div>
          <h3>${escapeHtml(userName)}</h3>
          <p>${escapeHtml(user.username)}</p>
        </div>
      </button>
      <div class="person-collection-list">
        ${visibleCollections.map((collection) => `<span class="person-collection-pill">${escapeHtml(collection.name)}</span>`).join("")}
      </div>
    </article>
  `;
}

function renderPublicUserProfile(user: PublicUser): string {
  const userName = getUserLabel(user);
  const sharedCollections = state.collections.filter(
    (collection) => collection.userId === state.user?.id && collection.sharedWithUserIds.includes(user.id)
  );
  const favorites = getContentsByIds(user.favoriteContentIds);

  return `
    <section class="profile-page public-profile-page">
      <button class="button secondary" id="back-to-people" type="button">Voltar</button>
      <div class="profile-hero">
        ${renderAvatar(user, "profile-avatar")}
        <div class="profile-hero-info">
          <h2>${escapeHtml(userName)}</h2>
          <p>${escapeHtml(user.biography || "Sem biografia.")}</p>
          ${user.location ? `<span>${escapeHtml(user.location)}</span>` : ""}
        </div>
      </div>
      <section class="profile-section">
        <h3>Coleções compartilhadas</h3>
        ${
          sharedCollections.length
            ? `<div class="person-collection-list">${sharedCollections.map((collection) => `<span class="person-collection-pill">${escapeHtml(collection.name)}</span>`).join("")}</div>`
            : `<p class="empty compact">Nenhuma coleção compartilhada.</p>`
        }
      </section>
      <section class="profile-section">
        <h3>Obras preferidas</h3>
        ${
          favorites.length
            ? `<div class="profile-favorites">${favorites.map(renderProfileFavorite).join("")}</div>`
            : `<p class="empty compact">Nenhuma obra preferida definida.</p>`
        }
      </section>
    </section>
  `;
}

function renderCollectionSection(collection: UserCollection): string {
  const contents = getContentsByIds(collection.contentIds);
  const editing = state.editingCollectionId === collection.id;
  const owner = collection.userId === state.user?.id;
  return `
    <section class="collection-section${owner ? "" : " shared"}">
      ${
        editing
          ? renderCollectionEditForm(collection, contents.length)
          : `
            <div class="series-section-heading">
              <div>
                <h2>${escapeHtml(collection.name)}</h2>
                ${collection.description ? `<p>${escapeHtml(collection.description)}</p>` : ""}
                ${owner ? "" : `<p class="collection-owner">Compartilhada por ${escapeHtml(collection.ownerDisplayName)}</p>`}
              </div>
              <div class="collection-heading-actions">
                <span>${contents.length} títulos</span>
                ${
                  owner
                    ? `
                      <button class="icon-button collection-share-button" data-share-collection="${escapeHtml(collection.id)}" type="button" title="Compartilhar coleção">${renderIcon("share")}</button>
                      <button class="icon-button collection-edit-button" data-edit-collection="${escapeHtml(collection.id)}" type="button" title="Editar coleção" aria-label="Editar coleção">${renderSidebarIcon("pencil", "Editar coleção")}</button>
                      <button class="icon-button collection-delete-button" data-delete-collection="${escapeHtml(collection.id)}" type="button" title="Apagar coleção" aria-label="Apagar coleção">${renderSidebarIcon("trash", "Apagar coleção")}</button>
                    `
                    : ""
                }
              </div>
            </div>
          `
      }
      ${
        contents.length
          ? `<div class="content-grid">${contents.map((content, index) => renderCollectionContentCard(collection, content, index)).join("")}</div>`
          : `<p class="empty compact">Coleção vazia.</p>`
      }
    </section>
  `;
}

function renderCollectionEditForm(collection: UserCollection, contentCount: number): string {
  return `
    <form class="collection-edit-form" data-collection-edit-form="${escapeHtml(collection.id)}">
      <div class="collection-edit-grid">
        <label class="form-row">
          <span>Nome</span>
          <input class="input" name="name" maxlength="80" value="${escapeHtml(state.collectionEditDraft.name)}" required />
        </label>
        <label class="form-row">
          <span>Descrição</span>
          <textarea class="input" name="description" rows="3" maxlength="240">${escapeHtml(state.collectionEditDraft.description)}</textarea>
        </label>
      </div>
      <div class="collection-edit-actions">
        <span class="muted">${contentCount} títulos</span>
        <button class="button secondary" data-cancel-collection-edit="${escapeHtml(collection.id)}" type="button">Cancelar</button>
        <button class="button" type="submit">Salvar</button>
      </div>
      ${state.collectionEditError ? `<p class="error">${escapeHtml(state.collectionEditError)}</p>` : ""}
    </form>
  `;
}

function renderCollectionContentCard(collection: UserCollection, content: ContentItem, index: number): string {
  const owner = collection.userId === state.user?.id;
  return `
    <div class="collection-card-shell">
      ${renderSeriesCard(content, `collection-${collection.id}-${content.id}-${index}`)}
      ${owner ? `<button class="collection-remove-button" data-remove-collection-content="${escapeHtml(collection.id)}" data-content-id="${escapeHtml(content.id)}" type="button" aria-label="Remover ${escapeHtml(content.title)} da coleção">×</button>` : ""}
    </div>
  `;
}

function renderCollectionModal(): string {
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel collection-modal" role="dialog" aria-modal="true" aria-labelledby="collection-modal-title">
        <header class="modal-header">
          <h2 id="collection-modal-title">Nova coleção</h2>
          <button class="icon-button" id="close-collection-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <form id="collection-form">
          <div class="modal-body">
            <label class="form-row">
              <span>Nome da coleção</span>
              <input class="input" id="collection-name-input" name="name" value="${escapeHtml(state.collectionDraft.name)}" maxlength="80" placeholder="Tem anime" required />
            </label>
            <label class="form-row">
              <span>Descrição</span>
              <textarea class="input" id="collection-description-input" name="description" rows="4" maxlength="240" placeholder="Lista das obras que estou lendo e possuem versão animada">${escapeHtml(state.collectionDraft.description)}</textarea>
            </label>
            <p class="modal-help">Depois de criar, use o menu de cada obra para adicioná-la à coleção.</p>
            ${state.collectionModalError ? `<p class="error">${escapeHtml(state.collectionModalError)}</p>` : ""}
          </div>
          <footer class="modal-actions">
            <button class="button secondary" id="cancel-collection-modal" type="button">Cancelar</button>
            <button class="button" type="submit">Criar coleção</button>
          </footer>
        </form>
      </section>
    </div>
  `;
}

function renderCollectionShareModal(): string {
  const collection = state.collections.find((item) => item.id === state.sharingCollectionId);
  const selectedIds = new Set(collection?.sharedWithUserIds ?? []);
  const users = state.collectionShareUsers.filter((user) => user.id !== state.user?.id);

  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel collection-modal" role="dialog" aria-modal="true" aria-labelledby="collection-share-title">
        <header class="modal-header">
          <h2 id="collection-share-title">Compartilhar coleção</h2>
          <button class="icon-button" id="close-collection-share-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <form id="collection-share-form">
          <div class="modal-body">
            <p class="modal-help">Escolha quais usuários poderão ver "${escapeHtml(collection?.name ?? "esta coleção")}".</p>
            <div class="share-user-list">
              ${
                users.length
                  ? users.map((user) => `
                      <label class="share-user-row">
                        <input type="checkbox" name="userId" value="${escapeHtml(user.id)}" ${selectedIds.has(user.id) ? "checked" : ""} />
                        <span>
                          <strong>${escapeHtml(user.displayName)}</strong>
                          <small>${escapeHtml(user.username)}</small>
                        </span>
                      </label>
                    `).join("")
                  : `<p class="empty compact">Nenhum outro usuário cadastrado.</p>`
              }
            </div>
            ${state.collectionShareError ? `<p class="error">${escapeHtml(state.collectionShareError)}</p>` : ""}
          </div>
          <footer class="modal-actions">
            <button class="button secondary" id="cancel-collection-share-modal" type="button">Cancelar</button>
            <button class="button" type="submit">Salvar</button>
          </footer>
        </form>
      </section>
    </div>
  `;
}

function renderCollectionDeleteModal(): string {
  const collection = state.collections.find((item) => item.id === state.deletingCollectionId);
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel confirm-modal" role="dialog" aria-modal="true" aria-labelledby="collection-delete-title">
        <header class="modal-header">
          <h2 id="collection-delete-title">Apagar coleção</h2>
          <button class="icon-button" id="close-collection-delete-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <div class="modal-body">
          <p>Tem certeza que deseja apagar "${escapeHtml(collection?.name ?? "esta coleção")}"?</p>
          <p class="modal-help">As obras não serão apagadas da biblioteca, apenas a coleção será removida.</p>
          ${state.collectionDeleteError ? `<p class="error">${escapeHtml(state.collectionDeleteError)}</p>` : ""}
        </div>
        <footer class="modal-actions">
          <button class="button secondary" id="cancel-collection-delete-modal" type="button">Cancelar</button>
          <button class="button danger" id="confirm-collection-delete" type="button">Apagar</button>
        </footer>
      </section>
    </div>
  `;
}

function renderAdminUserModal(): string {
  const modeTitle: Record<AppState["adminUserModalMode"], string> = {
    create: "Adicionar usuário",
    edit: "Editar usuário",
    invite: "Gerar convite"
  };

  const isEdit = state.adminUserModalMode === "edit";
  const isInvite = state.adminUserModalMode === "invite";
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel user-modal" role="dialog" aria-modal="true" aria-labelledby="user-modal-title">
        <header class="modal-header">
          <h2 id="user-modal-title">${modeTitle[state.adminUserModalMode]}</h2>
          <button class="icon-button" id="close-user-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <form id="user-form">
          <div class="modal-body user-modal-body">
            <div class="user-modal-grid${isInvite ? " invite-user-modal-grid" : ""}">
              <label class="form-row">
                <span>Nome de exibição</span>
                <input class="input" name="displayName" value="${escapeHtml(state.adminUserDraft.displayName)}" placeholder="Nome público" required />
              </label>
              <label class="form-row">
                <span>E-mail</span>
                <input class="input" name="email" type="email" value="${escapeHtml(state.adminUserDraft.email)}" placeholder="email@dominio.com" required />
              </label>
              <label class="form-row">
                <span>Usuário</span>
                <input class="input" name="username" value="${escapeHtml(state.adminUserDraft.username)}" placeholder="usuario" required />
              </label>
              ${
                isInvite
                  ? `
                    <div class="modal-help user-modal-note">Preencha os campos ou gere um link único direto.</div>
                    <div class="invite-link-only">
                      <button class="button secondary" id="create-link-invite-button" type="button">Convidar com link</button>
                    </div>
                  `
                  : `
                    <label class="form-row">
                      <span>${isEdit ? "Nova senha" : "Senha"}</span>
                      <input class="input" name="password" type="password" value="${escapeHtml(state.adminUserDraft.password)}" ${isEdit ? "" : "required"} placeholder="${isEdit ? "Deixe em branco para manter" : "Senha inicial"}" />
                    </label>
                  `
              }
            </div>
            ${
              isInvite
                ? state.libraries.map((library) => `<input type="hidden" name="allowedLibraryIds" value="${escapeHtml(library.id)}" />`).join("")
                : `
                  <fieldset class="user-library-fieldset">
                    <legend>Bibliotecas visíveis</legend>
                    <div class="user-library-list">
                      ${state.libraries.map((library) => `
                        <label class="toggle-row">
                          <input type="checkbox" name="allowedLibraryIds" value="${escapeHtml(library.id)}" ${state.adminUserDraft.allowedLibraryIds.includes(library.id) ? "checked" : ""} />
                          <span>${escapeHtml(library.name)}</span>
                        </label>
                      `).join("")}
                    </div>
                  </fieldset>
                `
            }
            <div class="user-permissions-grid${isInvite ? " invite-permissions-grid" : ""}">
              <input type="hidden" name="canDownload" value="on" />
              ${
                isInvite
                  ? `
                    <input type="hidden" name="canLogin" value="on" />
                  `
                  : `
                    <label class="toggle-row">
                      <input type="checkbox" name="canLogin" ${state.adminUserDraft.canLogin ? "checked" : ""} />
                      <span>Permitir login</span>
                    </label>
                  `
              }
              ${
                isInvite
                  ? ""
                  : `
                    <label class="toggle-row">
                      <input type="checkbox" name="canChangePassword" ${state.adminUserDraft.canChangePassword ? "checked" : ""} />
                      <span>Permitir alterar a própria senha</span>
                    </label>
                  `
              }
            </div>
            ${state.adminUserModalError ? `<p class="error">${escapeHtml(state.adminUserModalError)}</p>` : ""}
            ${state.adminUserInviteUrl ? `<div class="invite-banner compact"><strong>Convite gerado</strong><button class="button secondary" data-copy-invite type="button">Copiar link</button></div>` : ""}
          </div>
          <footer class="modal-actions">
            <button class="button secondary" id="cancel-user-modal" type="button">Cancelar</button>
            <button class="button" type="submit">${isInvite ? "Gerar convite" : isEdit ? "Salvar usuário" : "Criar usuário"}</button>
          </footer>
        </form>
      </section>
    </div>
  `;
}

function renderUserDeleteModal(): string {
  const user = state.adminUsers.find((item) => item.id === state.adminUserDeleteId);
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal-panel confirm-modal" role="dialog" aria-modal="true" aria-labelledby="user-delete-title">
        <header class="modal-header">
          <h2 id="user-delete-title">Apagar usuário</h2>
          <button class="icon-button" id="close-user-delete-modal" type="button" aria-label="Fechar">${renderIcon("close")}</button>
        </header>
        <div class="modal-body">
          <p>Tem certeza que deseja apagar "${escapeHtml(user?.displayName || user?.username || "este usuário")}"?</p>
          <p class="modal-help">Isso remove acesso, progresso, bookmarks, coleções e reviews dessa conta.</p>
          ${state.adminUserModalError ? `<p class="error">${escapeHtml(state.adminUserModalError)}</p>` : ""}
        </div>
        <footer class="modal-actions">
          <button class="button secondary" id="cancel-user-delete-modal" type="button">Cancelar</button>
          <button class="button danger" id="confirm-user-delete" type="button">Apagar</button>
        </footer>
      </section>
    </div>
  `;
}

function renderLibraryView(activeLibrary: Library | undefined, contents: ContentItem[]): string {
  const emptyMessage = state.search ? renderNoSearchResults() : renderEmptyMedia();

  return `
    <section class="library-heading">
      <div class="library-title-row">
        <h2>${escapeHtml(activeLibrary?.name ?? "Biblioteca")}</h2>
        ${
          state.user?.role === "admin" && activeLibrary
            ? `
              <span class="inline-menu-shell">
                <button class="inline-more" data-library-menu-id="${activeLibrary.id}" type="button">⋮</button>
                ${state.openLibraryMenuId === activeLibrary.id ? renderLibraryContextMenu(activeLibrary) : ""}
              </span>
            `
            : ""
        }
      </div>
      <p>${contents.length} ${contents.length === 1 ? "série" : "séries"}</p>
    </section>
    ${
      contents.length
        ? `<section class="content-grid">${contents.map(renderContentCard).join("")}</section>`
        : emptyMessage
    }
  `;
}

function renderContinueReading(): string {
  if (state.progress.length === 0) {
    return "";
  }

  return `
    <section class="empty">
      <strong>Continue lendo</strong>
      <p class="muted">A API já registra o progresso por usuário. A próxima etapa liga esses registros às capas e páginas reais.</p>
    </section>
  `;
}

function renderContentCard(content: ContentItem, index: number): string {
  return renderSeriesCard(content, `library-${content.id}-${index}`);
}

function renderSeriesCard(content: ContentItem, cardKey = content.id): string {
  const showMarkButton = state.activeView === "library";
  const marked = state.seriesMarks.includes(content.id);
  const menuOpen = state.openSeriesMenuId === cardKey;
  return `
    <article class="content-card series-card">
      ${
        content.coverUrl
          ? `<img class="cover-image" src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" loading="lazy" />`
          : `<div class="cover-placeholder">${escapeHtml(content.title.slice(0, 1).toUpperCase())}</div>`
      }
      <div class="series-hover-actions">
        ${
          showMarkButton
            ? `<button class="series-mark-button${marked ? " active" : ""}" data-series-mark-toggle="${content.id}" type="button" aria-label="${marked ? "Remover marcação de" : "Marcar"} ${escapeHtml(content.title)}">${renderIcon("mark")}</button>`
            : ""
        }
        <button class="series-continue-button" data-series-continue="${content.id}" type="button" aria-label="Continuar leitura de ${escapeHtml(content.title)}">${renderIcon("continue")}</button>
      </div>
      <div class="series-footer">
        <span class="series-file-icon" aria-hidden="true">${renderIcon("file")}</span>
        <span class="content-title">${escapeHtml(content.title)}</span>
        <button class="series-menu-button" data-series-menu-key="${escapeHtml(cardKey)}" type="button" aria-label="Opções de ${escapeHtml(content.title)}" aria-expanded="${menuOpen}">⋮</button>
      </div>
      ${menuOpen ? renderSeriesContextMenu(content, cardKey) : ""}
      <p class="series-meta">${content.pageCount} páginas${marked ? " · marcado" : ""}</p>
      <button class="series-open" data-series-open="${content.id}" aria-label="Abrir ${escapeHtml(content.title)}"></button>
    </article>
  `;
}

function renderSeriesContextMenu(content: ContentItem, cardKey: string): string {
  const addMenuOpen = state.openSeriesAddMenuId === cardKey;
  const removeMenuOpen = state.openSeriesRemoveMenuId === cardKey;
  return `
    <div class="series-context-menu" role="menu" aria-label="Opções de ${escapeHtml(content.title)}">
      <button class="series-menu-item has-submenu" data-series-add-menu-key="${escapeHtml(cardKey)}" type="button" role="menuitem" aria-expanded="${addMenuOpen}">
        <span>Adicionar a</span>
        <span aria-hidden="true">›</span>
      </button>
      ${addMenuOpen ? renderSeriesAddMenu(content) : ""}
      <button class="series-menu-item has-submenu" data-series-remove-menu-key="${escapeHtml(cardKey)}" type="button" role="menuitem" aria-expanded="${removeMenuOpen}">
        <span>Remover de</span>
        <span aria-hidden="true">›</span>
      </button>
      ${removeMenuOpen ? renderSeriesRemoveMenu(content) : ""}
      <button class="series-menu-item" data-series-mark-read="${content.id}" type="button" role="menuitem">Marcar como lido</button>
      <button class="series-menu-item" data-series-mark-unread="${content.id}" type="button" role="menuitem">Marcar como não lido</button>
      <button class="series-menu-item" data-series-scan="${content.id}" type="button" role="menuitem">Escanear série</button>
    </div>
  `;
}

function renderSeriesRemoveMenu(content: ContentItem): string {
  const removableCollections = state.collections.filter((collection) => collection.userId === state.user?.id && collection.contentIds.includes(content.id));
  const hasRemovableItems =
    state.wantToRead.includes(content.id) ||
    state.readingList.includes(content.id) ||
    removableCollections.length > 0;

  return `
    <div class="series-remove-menu" role="menu" aria-label="Remover ${escapeHtml(content.title)} de">
      ${
        state.wantToRead.includes(content.id)
          ? `<button class="series-menu-item" data-remove-want="${content.id}" type="button" role="menuitem">Quero ler</button>`
          : ""
      }
      ${
        state.readingList.includes(content.id)
          ? `<button class="series-menu-item" data-remove-reading-list="${content.id}" type="button" role="menuitem">Lista de leitura</button>`
          : ""
      }
      ${removableCollections.map((collection) => `<button class="series-menu-item" data-remove-collection="${escapeHtml(collection.id)}" data-content-id="${content.id}" type="button" role="menuitem">${escapeHtml(collection.name)}</button>`).join("")}
      ${hasRemovableItems ? "" : `<span class="series-menu-empty">Não está em nenhuma lista</span>`}
    </div>
  `;
}

function renderSeriesAddMenu(content: ContentItem): string {
  const ownedCollections = state.collections.filter((collection) => collection.userId === state.user?.id);
  return `
    <div class="series-add-menu" role="menu" aria-label="Adicionar ${escapeHtml(content.title)} a">
      <button class="series-menu-item" data-add-want="${content.id}" type="button" role="menuitem">Quero ler</button>
      <button class="series-menu-item" data-add-reading-list="${content.id}" type="button" role="menuitem">Lista de leitura</button>
      ${
        ownedCollections.length
          ? ownedCollections.map((collection) => `<button class="series-menu-item" data-add-collection="${escapeHtml(collection.id)}" data-content-id="${content.id}" type="button" role="menuitem">${escapeHtml(collection.name)}</button>`).join("")
          : `<span class="series-menu-empty">Nenhuma coleção existente</span>`
      }
    </div>
  `;
}

function renderSeriesView(content: ContentItem, activeLibrary: Library | undefined): string {
  const marked = state.seriesMarks.includes(content.id);
  const progress = getProgressForContent(content.id);
  const seriesLibrary = state.libraries.find((library) => library.id === content.libraryId) ?? activeLibrary;
  const continuePage = progress?.currentPage ?? 0;
  const chapterLabel = content.chapterCount === 1 ? "capítulo" : "capítulos";
  const ratingClass = getRatingClass(content.rating);
  const mainChapters = content.chapters.filter((chapter) => !chapter.isSpecial);
  const specialChapters = content.chapters.filter((chapter) => chapter.isSpecial);
  const progressLabel = getProgressChapterLabel(content, progress);
  const activeReviews = state.seriesReviews[content.id] ?? [];
  const reviewCount = activeReviews.length;
  const visibleChapters = state.seriesTab === "specials" ? specialChapters : mainChapters;
  const chapters = getOrderedChapters(visibleChapters, progress);

  return `
    <section class="series-detail">
      <div class="series-detail-hero">
        <div class="series-detail-cover">
          ${
            content.coverUrl
              ? `<img class="series-detail-image" src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" loading="eager" />`
              : `<div class="series-detail-placeholder">${escapeHtml(content.title.slice(0, 1).toUpperCase())}</div>`
          }
        </div>
        <div class="series-detail-info">
          <div class="series-detail-header">
            <button class="series-back-button" data-series-back type="button">Voltar</button>
            <span class="series-library-chip">${escapeHtml(seriesLibrary?.name ?? "Biblioteca")}</span>
          </div>
          <h1>${escapeHtml(content.title)}</h1>
          <div class="series-detail-stats">
            <span>${content.pageCount} páginas</span>
            <span>${content.chapterCount} ${chapterLabel}</span>
          </div>
          <div class="series-detail-actions">
            <button class="button secondary${marked ? " active-mark" : ""}" data-series-mark-toggle="${content.id}" type="button">
              ${marked ? "Desmarcar" : "Marcar"}
            </button>
            <button class="button" data-series-continue="${content.id}" type="button">
              Continuar leitura
            </button>
          </div>
          <div class="series-detail-meta-grid">
            ${renderSeriesMetaItem("Autores", content.authors.length ? content.authors.join(", ") : "N/A", renderIcon("author"))}
            ${renderSeriesMetaItem("Lançamento", content.releaseDate ?? "N/A", renderIcon("release"))}
            ${renderSeriesMetaItem("Gêneros", content.genres.length ? content.genres.join(", ") : "N/A", renderIcon("genres"))}
            ${renderSeriesMetaItem("Progresso", progressLabel, renderIcon("progress"))}
            ${renderSeriesMetaItem("Nota", content.rating ?? "N/A", renderIcon("rating"), ratingClass)}
          </div>
          ${
            content.description
              ? `<p class="series-description">${escapeHtml(content.description)}</p>`
              : `<p class="series-description muted">Sem sinopse disponível para esta obra.</p>`
          }
        </div>
      </div>
      <div class="series-tabs" role="tablist" aria-label="Seções da série">
        ${renderSeriesTabButton("chapters", "Capítulos", mainChapters.length)}
        ${renderSeriesTabButton("specials", "Especiais", specialChapters.length)}
        ${renderSeriesTabButton("reviews", "Reviews", reviewCount)}
      </div>
      <div class="series-detail-body">
        ${
          state.seriesTab === "reviews"
            ? renderSeriesReviewsTab(content, activeReviews)
            : `
              <div class="series-controls">
                <label class="series-control-group">
                  <span class="series-control-label">Ordenação</span>
                  <select class="input series-control-select" data-series-order>
                    <option value="asc" ${state.seriesChapterOrder === "asc" ? "selected" : ""}>Do começo para o final</option>
                    <option value="desc" ${state.seriesChapterOrder === "desc" ? "selected" : ""}>Do final para o começo</option>
                    <option value="last-read" ${state.seriesChapterOrder === "last-read" ? "selected" : ""}>Último marcado como lido</option>
                  </select>
                </label>
                <div class="series-layout-toggle" role="group" aria-label="Modo de exibição dos capítulos">
                  <button class="series-layout-button${state.seriesChapterLayout === "list" ? " active" : ""}" data-series-layout="list" type="button">Lista</button>
                  <button class="series-layout-button${state.seriesChapterLayout === "grid" ? " active" : ""}" data-series-layout="grid" type="button">Grade</button>
                </div>
              </div>
              <section class="series-chapters">
                <div class="series-section-heading">
                  <h2>${state.seriesTab === "specials" ? "Especiais" : "Capítulos"}</h2>
                  <span>${visibleChapters.length} ${state.seriesTab === "specials" ? "especiais" : chapterLabel}</span>
                </div>
                ${
                  chapters.length
                    ? `<div class="chapter-list ${state.seriesChapterLayout === "grid" ? "grid" : "list"}">${chapters.map((chapter, index) => renderChapterCard(content, chapter, index, state.seriesChapterLayout)).join("")}</div>`
                    : `<p class="empty compact">Nenhum ${state.seriesTab === "specials" ? "especial" : "capítulo"} detectado.</p>`
                }
              </section>
            `
        }
      </div>
    </section>
  `;
}

function renderSeriesTabButton(tab: AppState["seriesTab"], label: string, count: number): string {
  const active = state.seriesTab === tab ? " active" : "";
  return `
    <button class="series-tab-button${active}" data-series-tab="${tab}" type="button" role="tab" aria-selected="${state.seriesTab === tab}">
      <span>${escapeHtml(label)}</span>
      <span class="series-tab-count">${count}</span>
    </button>
  `;
}

function renderSeriesReviewsTab(content: ContentItem, reviews: PublicContentReview[]): string {
  const currentUserReview = reviews.find((review) => review.userId === state.user?.id) ?? null;

  return `
    <section class="series-reviews">
      <form class="review-form" data-review-form>
        <div class="series-section-heading">
          <h2>Escreva sua review</h2>
          <span>${reviews.length} ${reviews.length === 1 ? "review" : "reviews"}</span>
        </div>
        <div class="review-form-grid">
          <label class="form-row">
            <span>Nota</span>
            <input class="input" name="rating" type="number" min="0" max="10" step="0.1" value="${escapeHtml(String(currentUserReview?.rating ?? ""))}" />
          </label>
          <label class="form-row review-comment">
            <span>Comentário</span>
            <textarea class="input" name="comment" rows="5" placeholder="Compartilhe sua opinião com outros leitores...">${escapeHtml(currentUserReview?.comment ?? "")}</textarea>
          </label>
        </div>
        <div class="review-form-actions">
          <button class="button" type="submit">Publicar review</button>
          ${state.seriesReviewError ? `<p class="error">${escapeHtml(state.seriesReviewError)}</p>` : ""}
        </div>
      </form>
      <div class="series-review-list">
        ${
          reviews.length
            ? reviews.map((review) => renderReviewCard(review)).join("")
            : `<p class="empty compact">Ainda não há reviews para esta obra.</p>`
        }
      </div>
    </section>
  `;
}

function renderReviewCard(review: PublicContentReview): string {
  return `
    <article class="review-card">
      <div class="review-card-header">
        <div>
          <strong>${escapeHtml(review.displayName)}</strong>
          <p>${escapeHtml(review.role === "admin" ? "Administrador" : "Usuário")}</p>
        </div>
        <span class="review-score">${escapeHtml(review.rating.toFixed(1))}</span>
      </div>
      <p class="review-comment-text">${escapeHtml(review.comment)}</p>
      <p class="review-date">${escapeHtml(new Date(review.updatedAt).toLocaleString("pt-BR"))}</p>
    </article>
  `;
}

function renderSeriesMetaItem(label: string, value: string, icon: string, extraClass = ""): string {
  const classes = ["series-meta-item", extraClass].filter(Boolean).join(" ");
  return `
    <div class="${classes}">
      <span class="series-meta-icon" aria-hidden="true">${icon}</span>
      <div>
        <span class="series-meta-label">${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    </div>
  `;
}

function getProgressChapterLabel(content: ContentItem, progress: ReadingProgress | null): string {
  if (!progress) {
    return "Sem progresso";
  }

  const chapter = content.chapters.find((item) => {
    const endPage = item.startPage + item.pageCount - 1;
    return progress.currentPage >= item.startPage && progress.currentPage <= endPage;
  });

  if (!chapter) {
    return `Página ${progress.currentPage + 1}`;
  }

  return chapter.name;
}

function renderChapterCard(
  content: ContentItem,
  chapter: { name: string; startPage: number; pageCount: number; isSpecial: boolean },
  index: number,
  layout: "list" | "grid"
): string {
  return `
    <button class="chapter-card ${layout === "grid" ? "grid" : "list"}" data-chapter-open="${escapeHtml(content.id)}" data-chapter-start="${chapter.startPage}" type="button">
      <span class="chapter-card-index">${index + 1}</span>
      <span class="chapter-card-name">${escapeHtml(chapter.name)}</span>
      <span class="chapter-card-meta">${chapter.pageCount} páginas</span>
      ${chapter.isSpecial ? `<span class="chapter-badge">Especial</span>` : ""}
    </button>
  `;
}

function getOrderedChapters(
  chapters: Array<{ name: string; startPage: number; pageCount: number; isSpecial: boolean }>,
  progress: ReadingProgress | null
): Array<{ name: string; startPage: number; pageCount: number; isSpecial: boolean }> {
  const ordered = [...chapters];
  if (state.seriesChapterOrder === "desc") {
    return ordered.sort((a, b) => b.startPage - a.startPage);
  }

  if (state.seriesChapterOrder === "last-read") {
    const currentPage = progress?.currentPage ?? 0;
    const activeIndex = ordered.findIndex((chapter) => {
      const endPage = chapter.startPage + chapter.pageCount - 1;
      return currentPage >= chapter.startPage && currentPage <= endPage;
    });
    if (activeIndex > 0) {
      const [activeChapter] = ordered.splice(activeIndex, 1);
      if (activeChapter) {
        return [activeChapter, ...ordered.sort((a, b) => a.startPage - b.startPage)];
      }
    }
  }

  return ordered.sort((a, b) => a.startPage - b.startPage);
}

function getRatingClass(rating: string | null): string {
  const value = rating ? Number.parseFloat(rating) : Number.NaN;
  if (Number.isNaN(value)) {
    return "rating-brown";
  }
  if (value >= 8.5) {
    return "rating-blue";
  }
  if (value >= 7) {
    return "rating-yellow";
  }
  if (value >= 5) {
    return "rating-silver";
  }
  return "rating-brown";
}

function renderEmptyMedia(): string {
  return `<p class="empty">Nenhum conteúdo encontrado. Monte suas mídias em /media e crie pastas dentro da biblioteca.</p>`;
}

function renderNoSearchResults(): string {
  return `
    <section class="empty">
      <strong>Nenhum resultado encontrado</strong>
      <p>Não encontramos obras parecidas com "${escapeHtml(state.search)}". Confira a escrita ou tente buscar por uma parte menor do nome.</p>
    </section>
  `;
}

function getReaderModeLabel(mode: ReaderMode): string {
  const labels: Record<ReaderMode, string> = {
    horizontal: "Toque lateral",
    "paged-vertical": "Toque cima/baixo",
    "vertical-scroll": "Scroll vertical"
  };
  return labels[mode];
}

function getNextReaderMode(mode: ReaderMode): ReaderMode {
  if (mode === "vertical-scroll") return "horizontal";
  if (mode === "horizontal") return "paged-vertical";
  return "vertical-scroll";
}

function getContentProgressPercent(content: ContentItem, page: number): number {
  if (content.pageCount <= 1) {
    return content.pageCount === 0 ? 0 : 100;
  }
  return Math.round((page / (content.pageCount - 1)) * 100);
}

function getChapterForPage(content: ContentItem, page: number): ContentItem["chapters"][number] | null {
  return content.chapters.find((chapter) => {
    const endPage = chapter.startPage + chapter.pageCount - 1;
    return page >= chapter.startPage && page <= endPage;
  }) ?? null;
}

function getReaderChapterProgress(content: ContentItem, page: number): {
  startPage: number;
  endPage: number;
  currentPage: number;
  pageCount: number;
} {
  const chapter = getChapterForPage(content, page);
  const startPage = chapter?.startPage ?? 0;
  const pageCount = Math.max(chapter?.pageCount ?? content.pageCount, 1);
  const endPage = Math.min(startPage + pageCount - 1, Math.max(content.pageCount - 1, 0));
  return {
    startPage,
    endPage,
    currentPage: Math.min(Math.max(page - startPage + 1, 1), pageCount),
    pageCount
  };
}

function hasAdjacentChapter(content: ContentItem, page: number, direction: -1 | 1): boolean {
  const chapters = [...content.chapters].sort((a, b) => a.startPage - b.startPage);
  if (chapters.length <= 1) {
    return false;
  }

  const currentIndex = chapters.findIndex((chapter) => {
    const endPage = chapter.startPage + chapter.pageCount - 1;
    return page >= chapter.startPage && page <= endPage;
  });
  const fallbackIndex = chapters.findIndex((chapter) => chapter.startPage > page);
  const index = currentIndex >= 0 ? currentIndex : fallbackIndex >= 0 ? fallbackIndex : chapters.length - 1;
  return direction < 0 ? index > 0 : index < chapters.length - 1;
}

function getAdjacentChapterStartPage(content: ContentItem, page: number, direction: -1 | 1): number {
  const chapters = [...content.chapters].sort((a, b) => a.startPage - b.startPage);
  if (chapters.length === 0) {
    return page;
  }

  const currentIndex = chapters.findIndex((chapter) => {
    const endPage = chapter.startPage + chapter.pageCount - 1;
    return page >= chapter.startPage && page <= endPage;
  });
  const fallbackIndex = chapters.findIndex((chapter) => chapter.startPage > page);
  const index = currentIndex >= 0 ? currentIndex : fallbackIndex >= 0 ? fallbackIndex : chapters.length - 1;
  const next = chapters[Math.min(Math.max(index + direction, 0), chapters.length - 1)];
  return next?.startPage ?? page;
}

function renderReader(content: ContentItem, page: number, mode: ReaderMode): string {
  const safePage = Math.min(Math.max(page, 0), Math.max(content.pageCount - 1, 0));
  const pageBookmarked = isPageBookmarked(content.id, safePage);
  const controlsVisible = state.reader?.controlsVisible ?? false;
  const activeChapter = getChapterForPage(content, safePage);
  const chapterProgress = getReaderChapterProgress(content, safePage);
  const modeLabel = getReaderModeLabel(mode);
  const hasPreviousChapter = hasAdjacentChapter(content, safePage, -1);
  const hasNextChapter = hasAdjacentChapter(content, safePage, 1);
  const hasPreviousPage = safePage > 0;
  const hasNextPage = safePage < content.pageCount - 1;
  return `
    <section class="reader ${controlsVisible ? "controls-visible" : ""}">
      <div class="reader-stage ${mode === "vertical-scroll" ? "vertical-scroll" : ""}" id="reader-stage">
        ${renderReaderPages(content, safePage, mode)}
      </div>
      <div class="reader-overlay top" aria-hidden="${controlsVisible ? "false" : "true"}">
        <div>
          <button class="reader-back" id="close-reader" type="button" aria-label="Voltar">‹</button>
        </div>
        <div class="reader-title">
          <h2>${escapeHtml(content.title)}</h2>
          <p>${escapeHtml(activeChapter?.name ?? `Página ${safePage + 1}`)} · Progresso: ${getContentProgressPercent(content, safePage)}%</p>
        </div>
        <div class="reader-top-actions">
          <button class="reader-icon-button" id="bookmark-page" type="button" title="${pageBookmarked ? "Remover marcador" : "Marcar página"}" aria-label="${pageBookmarked ? "Remover marcador" : "Marcar página"}">${pageBookmarked ? "▮" : "▯"}</button>
        </div>
      </div>
      <div class="reader-overlay bottom" aria-hidden="${controlsVisible ? "false" : "true"}">
        <div class="reader-page-controls">
          <button class="reader-jump-button" data-chapter-step="-1" type="button" aria-label="Capítulo anterior"${hasPreviousChapter ? "" : " disabled"}>⏮</button>
          <button class="reader-jump-button" data-page-step="-1" type="button" aria-label="Página anterior"${hasPreviousPage ? "" : " disabled"}>◀</button>
          <label class="reader-progress">
            <span>${chapterProgress.currentPage}</span>
            <input data-reader-page-slider type="range" min="${chapterProgress.startPage}" max="${chapterProgress.endPage}" value="${safePage}" aria-label="Progresso do capítulo" />
            <span>${chapterProgress.pageCount}</span>
          </label>
          <button class="reader-jump-button" data-page-step="1" type="button" aria-label="Próxima página"${hasNextPage ? "" : " disabled"}>▶</button>
          <button class="reader-jump-button" data-chapter-step="1" type="button" aria-label="Próximo capítulo"${hasNextChapter ? "" : " disabled"}>⏭</button>
        </div>
        <div class="reader-bottom-actions">
          <button class="reader-mode-button" id="toggle-mode" type="button" title="${escapeHtml(modeLabel)}" aria-label="${escapeHtml(modeLabel)}">${renderReaderModeIcon()}</button>
        </div>
      </div>
    </section>
  `;
}

function renderReaderBookmarks(bookmarks: Bookmark[]): string {
  if (bookmarks.length === 0) {
    return `<p class="empty compact">Nenhuma página marcada nesta obra.</p>`;
  }

  return `
    <section class="reader-bookmarks">
      <div class="series-section-heading">
        <h2>Marcadores desta obra</h2>
        <span>${bookmarks.length} páginas</span>
      </div>
      <div class="reader-bookmark-list">
        ${bookmarks.map((bookmark) => `
          <button class="reader-bookmark-chip" data-reader-bookmark-page="${bookmark.page}" type="button">
            Página ${bookmark.page + 1}
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function renderReaderPages(content: ContentItem, page: number, mode: ReaderMode): string {
  if (content.pageCount === 0) {
    return `<div class="reader-page">Nenhuma página de imagem foi encontrada para este conteúdo.</div>`;
  }

  if (mode === "vertical-scroll") {
    return Array.from({ length: content.pageCount }, (_, index) => {
      return renderPageMedia(content, index, true);
    }).join("");
  }

  const axisClass = mode === "paged-vertical" ? "vertical-axis" : "horizontal-axis";
  return `
    <button class="reader-background-toggle" data-reader-toggle-controls type="button" aria-label="Mostrar controles"></button>
    <div class="reader-media-shell ${axisClass}">
      <button class="reader-hit previous" data-page-step="-1" aria-label="Página anterior"></button>
      ${renderPageMedia(content, page, false)}
      <button class="reader-hit next" data-page-step="1" aria-label="Próxima página"></button>
    </div>
  `;
}

function renderPageMedia(content: ContentItem, page: number, vertical: boolean): string {
  const src = getPageUrl(content, page);
  const pageType = content.pageTypes[page] ?? "image";
  const className = vertical ? "reader-image vertical-page" : "reader-image";

  if (pageType === "pdf") {
    return `
      <iframe
        class="reader-pdf ${vertical ? "vertical-page" : ""}"
        data-reader-page-index="${page}"
        src="${escapeHtml(src)}#toolbar=0"
        title="${escapeHtml(content.title)} PDF ${page + 1}"
      ></iframe>
    `;
  }

  return `<img class="${className}" data-reader-page-index="${page}" src="${escapeHtml(src)}" alt="${escapeHtml(content.title)} página ${page + 1}" loading="${vertical && page >= 2 ? "lazy" : "eager"}" />`;
}

function getPageUrl(content: ContentItem, page: number): string {
  return `/api/contents/${encodeURIComponent(content.id)}/pages/${page}`;
}

function bindShellEvents(): void {
  document.querySelector("#menu-button")?.addEventListener("click", () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    renderShell();
  });

  document.querySelector("#home-button")?.addEventListener("click", () => {
    state.activeView = "home";
    state.activeLibraryId = null;
    state.activeSeriesId = null;
    state.search = "";
    state.reader = null;
    renderShell();
  });

  document.querySelector("#settings-button")?.addEventListener("click", () => {
    state.accountMenuOpen = false;
    state.activeView = "settings";
    state.activeLibraryId = null;
    state.activeSeriesId = null;
    state.reader = null;
    state.settingsSection = state.user?.role === "admin" ? "server" : "preferences";
    state.serverSection = "libraries";
    renderShell();
  });

  document.querySelector("#account-button")?.addEventListener("click", () => {
    state.accountMenuOpen = !state.accountMenuOpen;
    renderShell();
  });

  document.querySelector("#profile-button")?.addEventListener("click", () => {
    state.accountMenuOpen = false;
    state.activeView = "profile";
    state.activeLibraryId = null;
    state.activeSeriesId = null;
    state.reader = null;
    renderShell();
  });

  document.querySelector(".sidebar-admin")?.addEventListener("click", () => {
    state.activeView = "settings";
    state.settingsSection = "server";
    state.serverSection = "libraries";
    state.activeLibraryId = null;
    state.activeSeriesId = null;
    state.reader = null;
    renderShell();
  });

  document.querySelector("#add-library-button")?.addEventListener("click", () => {
    void openLibraryModal();
  });

  document.querySelector("#add-personal-library-button")?.addEventListener("click", () => {
    void openPersonalLibraryModal();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-edit-personal-library]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openPersonalLibraryEditModal(button.dataset.editPersonalLibrary ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-delete-personal-library]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void deletePersonalLibrary(button.dataset.deletePersonalLibrary ?? "");
    });
  });

  document.querySelector("#vault-unlock-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void unlockPersonalVault(event.currentTarget as HTMLFormElement);
  });

  document.querySelector("#lock-vault-button")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void lockPersonalVault();
  });

  document.querySelector("[data-vault-menu]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.vaultMenuOpen = !state.vaultMenuOpen;
    renderShell();
  });

  document.querySelector("#lock-vault-sidebar-button")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void lockPersonalVault();
  });

  document.querySelector("#add-collection-button")?.addEventListener("click", openCollectionModal);
  document.querySelector("#add-user-button")?.addEventListener("click", () => openAdminUserModal("create"));
  document.querySelector("#invite-user-button")?.addEventListener("click", () => openAdminUserModal("invite"));

  document.querySelector("#close-library-modal")?.addEventListener("click", closeLibraryModal);
  document.querySelector("#cancel-library-modal")?.addEventListener("click", closeLibraryModal);
  document.querySelector("#close-collection-modal")?.addEventListener("click", closeCollectionModal);
  document.querySelector("#cancel-collection-modal")?.addEventListener("click", closeCollectionModal);
  document.querySelector("#close-collection-share-modal")?.addEventListener("click", closeCollectionShareModal);
  document.querySelector("#cancel-collection-share-modal")?.addEventListener("click", closeCollectionShareModal);
  document.querySelector("#close-collection-delete-modal")?.addEventListener("click", closeCollectionDeleteModal);
  document.querySelector("#cancel-collection-delete-modal")?.addEventListener("click", closeCollectionDeleteModal);
  document.querySelector("#confirm-collection-delete")?.addEventListener("click", () => {
    void deleteCollection();
  });
  document.querySelector("#close-user-modal")?.addEventListener("click", closeAdminUserModal);
  document.querySelector("#cancel-user-modal")?.addEventListener("click", closeAdminUserModal);
  document.querySelector("#user-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAdminUserForm(event.currentTarget as HTMLFormElement);
  });

  document.querySelector("#create-link-invite-button")?.addEventListener("click", (event) => {
    const form = (event.currentTarget as HTMLElement).closest("form");
    if (form instanceof HTMLFormElement) {
      void createLinkOnlyInvite(form);
    }
  });
  document.querySelector("#close-user-delete-modal")?.addEventListener("click", closeAdminUserDeleteModal);
  document.querySelector("#cancel-user-delete-modal")?.addEventListener("click", closeAdminUserDeleteModal);
  document.querySelector("#confirm-user-delete")?.addEventListener("click", () => {
    void deleteAdminUser();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-open-person]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activePeopleUserId = button.dataset.openPerson ?? null;
      renderShell();
    });
  });

  document.querySelector("#back-to-people")?.addEventListener("click", () => {
    state.activePeopleUserId = null;
    renderShell();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-edit-user]").forEach((button) => {
    button.addEventListener("click", () => {
      openAdminUserModal("edit", button.dataset.editUser ?? null);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-delete-user]").forEach((button) => {
    button.addEventListener("click", () => {
      openAdminUserDeleteModal(button.dataset.deleteUser ?? "");
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-copy-invite]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(state.adminUserInviteUrl);
    });
  });
  document.querySelector("#collection-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void createCollection();
  });
  document.querySelector("#collection-share-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCollectionSharing(event.currentTarget as HTMLFormElement);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-edit-collection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startCollectionEdit(button.dataset.editCollection ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-share-collection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openCollectionShareModal(button.dataset.shareCollection ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-delete-collection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openCollectionDeleteModal(button.dataset.deleteCollection ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-cancel-collection-edit]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      cancelCollectionEdit();
    });
  });

  document.querySelectorAll<HTMLFormElement>("[data-collection-edit-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveCollectionEdit(form);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-collection-content]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void removeFromCollection(button.dataset.removeCollectionContent ?? "", button.dataset.contentId ?? "");
    });
  });

  document.querySelector("#profile-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveProfile(event.currentTarget as HTMLFormElement);
  });

  document.querySelector("#edit-profile-button")?.addEventListener("click", () => {
    state.profileEditing = true;
    state.profileError = "";
    renderShell();
  });

  document.querySelector("#cancel-profile-edit")?.addEventListener("click", () => {
    state.profileEditing = false;
    state.profileError = "";
    state.profileFavoriteSearch = "";
    renderShell();
  });

  document.querySelector("#profile-favorite-search")?.addEventListener("input", (event) => {
    state.profileFavoriteSearch = (event.currentTarget as HTMLInputElement).value;
    renderShell();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-add-profile-favorite]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      addProfileFavorite(button.dataset.addProfileFavorite ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-profile-favorite]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      removeProfileFavorite(button.dataset.removeProfileFavorite ?? "");
    });
  });

  document.querySelector("#remove-profile-avatar")?.addEventListener("click", (event) => {
    event.preventDefault();
    void removeProfileAvatar();
  });

  document.querySelector("#library-next-button")?.addEventListener("click", () => {
    const nextStep = getNextLibraryModalStep(state.libraryModalStep);
    if (!canMoveLibraryStep(nextStep)) {
      renderShell();
      return;
    }
    state.libraryModalStep = nextStep;
    renderShell();
  });

  document.querySelector("#library-back-button")?.addEventListener("click", () => {
    syncLibraryDraftFromInputs();
    state.libraryModalError = "";
    state.libraryModalStep = getPreviousLibraryModalStep(state.libraryModalStep);
    renderShell();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-library-modal-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextStep = button.dataset.libraryModalStep as AppState["libraryModalStep"];
      if (!canMoveLibraryStep(nextStep)) {
        renderShell();
        return;
      }
      state.libraryModalStep = nextStep;
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-folder-path]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await loadFolderBrowser(button.dataset.folderPath);
        renderShell();
      } catch (error) {
        state.libraryModalError = error instanceof Error ? error.message : "Não foi possível carregar a pasta.";
        renderShell();
      }
    });
  });

  document.querySelector("#select-current-folder")?.addEventListener("click", () => {
    if (!state.folderBrowser) {
      return;
    }
    state.libraryDraft.path = state.folderBrowser.path;
    renderShell();
  });

  document.querySelector("#create-library-button")?.addEventListener("click", async () => {
    syncLibraryDraftFromInputs();
    if (!canMoveLibraryStep("advanced")) {
      renderShell();
      return;
    }
    try {
      const editingLibraryId = state.editingLibraryId;
      const { library } = await api<{ library: Library }>(
        editingLibraryId ? `/api/libraries/${encodeURIComponent(editingLibraryId)}` : "/api/libraries",
        {
          method: editingLibraryId ? "PATCH" : "POST",
          body: JSON.stringify({
            name: state.libraryDraft.name,
            kind: state.libraryDraft.kind,
            path: state.libraryDraft.path,
            isPersonal: state.libraryDraft.isPersonal
          })
        }
      );
      const wasPersonal = state.libraryDraft.isPersonal;
      state.libraryModalOpen = false;
      resetLibraryDraft();
      if (wasPersonal) {
        state.personalLibraries = editingLibraryId
          ? state.personalLibraries.map((item) => item.id === library.id ? library : item)
          : [...state.personalLibraries, library];
        await refreshPersonalVault();
      } else {
        await refreshLibraries();
      }
      renderShell();
    } catch (error) {
      state.libraryModalError = error instanceof Error ? error.message : "Não foi possível criar a biblioteca.";
      renderShell();
    }
  });

  document.querySelector("#logout-button")?.addEventListener("click", async () => {
    await api<void>("/api/logout", { method: "POST" });
    clearVaultInactivityTimer();
    state.user = null;
    state.personalLibraries = [];
    state.vaultUnlocked = false;
    state.vaultToken = "";
    state.vaultError = "";
    lastVaultTouchAt = 0;
    state.accountMenuOpen = false;
    renderLogin();
  });

  document.querySelector("#search")?.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const input = keyboardEvent.target as HTMLInputElement;
    if (keyboardEvent.key === "Tab") {
      const suggestion = getLibraryAutocomplete(input.value);
      if (!suggestion) {
        return;
      }

      keyboardEvent.preventDefault();
      input.value = suggestion;
      input.setSelectionRange(suggestion.length, suggestion.length);
      updateSearchSuggestion(input);
      return;
    }

    if (keyboardEvent.key !== "Enter") {
      return;
    }

    const scopedLibrary = getScopedLibraryOnly(input.value);
    state.search = input.value;
    input.value = "";
    updateSearchSuggestion(input);
    if (scopedLibrary) {
      state.search = "";
      void loadLibrary(scopedLibrary.id);
      return;
    }

    renderShell();
  });

  document.querySelector("#search")?.addEventListener("input", (event) => {
    updateSearchSuggestion(event.target as HTMLInputElement);
  });

  document.querySelector("#search")?.addEventListener("blur", (event) => {
    const input = event.target as HTMLInputElement;
    input.value = "";
    updateSearchSuggestion(input);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-nav-view]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-vault-menu], #lock-vault-sidebar-button, .library-context-menu")) {
        return;
      }
      state.activeView = (button.dataset.navView as AppState["activeView"]) ?? "home";
      state.activeLibraryId = null;
      state.activeSeriesId = null;
      state.openSeriesMenuId = null;
      state.openSeriesAddMenuId = null;
      state.openSeriesRemoveMenuId = null;
      state.activePeopleUserId = null;
      state.vaultMenuOpen = false;
      state.reader = null;
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextSection = button.dataset.settingsSection as AppState["settingsSection"];
      if (nextSection === "server" && state.user?.role !== "admin") {
        return;
      }

      state.settingsSection = nextSection;
      if (nextSection === "server") {
        state.serverSection = "libraries";
      }
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-server-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextSection = button.dataset.serverSection as AppState["serverSection"];
      if (state.user?.role !== "admin") {
        return;
      }

      state.settingsSection = "server";
      state.serverSection = nextSection;
      renderShell();
    });
  });

  document.querySelector("#vault-settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveVaultSettings(event.currentTarget as HTMLFormElement);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-library-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-library-menu-id], [data-scan-library-id], .library-context-menu")) {
        return;
      }

      state.openLibraryMenuId = null;
      state.activeSeriesId = null;
      void loadLibrary(button.dataset.libraryId ?? "");
    });
  });

  document.querySelectorAll<HTMLElement>("[data-library-menu-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const libraryId = button.dataset.libraryMenuId ?? "";
      state.openLibraryMenuId = state.openLibraryMenuId === libraryId ? null : libraryId;
      renderShell();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-scan-library-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.openLibraryMenuId = null;
      void scanLibraryById(button.dataset.scanLibraryId ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-open]").forEach((button) => {
    button.addEventListener("click", () => {
      state.openSeriesMenuId = null;
      state.openSeriesAddMenuId = null;
      state.openSeriesRemoveMenuId = null;
      void openSeries(button.dataset.seriesOpen ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-menu-key]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menuKey = button.dataset.seriesMenuKey ?? "";
      const isOpen = state.openSeriesMenuId === menuKey;
      state.openSeriesMenuId = isOpen ? null : menuKey;
      state.openSeriesAddMenuId = null;
      state.openSeriesRemoveMenuId = null;
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-add-menu-key]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menuKey = button.dataset.seriesAddMenuKey ?? "";
      state.openSeriesAddMenuId = menuKey;
      state.openSeriesRemoveMenuId = null;
      renderShell();
    });
    button.addEventListener("mouseenter", () => {
      const menuKey = button.dataset.seriesAddMenuKey ?? "";
      if (state.openSeriesAddMenuId === menuKey) {
        return;
      }

      state.openSeriesAddMenuId = menuKey;
      state.openSeriesRemoveMenuId = null;
      renderShell();
    });
    button.addEventListener("focus", () => {
      const menuKey = button.dataset.seriesAddMenuKey ?? "";
      if (state.openSeriesAddMenuId === menuKey) {
        return;
      }

      state.openSeriesAddMenuId = menuKey;
      state.openSeriesRemoveMenuId = null;
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-remove-menu-key]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menuKey = button.dataset.seriesRemoveMenuKey ?? "";
      state.openSeriesRemoveMenuId = menuKey;
      state.openSeriesAddMenuId = null;
      renderShell();
    });
    button.addEventListener("mouseenter", () => {
      const menuKey = button.dataset.seriesRemoveMenuKey ?? "";
      if (state.openSeriesRemoveMenuId === menuKey) {
        return;
      }

      state.openSeriesRemoveMenuId = menuKey;
      state.openSeriesAddMenuId = null;
      renderShell();
    });
    button.addEventListener("focus", () => {
      const menuKey = button.dataset.seriesRemoveMenuKey ?? "";
      if (state.openSeriesRemoveMenuId === menuKey) {
        return;
      }

      state.openSeriesRemoveMenuId = menuKey;
      state.openSeriesAddMenuId = null;
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-add-want]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void addToWantToRead(button.dataset.addWant ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-add-reading-list]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void addToReadingList(button.dataset.addReadingList ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-add-collection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void addToCollection(button.dataset.addCollection ?? "", button.dataset.contentId ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-want]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void removeFromWantToRead(button.dataset.removeWant ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-reading-list]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void removeFromReadingList(button.dataset.removeReadingList ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-collection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void removeFromCollection(button.dataset.removeCollection ?? "", button.dataset.contentId ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-mark-read]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void markSeriesRead(button.dataset.seriesMarkRead ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-mark-unread]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void markSeriesUnread(button.dataset.seriesMarkUnread ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-scan]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void scanSeries(button.dataset.seriesScan ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-continue]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const content = findContentById(button.dataset.seriesContinue ?? "");
      if (!content) {
        return;
      }

      openReaderAtProgress(content);
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-mark-toggle]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const contentId = button.dataset.seriesMarkToggle ?? "";
      await toggleSeriesMark(contentId);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-back]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSeriesId = null;
      state.seriesTab = "chapters";
      state.seriesReviewError = "";
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-chapter-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const content = findContentById(button.dataset.chapterOpen ?? "");
      if (!content) {
        return;
      }

      const startPage = Number(button.dataset.chapterStart ?? "0");
      openReader(content, startPage);
      renderShell();
    });
  });

  document.querySelector("#close-reader")?.addEventListener("click", () => {
    state.reader = null;
    renderShell();
  });

  document.querySelector("#toggle-mode")?.addEventListener("click", () => {
    if (!state.reader) {
      return;
    }

    state.reader.mode = getNextReaderMode(state.reader.mode);
    state.reader.controlsVisible = true;
    renderShell();
    if (state.reader.mode === "vertical-scroll") {
      requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-reader-toggle-controls]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (!state.reader) {
        return;
      }
      state.reader.controlsVisible = !state.reader.controlsVisible;
      renderShell();
    });
  });

  document.querySelector("#reader-stage")?.addEventListener("click", (event) => {
    if (!state.reader || state.reader.mode !== "vertical-scroll") {
      return;
    }
    if ((event.target as HTMLElement).closest(".reader-image, .reader-pdf, .reader-overlay, button, input")) {
      return;
    }
    syncReaderPageFromScroll();
    state.reader.controlsVisible = !state.reader.controlsVisible;
    renderShell();
    requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
  });

  document.querySelector("#reader-stage")?.addEventListener("scroll", () => {
    if (!state.reader || state.reader.mode !== "vertical-scroll") {
      return;
    }
    syncReaderPageFromScroll();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-page-step]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!state.reader) {
        return;
      }

      const step = Number(button.dataset.pageStep);
      await setReaderPage(state.reader.page + step);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-chapter-step]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!state.reader) {
        return;
      }

      const direction = Number(button.dataset.chapterStep) < 0 ? -1 : 1;
      await setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, direction));
    });
  });

  document.querySelector<HTMLInputElement>("[data-reader-page-slider]")?.addEventListener("change", (event) => {
    event.stopPropagation();
    void setReaderPage(Number((event.currentTarget as HTMLInputElement).value));
  });

  document.querySelector("#bookmark-page")?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!state.reader || !state.user) {
      return;
    }

    if (state.reader.mode === "vertical-scroll") {
      syncReaderPageFromScroll();
    }

    const contentId = state.reader.content.id;
    const page = state.reader.page;
    const previousBookmarks = state.bookmarks;
    const existingBookmark = previousBookmarks.find((bookmark) => bookmark.contentId === contentId && bookmark.page === page);

    state.reader.controlsVisible = true;
    state.bookmarks = existingBookmark
      ? previousBookmarks.filter((bookmark) => !(bookmark.contentId === contentId && bookmark.page === page))
      : [
          ...previousBookmarks,
          {
            userId: state.user.id,
            contentId,
            page,
            createdAt: new Date().toISOString()
          }
        ];
    renderShell();
    if (state.reader.mode === "vertical-scroll") {
      requestAnimationFrame(() => scrollReaderToPage(page));
    }

    try {
      await api<{ marked: boolean }>("/api/bookmarks", {
        method: "POST",
        body: JSON.stringify({ contentId, page })
      });
      const { bookmarks } = await api<{ bookmarks: Bookmark[] }>("/api/bookmarks");
      state.bookmarks = bookmarks;
      renderShell();
      if (state.reader?.mode === "vertical-scroll") {
        requestAnimationFrame(() => scrollReaderToPage(page));
      }
    } catch (error) {
      console.error(error);
      state.bookmarks = previousBookmarks;
      renderShell();
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-reader-bookmark-page]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!state.reader) {
        return;
      }

      const page = Number(button.dataset.readerBookmarkPage ?? "0");
      state.reader.mode = "horizontal";
      await setReaderPage(page);
    });
  });

  document.querySelectorAll<HTMLSelectElement>("[data-series-order]").forEach((select) => {
    select.addEventListener("change", () => {
      state.seriesChapterOrder = select.value as AppState["seriesChapterOrder"];
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-layout]").forEach((button) => {
    button.addEventListener("click", () => {
      state.seriesChapterLayout = button.dataset.seriesLayout === "grid" ? "grid" : "list";
      renderShell();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-series-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextTab = button.dataset.seriesTab as AppState["seriesTab"];
      state.seriesTab = nextTab;
      state.seriesReviewError = "";
      if (nextTab === "reviews" && state.activeSeriesId && !state.seriesReviews[state.activeSeriesId]) {
        await loadSeriesReviews(state.activeSeriesId);
      }
      renderShell();
    });
  });

  document.querySelectorAll<HTMLFormElement>("[data-review-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const content = getSelectedSeries();
      if (!content) {
        return;
      }

      const formData = new FormData(form);
      const rating = Number(formData.get("rating"));
      const comment = String(formData.get("comment") ?? "").trim();
      if (!Number.isFinite(rating) || rating < 0 || rating > 10 || !comment) {
        state.seriesReviewError = "Informe uma nota entre 0 e 10 e um comentário.";
        renderShell();
        return;
      }

      try {
        state.seriesReviewError = "";
        await api<{ review: PublicContentReview }>("/api/reviews", {
          method: "POST",
          body: JSON.stringify({
            contentId: content.id,
            rating,
            comment
          })
        });
        await loadSeriesReviews(content.id);
        await refreshProfileReviews();
        renderShell();
      } catch (error) {
        state.seriesReviewError = error instanceof Error ? error.message : "Não foi possível salvar sua review.";
        renderShell();
      }
    });
  });
}

function findContentById(contentId: string): ContentItem | null {
  return getAvailableContents().find((item) => item.id === contentId) ?? null;
}

function getSelectedSeries(): ContentItem | null {
  if (!state.activeSeriesId) {
    return null;
  }

  return findContentById(state.activeSeriesId);
}

function getProgressForContent(contentId: string): ReadingProgress | null {
  return state.progress.find((progress) => progress.contentId === contentId) ?? null;
}

function getBookmarksForContent(contentId: string): Bookmark[] {
  return state.bookmarks
    .filter((bookmark) => bookmark.contentId === contentId)
    .sort((a, b) => a.page - b.page);
}

function isPageBookmarked(contentId: string, page: number): boolean {
  return state.bookmarks.some((bookmark) => bookmark.contentId === contentId && bookmark.page === page);
}

async function setReaderPage(page: number): Promise<void> {
  if (!state.reader) {
    return;
  }

  const mode = state.reader.mode;
  const contentId = state.reader.content.id;
  const maxPage = Math.max(state.reader.content.pageCount - 1, 0);
  state.reader.page = Math.min(Math.max(page, 0), maxPage);
  const currentPage = state.reader.page;
  renderShell();
  if (mode === "vertical-scroll") {
    requestAnimationFrame(() => scrollReaderToPage(currentPage));
  }

  try {
    await api<void>("/api/progress", {
      method: "PUT",
      body: JSON.stringify({ contentId, currentPage })
    });
    await refreshProgress();
  } catch (error) {
    console.error(error);
  }
}

function openReader(content: ContentItem, page: number): void {
  const safePage = Math.min(Math.max(page, 0), Math.max(content.pageCount - 1, 0));
  state.reader = { content, page: safePage, mode: "vertical-scroll", controlsVisible: false };
  state.activeSeriesId = content.id;
}

function syncReaderPageFromScroll(): void {
  if (!state.reader || state.reader.mode !== "vertical-scroll") {
    return;
  }

  const visiblePage = getVisibleReaderPage();
  if (visiblePage === null) {
    return;
  }
  state.reader.page = visiblePage;
}

function getVisibleReaderPage(): number | null {
  const stage = document.querySelector<HTMLElement>("#reader-stage");
  const pages = Array.from(document.querySelectorAll<HTMLElement>("[data-reader-page-index]"));
  if (!stage || pages.length === 0) {
    return null;
  }

  const stageRect = stage.getBoundingClientRect();
  const focusY = stageRect.top + stageRect.height * 0.45;
  let closestPage: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const page of pages) {
    const rect = page.getBoundingClientRect();
    const pageCenter = rect.top + rect.height / 2;
    const distance = Math.abs(pageCenter - focusY);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestPage = Number(page.dataset.readerPageIndex ?? "0");
    }
  }

  return closestPage;
}

function scrollReaderToPage(page: number): void {
  const target = document.querySelector<HTMLElement>(`[data-reader-page-index="${page}"]`);
  target?.scrollIntoView({ block: "start", inline: "nearest" });
}

function openReaderAtProgress(content: ContentItem): void {
  const progress = getProgressForContent(content.id);
  openReader(content, progress?.currentPage ?? 0);
}

async function openSeries(contentId: string): Promise<void> {
  const content = findContentById(contentId);
  if (!content) {
    return;
  }

  state.activeSeriesId = content.id;
  state.seriesTab = "chapters";
  state.seriesReviewError = "";
  state.reader = null;
  renderShell();
  await loadSeriesReviews(content.id);
  renderShell();
}

async function loadSeriesReviews(contentId: string): Promise<void> {
  const { reviews } = await api<{ reviews: PublicContentReview[] }>(`/api/reviews?contentId=${encodeURIComponent(contentId)}`);
  state.seriesReviews = {
    ...state.seriesReviews,
    [contentId]: reviews
  };
}

async function refreshProfileReviews(): Promise<void> {
  const { reviews } = await api<{ reviews: PublicContentReview[] }>("/api/me/reviews");
  state.profileReviews = reviews;
}

async function refreshSeriesMarks(): Promise<void> {
  const { seriesMarks } = await api<{ seriesMarks: string[] }>("/api/series-marks");
  state.seriesMarks = seriesMarks;
}

async function refreshUserLists(): Promise<void> {
  const { wantToRead, readingList, collections } = await api<{ wantToRead: string[]; readingList: string[]; collections: UserCollection[] }>("/api/user-lists");
  state.wantToRead = wantToRead;
  state.readingList = readingList;
  state.collections = collections;
}

async function toggleSeriesMark(contentId: string): Promise<void> {
  if (!contentId) {
    return;
  }

  await api<{ marked: boolean }>("/api/series-marks", {
    method: "POST",
    body: JSON.stringify({ contentId })
  });
  await refreshSeriesMarks();
  renderShell();
}

async function addToWantToRead(contentId: string): Promise<void> {
  if (!contentId) {
    return;
  }

  await api<void>("/api/want-to-read", {
    method: "POST",
    body: JSON.stringify({ contentId })
  });
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  await refreshUserLists();
  renderShell();
}

async function addToReadingList(contentId: string): Promise<void> {
  if (!contentId) {
    return;
  }

  await api<void>("/api/reading-list", {
    method: "POST",
    body: JSON.stringify({ contentId })
  });
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  await refreshUserLists();
  renderShell();
}

async function addToCollection(collectionId: string, contentId: string): Promise<void> {
  if (!collectionId || !contentId) {
    return;
  }

  await api<{ collection: UserCollection }>(`/api/collections/${encodeURIComponent(collectionId)}/contents`, {
    method: "POST",
    body: JSON.stringify({ contentId })
  });
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  await refreshUserLists();
  renderShell();
}

async function removeFromWantToRead(contentId: string): Promise<void> {
  if (!contentId) {
    return;
  }

  await api<void>(`/api/want-to-read?contentId=${encodeURIComponent(contentId)}`, { method: "DELETE" });
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  await refreshUserLists();
  renderShell();
}

async function removeFromReadingList(contentId: string): Promise<void> {
  if (!contentId) {
    return;
  }

  await api<void>(`/api/reading-list?contentId=${encodeURIComponent(contentId)}`, { method: "DELETE" });
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  await refreshUserLists();
  renderShell();
}

async function removeFromCollection(collectionId: string, contentId: string): Promise<void> {
  if (!collectionId || !contentId) {
    return;
  }

  await api<{ collection: UserCollection }>(
    `/api/collections/${encodeURIComponent(collectionId)}/contents?contentId=${encodeURIComponent(contentId)}`,
    { method: "DELETE" }
  );
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  await refreshUserLists();
  renderShell();
}

async function refreshProgress(): Promise<void> {
  const { progress } = await api<{ progress: ReadingProgress[] }>("/api/continue");
  state.progress = progress;
}

async function markSeriesRead(contentId: string): Promise<void> {
  const content = findContentById(contentId);
  if (!content) {
    return;
  }

  await api<void>("/api/progress", {
    method: "PUT",
    body: JSON.stringify({ contentId, currentPage: Math.max(content.pageCount - 1, 0) })
  });
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  await refreshProgress();
  renderShell();
}

async function markSeriesUnread(contentId: string): Promise<void> {
  if (!contentId) {
    return;
  }

  await api<void>(`/api/progress?contentId=${encodeURIComponent(contentId)}`, { method: "DELETE" });
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  await refreshProgress();
  renderShell();
}

async function scanSeries(contentId: string): Promise<void> {
  const content = findContentById(contentId);
  if (!content) {
    return;
  }

  state.scanMessage = `Escaneando ${content.title}...`;
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
  renderShell();
  try {
    await api<{ content: ContentItem; scannedAt: string }>(`/api/contents/${encodeURIComponent(contentId)}/scan`, {
      method: "POST"
    });
    await refreshLibraries();
    if (state.activeLibraryId) {
      const { contents } = await api<{ contents: ContentItem[] }>(`/api/libraries/${state.activeLibraryId}/contents`);
      state.contents = contents;
    }
    state.scanMessage = `${content.title}: série verificada na pasta padrão.`;
    renderShell();
  } catch (error) {
    state.scanMessage = error instanceof Error ? error.message : "Não foi possível escanear a série.";
    renderShell();
  }
}

function getContentsByIds(contentIds: string[]): ContentItem[] {
  const contents = getAvailableContents();
  const seen = new Set<string>();
  return contentIds
    .map((contentId) => contents.find((content) => content.id === contentId))
    .filter((content): content is ContentItem => {
      if (!content || seen.has(content.id)) {
        return false;
      }
      seen.add(content.id);
      return true;
    });
}

function getAvailableContents(): ContentItem[] {
  const byId = new Map<string, ContentItem>();
  for (const content of [...state.homeContents, ...state.contents]) {
    byId.set(content.id, content);
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { numeric: true }));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

void boot();

document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.key.toLowerCase() !== "y") {
    return;
  }

  event.preventDefault();
  document.querySelector<HTMLInputElement>("#search")?.focus();
});
