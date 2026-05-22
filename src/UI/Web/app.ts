import type {
  Bookmark,
  ContentItem,
  Invitation,
  Library,
  LibraryKind,
  PublicContentReview,
  PublicUser,
  ReadingProgress,
  ServerSettings
} from "../../shared/types.js";
import { renderIcon, renderSidebarIcon } from "./components/icons.js";
import { renderAvatar } from "./components/avatar.js";
import { renderSidebar } from "./components/layout/sidebar.js";
import { renderTopbar } from "./components/layout/topbar.js";
import { renderSeriesCard } from "./components/series-card.js";
import { api } from "./services/api.js";
import { filterContents, normalizeText, parseSearch } from "./services/search.js";
import { state } from "./state/store.js";
import type { AppState, FittingMode, GoogleAccounts, GoogleConfig, PeopleUser, ReaderMode, UserCollection } from "./state/types.js";
import { renderHomeView } from "./views/home.js";
import { renderLibraryView } from "./views/library.js";
import { renderContentListView, renderEmptyMedia, renderNoSearchResults, renderPlaceholderView } from "./views/shared.js";

let vaultInactivityTimer: number | null = null;
let lastVaultTouchAt = 0;
let vaultTouchInFlight = false;
let libraryLoadRequestId = 0;
let passwordResetTokenPath = "";

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

function renderReaderModeIcon(): string {
  if (!state.reader) {
    return "↕";
  }
  if (state.reader.mode === "horizontal") {
    return "↔";
  }
  return "↕";
}

function isReaderFullscreen(): boolean {
  return Boolean(document.fullscreenElement);
}

function isMobileViewport(): boolean {
  return window.matchMedia("(max-width: 760px)").matches;
}

function renderReaderFullscreenIcon(): string {
  return isReaderFullscreen() ? "⤢" : "⛶";
}

function getReaderFullscreenLabel(): string {
  return isReaderFullscreen() ? "Sair da tela cheia" : "Tela cheia";
}

function getPasswordResetTokenFromPath(): string {
  const parts = window.location.pathname.split("/");
  return decodeURIComponent(parts[2] ?? "").trim();
}

function clearPasswordResetState(): void {
  state.passwordResetOpen = false;
  state.passwordResetEmail = "";
  state.passwordResetMessage = "";
  state.passwordResetError = "";
  passwordResetTokenPath = "";
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
  if (element && !element.closest(".stats-menu-shell") && state.statsMenuOpen) {
    state.statsMenuOpen = false;
    renderShell();
    return;
  }

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

function closeNavigationPanels(): void {
  state.accountMenuOpen = false;
  state.statsMenuOpen = false;
  state.vaultMenuOpen = false;
  state.openLibraryMenuId = null;
  state.openSeriesMenuId = null;
  state.openSeriesAddMenuId = null;
  state.openSeriesRemoveMenuId = null;
}

function closeMobileNavigation(): void {
  state.mobileNavOpen = false;
}

function openView(view: AppState["activeView"]): void {
  closeNavigationPanels();
  closeMobileNavigation();
  state.activeView = view;
  state.activeLibraryId = null;
  state.activeSeriesId = null;
  state.activePeopleUserId = null;
  state.reader = null;
  renderShell();
}

document.addEventListener("click", (event) => {
  closeFloatingMenusFromOutside(event.target);
});

["click", "keydown", "pointermove", "scroll"].forEach((eventName) => {
  document.addEventListener(eventName, registerVaultActivity, { passive: true });
});

function applyTheme(): void {
  document.documentElement.dataset.theme = state.darkMode ? "dark" : "light";
}

function renderLoadingScreen(message = "Carregando obras", description = "Preparando as bibliotecas disponíveis para você."): void {
  app.innerHTML = `
    <main class="boot-loading-screen" aria-live="polite" aria-busy="true">
      <section class="boot-loading-panel">
        <div class="boot-loading-brand">
          <span class="brand-badge">${renderSidebarIcon("book", "Pugotiread")}</span>
          <strong>Pugotiread</strong>
        </div>
        <div class="boot-loading-orbit" aria-hidden="true">
          <span></span>
        </div>
        <div class="boot-loading-copy">
          <h1>${escapeHtml(message)}</h1>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="boot-loading-skeleton" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
          <span></span>
        </div>
      </section>
    </main>
  `;
}

async function boot(): Promise<void> {
  applyTheme();
  if (window.location.pathname.startsWith("/reset-password/")) {
    passwordResetTokenPath = getPasswordResetTokenFromPath();
    if (!passwordResetTokenPath) {
      renderPasswordResetPage("Link de confirmação inválido.");
      return;
    }
    renderPasswordResetPage();
    return;
  }

  if (window.location.pathname.startsWith("/invite/")) {
    state.invitePathToken = decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
    await loadInviteFlow();
    return;
  }

  try {
    renderLoadingScreen("Entrando no Pugotiread", "Validando sua sessão antes de carregar as obras.");
    const payload = await api<{ user: PublicUser }>("/api/me");
    state.user = payload.user;
    if (state.user.needsNickname) {
      renderNicknameSetup();
      return;
    }
    renderLoadingScreen();
    await loadHome();
  } catch {
    try {
      const setup = await api<{ setupRequired: boolean }>("/api/setup/status");
      state.setupRequired = setup.setupRequired;
      if (state.setupRequired) {
        renderInitialSetup();
        return;
      }
    } catch {
      // Fall through to the login screen if setup status cannot be read.
    }

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
  const { users } = usersPayload as { users: PeopleUser[] };

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
  const requestId = ++libraryLoadRequestId;
  state.activeLibraryId = libraryId;
  state.activeSeriesId = null;
  state.activeView = "library";
  state.reader = null;
  state.search = "";
  state.contents = [];
  state.loadingLibraryId = libraryId;
  state.libraryLoadError = "";
  renderShell();

  try {
    const { contents } = await api<{ contents: ContentItem[] }>(`/api/libraries/${libraryId}/contents`);
    if (requestId !== libraryLoadRequestId) {
      return;
    }
    state.contents = contents;
    state.libraryLoadError = "";
  } catch (error) {
    if (requestId !== libraryLoadRequestId) {
      return;
    }
    state.contents = [];
    state.libraryLoadError = error instanceof Error ? error.message : "Não foi possível carregar a biblioteca.";
  } finally {
    if (requestId !== libraryLoadRequestId) {
      return;
    }
    state.loadingLibraryId = null;
  }
  renderShell();
}

function renderLogin(error = ""): void {
  if (state.passwordResetOpen) {
    app.innerHTML = `
      <main class="login-shell">
        ${renderPasswordResetRequestSection()}
      </main>
    `;

    document.querySelector("#close-password-reset")?.addEventListener("click", () => {
      state.passwordResetOpen = false;
      state.passwordResetMessage = "";
      state.passwordResetError = "";
      renderLogin(error);
    });

    document.querySelector<HTMLFormElement>("#password-reset-request-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const email = String(form.get("email") ?? "").trim();
      state.passwordResetEmail = email;
      state.passwordResetMessage = "";
      state.passwordResetError = "";

      try {
        await api<{ message: string }>("/api/password-reset/request", {
          method: "POST",
          body: JSON.stringify({ email })
        });
        state.passwordResetMessage = "Se o e-mail estiver cadastrado, você receberá um link para trocar a senha.";
        renderLogin(error);
      } catch (resetError) {
        state.passwordResetError = resetError instanceof Error ? resetError.message : "Não foi possível solicitar a troca de senha.";
        renderLogin(error);
      }
    });
    return;
  }

  app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel" id="login-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">A sua plataforma de leitura digital.</p>
        <label class="form-row">
          <span>Usuário</span>
          <input class="input" name="username" autocomplete="username" />
        </label>
        <label class="form-row">
          <span>Senha</span>
          <input class="input" type="password" name="password" autocomplete="current-password" />
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <button class="button" type="submit">Entrar</button>
        <button class="link-button" id="toggle-password-reset" type="button">Esqueci minha senha</button>
      </form>
      ${state.passwordResetOpen ? renderPasswordResetRequestSection() : ""}
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
      const message = loginError instanceof Error ? loginError.message : "Falha no login.";
      if (message.toLowerCase().includes("setup") || message.toLowerCase().includes("configurado")) {
        state.setupRequired = true;
        renderInitialSetup(message);
        return;
      }
      renderLogin(message);
    }
  });

  document.querySelector("#toggle-password-reset")?.addEventListener("click", () => {
    state.passwordResetOpen = !state.passwordResetOpen;
    if (!state.passwordResetOpen) {
      state.passwordResetEmail = "";
      state.passwordResetMessage = "";
      state.passwordResetError = "";
    }
    renderLogin(error);
  });
}

function renderPasswordResetRequestSection(): string {
  return `
    <section class="login-reset-panel">
      <p class="muted">Informe o e-mail cadastrado para receber o link de troca de senha.</p>
      <form id="password-reset-request-form">
        <label class="form-row">
          <span>E-mail</span>
          <input class="input" name="email" type="email" autocomplete="email" value="${escapeHtml(state.passwordResetEmail)}" required />
        </label>
        ${state.passwordResetMessage ? `<p class="scan-message">${escapeHtml(state.passwordResetMessage)}</p>` : ""}
        ${state.passwordResetError ? `<p class="error">${escapeHtml(state.passwordResetError)}</p>` : ""}
        <div class="invite-form-actions">
          <button class="button secondary" id="close-password-reset" type="button">Voltar ao login</button>
          <button class="button" type="submit">Enviar link</button>
        </div>
      </form>
    </section>
  `;
}

function renderPasswordResetPage(error = ""): void {
  app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="password-reset-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Troca de senha</p>
        <p class="google-unavailable">Esse link precisa ser validado pelo e-mail cadastrado antes da senha ser trocada.</p>
        <label class="form-row">
          <span>Nova senha</span>
          <input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="12" required autofocus />
        </label>
        <label class="form-row">
          <span>Confirmar senha</span>
          <input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required />
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <div class="invite-form-actions">
          <button class="button secondary" id="back-to-login-from-reset" type="button">Voltar ao login</button>
          <button class="button" type="submit">Trocar senha</button>
        </div>
      </form>
    </main>
  `;

  document.querySelector("#back-to-login-from-reset")?.addEventListener("click", () => {
    window.history.replaceState({}, "", "/");
    clearPasswordResetState();
    renderLogin();
  });

  document.querySelector<HTMLFormElement>("#password-reset-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");

    if (newPassword !== confirmPassword) {
      renderPasswordResetPage("As senhas não conferem.");
      return;
    }

    try {
      await api<void>(`/api/password-reset/${encodeURIComponent(passwordResetTokenPath)}`, {
        method: "POST",
        body: JSON.stringify({ newPassword })
      });
      window.history.replaceState({}, "", "/");
      clearPasswordResetState();
      renderLogin("Senha alterada. Faça login novamente.");
    } catch (resetError) {
      renderPasswordResetPage(resetError instanceof Error ? resetError.message : "Não foi possível alterar a senha.");
    }
  });
}

function renderInitialSetup(error = ""): void {
  app.innerHTML = `
    <main class="login-shell">
      <form class="login-panel invite-panel" id="setup-form">
        <h1 class="brand">Pugotiread</h1>
        <p class="muted">Criar administrador inicial</p>
        <p class="google-unavailable">Nenhuma conta de administrador válida foi configurada ainda. Esta tela cria a primeira conta com acesso total.</p>
        <label class="form-row">
          <span>Usuário</span>
          <input class="input" name="username" autocomplete="username" maxlength="40" placeholder="admin" required autofocus />
        </label>
        <label class="form-row">
          <span>Nome público</span>
          <input class="input" name="displayName" autocomplete="name" maxlength="80" placeholder="Administrador" required />
        </label>
        <label class="form-row">
          <span>E-mail</span>
          <input class="input" name="email" type="email" autocomplete="email" placeholder="admin@local" required />
        </label>
        <label class="form-row">
          <span>Senha</span>
          <input class="input" name="password" type="password" autocomplete="new-password" minlength="12" required />
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <div class="invite-form-actions">
          <button class="button secondary" id="back-to-login" type="button">Usar conta existente</button>
          <button class="button" type="submit">Criar administrador</button>
        </div>
      </form>
    </main>
  `;

  document.querySelector("#back-to-login")?.addEventListener("click", () => {
    renderLogin();
  });

  document.querySelector<HTMLFormElement>("#setup-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);

    try {
      const payload = await api<{ user: PublicUser }>("/api/setup/admin", {
        method: "POST",
        body: JSON.stringify({
          username: String(form.get("username") ?? ""),
          displayName: String(form.get("displayName") ?? ""),
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? "")
        })
      });
      state.user = payload.user;
      state.setupRequired = false;
      if (state.user.needsNickname) {
        renderNicknameSetup();
        return;
      }
      await loadHome();
    } catch (setupError) {
      renderInitialSetup(setupError instanceof Error ? setupError.message : "Não foi possível criar o administrador.");
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
  const mobileNavOpen = state.mobileNavOpen && isMobileViewport();

  app.innerHTML = `
    <div class="app-shell${state.activeView === "settings" ? " settings-shell" : ""}${state.sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileNavOpen ? " mobile-nav-open" : ""}${state.reader ? " reader-active" : ""}">
      ${renderTopbar(userName)}
      <aside class="sidebar">
        ${renderSidebar()}
      </aside>
      ${mobileNavOpen ? `<button class="mobile-nav-backdrop" id="mobile-nav-backdrop" type="button" aria-label="Fechar menu"></button>` : ""}
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

  if (state.reader) {
    renderReaderOverlay();
  }
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
    const contents = filterContents(state.homeContents, state.search);
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
            <input class="input" id="vault-password-input" name="password" type="password" autocomplete="current-password" required />
          </label>
          ${state.vaultError ? `<p class="error vault-error">${escapeHtml(state.vaultError)}</p>` : ""}
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
  const favorites = getContentsByIdsFrom(getPublicContents(), user?.favoriteContentIds ?? []);
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
      ${renderProfilePasswordSection()}
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
          <div id="profile-favorite-results">
            ${renderProfileFavoriteResults(selectedIds)}
          </div>
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

function renderProfilePasswordSection(): string {
  const user = state.user;
  if (!user) {
    return "";
  }

  if (!user.canChangePassword) {
    return `
      <section class="settings-panel">
        <div class="series-section-heading">
          <h2>Senha</h2>
        </div>
        <p class="empty compact">Esta conta não pode alterar a própria senha.</p>
      </section>
    `;
  }

  if (user.passwordChangeRequiresEmailConfirmation) {
    return `
      <section class="settings-panel">
        <div class="series-section-heading">
          <h2>Senha</h2>
        </div>
        <p class="settings-lead">Esta conta confirma a troca por e-mail antes da senha ser alterada.</p>
        <button class="button" id="request-profile-password-reset" type="button">Enviar link para meu e-mail</button>
        ${state.profilePasswordMessage ? `<p class="scan-message" id="profile-password-message">${escapeHtml(state.profilePasswordMessage)}</p>` : ""}
        ${state.profilePasswordError ? `<p class="error" id="profile-password-error">${escapeHtml(state.profilePasswordError)}</p>` : ""}
      </section>
    `;
  }

  return `
    <form class="settings-panel" id="profile-password-form">
      <div class="series-section-heading">
        <h2>Senha</h2>
      </div>
      <div class="profile-password-grid">
        <label class="form-row">
          <span>Senha atual</span>
          <input class="input" name="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label class="form-row">
          <span>Nova senha</span>
          <input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="12" required />
        </label>
        <label class="form-row">
          <span>Confirmar nova senha</span>
          <input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required />
        </label>
      </div>
      ${state.profilePasswordError ? `<p class="error">${escapeHtml(state.profilePasswordError)}</p>` : ""}
      ${state.profilePasswordMessage ? `<p class="scan-message">${escapeHtml(state.profilePasswordMessage)}</p>` : ""}
      <div class="profile-actions">
        <button class="button" type="submit">Alterar senha</button>
      </div>
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
  const content = findPublicContentById(review.contentId);
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

  const results = getPublicContents()
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

function updateProfileFavoriteResults(): void {
  const container = document.querySelector<HTMLElement>("#profile-favorite-results");
  if (!container) {
    return;
  }

  const selectedIds = state.user?.favoriteContentIds ?? [];
  container.innerHTML = renderProfileFavoriteResults(selectedIds);
}

function getSettingsSectionTitle(): string {
  const titles: Record<AppState["settingsSection"], string> = {
    account: "Conta",
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

  return `
    <p class="settings-lead">Dados básicos da conta logada.</p>
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
      <div class="library-settings-row-info">
        <strong>${escapeHtml(library.name)}</strong>
        <p>${escapeHtml(library.path)}</p>
      </div>
      <span>${escapeHtml(library.kind)}</span>
      <span>${contentCount} títulos</span>
      <button class="button secondary" type="button" data-scan-library-id="${library.id}">Escanear</button>
      <div class="library-settings-row-actions">
        <button class="icon-button" data-edit-library="${escapeHtml(library.id)}" type="button" title="Editar biblioteca" aria-label="Editar biblioteca">${renderSidebarIcon("pencil", "Editar biblioteca")}</button>
        <button class="icon-button danger" data-delete-library="${escapeHtml(library.id)}" type="button" title="Apagar biblioteca" aria-label="Apagar biblioteca">${renderSidebarIcon("trash", "Apagar biblioteca")}</button>
      </div>
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

async function openLibraryEditModal(libraryId: string): Promise<void> {
  const library = state.libraries.find((item) => item.id === libraryId);
  if (!library) {
    return;
  }

  resetLibraryDraft();
  state.editingLibraryId = library.id;
  state.libraryDraft = {
    name: library.name,
    kind: library.kind,
    path: library.path,
    isPersonal: false
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
    role: "user",
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
        role: user.role,
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
    role: String(formData.get("role") ?? "user") === "admin" ? "admin" : "user",
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
    role: state.adminUserDraft.role,
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
        role: state.adminUserDraft.role,
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

async function savePersonCollectionRecommendations(form: HTMLFormElement): Promise<void> {
  const userId = form.dataset.personRecommendationForm ?? "";
  if (!userId) {
    return;
  }

  const selectedCollectionIds = new Set(new FormData(form).getAll("collectionId").map((value) => String(value)));
  const ownedCollections = getOwnedCollections();

  try {
    state.peopleShareError = "";
    await Promise.all(ownedCollections.map((collection) => {
      const sharedWithUserIds = new Set(collection.sharedWithUserIds);
      if (selectedCollectionIds.has(collection.id)) {
        sharedWithUserIds.add(userId);
      } else {
        sharedWithUserIds.delete(userId);
      }

      return api<{ collection: UserCollection }>(`/api/collections/${encodeURIComponent(collection.id)}/sharing`, {
        method: "PUT",
        body: JSON.stringify({ userIds: [...sharedWithUserIds] })
      });
    }));
    await refreshUserLists();
    renderShell();
  } catch (error) {
    state.peopleShareError = error instanceof Error ? error.message : "Não foi possível salvar as indicações.";
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

async function deletePublicLibrary(libraryId: string): Promise<void> {
  const library = state.libraries.find((item) => item.id === libraryId);
  if (!library || !confirm(`Apagar a biblioteca "${library.name}"? Os arquivos da pasta não serão removidos.`)) {
    return;
  }

  try {
    await api<void>(`/api/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
    state.libraries = state.libraries.filter((item) => item.id !== libraryId);
    state.homeContents = state.homeContents.filter((content) => content.libraryId !== libraryId);
    if (state.activeLibraryId === libraryId) {
      state.activeLibraryId = null;
      state.activeSeriesId = null;
      state.reader = null;
      state.activeView = "home";
    }
    renderShell();
  } catch (error) {
    state.libraryModalError = error instanceof Error ? error.message : "Não foi possível apagar a biblioteca.";
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

function toggleVaultMenuVisibility(): void {
  if (state.user?.role !== "admin") {
    return;
  }

  state.vaultHiddenFromMenu = !state.vaultHiddenFromMenu;
  localStorage.setItem("pugotiread-vault-hidden", String(state.vaultHiddenFromMenu));
  state.vaultMenuOpen = false;
  if (state.vaultHiddenFromMenu && state.activeView === "vault") {
    state.activeView = "home";
    state.activeLibraryId = null;
    state.activeSeriesId = null;
    state.reader = null;
  }
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

function getScopedLibraryOnly(search: string): Library | null {
  const parsed = parseSearch(search);
  if (!parsed.libraryId || parsed.query.length > 0) {
    return null;
  }

  return state.libraries.find((library) => library.id === parsed.libraryId) ?? null;
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

function getOwnedCollections(): UserCollection[] {
  return state.collections.filter((collection) => collection.userId === state.user?.id);
}

function renderPeopleView(): string {
  if (state.activePeopleUserId) {
    const user = state.peopleUsers.find((item) => item.id === state.activePeopleUserId);
    if (user) {
      return renderPublicUserProfile(user);
    }
  }

  const ownedCollections = getOwnedCollections();
  const people = state.peopleUsers.filter((user) => user.id !== state.user?.id);

  return `
    <section class="section-heading">
      <div>
        <h2>Pessoas</h2>
        <p class="muted">Veja perfis, obras favoritas e indique suas coleções para outros usuários.</p>
      </div>
      <span class="muted">${people.length} pessoas</span>
    </section>
    ${state.peopleShareError ? `<p class="error">${escapeHtml(state.peopleShareError)}</p>` : ""}
    ${
      people.length
        ? `<div class="people-list">${people.map((user) => renderPersonCard(user, ownedCollections)).join("")}</div>`
        : `<p class="empty">Nenhum outro usuário cadastrado.</p>`
    }
  `;
}

function renderPersonCard(user: PeopleUser, ownedCollections: UserCollection[]): string {
  const userName = getUserLabel(user);
  const favorites = getContentsByIds(user.favoriteContentIds);
  const indicatedCount = ownedCollections.filter((collection) => collection.sharedWithUserIds.includes(user.id)).length;

  return `
    <article class="person-card">
      <button class="person-card-open" data-open-person="${escapeHtml(user.id)}" type="button">
        ${renderAvatar(user, "avatar user-avatar")}
        <div>
          <h3>
            <span>${escapeHtml(userName)}</span>
            <small>${user.reviewCount} ${user.reviewCount === 1 ? "review" : "reviews"}</small>
          </h3>
          <p>${escapeHtml(user.username)}</p>
        </div>
      </button>
      <div class="person-favorites">
        ${
          favorites.length
            ? favorites.map(renderPersonFavorite).join("")
            : `<span class="muted">Nenhuma obra favorita definida.</span>`
        }
      </div>
      ${indicatedCount ? `<p class="person-indication-count">${indicatedCount} ${indicatedCount === 1 ? "coleção indicada" : "coleções indicadas"}</p>` : ""}
    </article>
  `;
}

function renderPersonFavorite(content: ContentItem): string {
  return `
    <span class="person-favorite-cover" title="${escapeHtml(content.title)}">
      ${
        content.coverUrl
          ? `<img src="${escapeHtml(content.coverUrl)}" alt="" aria-hidden="true" />`
          : `<span>${escapeHtml(content.title.slice(0, 1).toUpperCase())}</span>`
      }
    </span>
  `;
}

function renderPublicUserProfile(user: PeopleUser): string {
  const userName = getUserLabel(user);
  const ownedCollections = getOwnedCollections();
  const sharedCollections = ownedCollections.filter((collection) => collection.sharedWithUserIds.includes(user.id));
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
        <span class="public-profile-review-count">${user.reviewCount} ${user.reviewCount === 1 ? "review publicada" : "reviews publicadas"}</span>
      </div>
      <section class="profile-section">
        <h3>Coleções indicadas</h3>
        ${
          sharedCollections.length
            ? `<div class="person-collection-list">${sharedCollections.map((collection) => `<span class="person-collection-pill">${escapeHtml(collection.name)}</span>`).join("")}</div>`
            : `<p class="empty compact">Nenhuma coleção compartilhada.</p>`
        }
      </section>
      <section class="profile-section">
        <h3>Indicar minhas coleções</h3>
        ${renderPersonCollectionRecommendationForm(user, ownedCollections)}
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

function renderPersonCollectionRecommendationForm(user: PeopleUser, ownedCollections: UserCollection[]): string {
  if (ownedCollections.length === 0) {
    return `<p class="empty compact">Crie uma coleção pessoal antes de indicar.</p>`;
  }

  return `
    <form class="person-recommendation-form" data-person-recommendation-form="${escapeHtml(user.id)}">
      <div class="person-recommendation-list">
        ${ownedCollections.map((collection) => `
          <label class="person-recommendation-row">
            <input type="checkbox" name="collectionId" value="${escapeHtml(collection.id)}" ${collection.sharedWithUserIds.includes(user.id) ? "checked" : ""} />
            <span>
              <strong>${escapeHtml(collection.name)}</strong>
              ${collection.description ? `<small>${escapeHtml(collection.description)}</small>` : ""}
            </span>
          </label>
        `).join("")}
      </div>
      <button class="button" type="submit">Salvar indicações</button>
    </form>
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
              <label class="form-row">
                <span>Permissão</span>
                <select class="input" name="role">
                  <option value="user"${state.adminUserDraft.role === "user" ? " selected" : ""}>Usuário</option>
                  <option value="admin"${state.adminUserDraft.role === "admin" ? " selected" : ""}>Admin</option>
                </select>
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

function getReaderModeLabel(mode: ReaderMode): string {
  const labels: Record<ReaderMode, string> = {
    horizontal: "Horizontal",
    "paged-vertical": "Vertical paginado",
    "vertical-scroll": "Scroll vertical"
  };
  return labels[mode];
}

function getReaderModeIconLabel(mode: ReaderMode): string {
  const icons: Record<ReaderMode, string> = {
    horizontal: "↔",
    "paged-vertical": "↕",
    "vertical-scroll": "☰"
  };
  return icons[mode];
}

function getNextReaderMode(mode: ReaderMode): ReaderMode {
  if (mode === "vertical-scroll") return "horizontal";
  if (mode === "horizontal") return "paged-vertical";
  return "vertical-scroll";
}

function getFittingLabel(fitting: FittingMode): string {
  const labels: Record<FittingMode, string> = {
    height: "Altura",
    width: "Largura",
    original: "Original"
  };
  return labels[fitting];
}

function getNextFittingMode(fitting: FittingMode): FittingMode {
  if (fitting === "height") return "width";
  if (fitting === "width") return "original";
  return "height";
}

function clampReaderZoom(zoom: number): number {
  return Math.min(Math.max(Math.round(zoom), 50), 250);
}

function setReaderZoom(zoom: number): void {
  if (!state.reader) return;
  state.reader.zoom = clampReaderZoom(zoom);
  state.reader.controlsVisible = true;
  renderShell();
  if (state.reader.mode === "vertical-scroll") {
    requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
  }
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

function renderReaderOverlay(): void {
  if (!state.reader) return;
  const { content, page, mode, fitting, zoom, brightness, controlsVisible } = state.reader;
  const safePage = Math.min(Math.max(page, 0), Math.max(content.pageCount - 1, 0));
  const pageBookmarked = isPageBookmarked(content.id, safePage);
  const chapterProgress = getReaderChapterProgress(content, safePage);
  const modeIcon = getReaderModeIconLabel(mode);
  const modeLabel = getReaderModeLabel(mode);
  const fittingLabel = getFittingLabel(fitting);

  const topHtml = `
    <div class="reader-overlay-inner">
      <button class="reader-btn-icon reader-back-btn" data-reader-action="close" type="button" aria-label="Voltar"><i class="fa-solid fa-arrow-left"></i></button>
      <div class="reader-title-group">
        <div class="reader-title-text">${escapeHtml(content.title)}</div>
        <div class="reader-subtitle">${escapeHtml(getChapterForPage(content, safePage)?.name ?? `Página ${safePage + 1}`)} · ${getContentProgressPercent(content, safePage)}%</div>
      </div>
      <div class="reader-overlay-right">
        <button class="reader-btn-icon" data-reader-action="bookmark" type="button" title="${pageBookmarked ? "Remover marcador" : "Marcar página"}"><i class="${pageBookmarked ? "fa-solid" : "fa-regular"} fa-bookmark"></i></button>
      </div>
    </div>
  `;

  const bottomHtml = `
    <div class="reader-slider-row">
      <div class="reader-slider-inner">
        <button class="reader-btn-icon" data-reader-action="chapter-prev" type="button" title="Capítulo anterior" aria-label="Capítulo anterior"><i class="fa-solid fa-fast-backward"></i></button>
        <button class="reader-btn-icon" data-reader-action="page-first" type="button" title="Primeira página" aria-label="Primeira página"><i class="fa-solid fa-step-backward"></i></button>
        <div class="reader-slider-track">
          <span>${chapterProgress.currentPage}</span>
          <input data-reader-page-slider type="range" min="${chapterProgress.startPage}" max="${Math.max(chapterProgress.endPage, 0)}" value="${safePage}" aria-label="Página" />
          <span>${chapterProgress.pageCount}</span>
        </div>
        <button class="reader-btn-icon" data-reader-action="page-last" type="button" title="Última página" aria-label="Última página"><i class="fa-solid fa-step-forward"></i></button>
        <button class="reader-btn-icon" data-reader-action="chapter-next" type="button" title="Próximo capítulo" aria-label="Próximo capítulo"><i class="fa-solid fa-fast-forward"></i></button>
      </div>
    </div>
    <div class="reader-action-row">
      <button class="reader-action-btn" data-reader-action="toggle-fitting" type="button" title="Ajuste: ${fittingLabel}">
        <span class="icon">${renderFittingIcon(fitting)}</span>
        <span class="label">Ajuste</span>
      </button>
      <button class="reader-action-btn" data-reader-action="toggle-mode" type="button" title="${modeLabel}">
        <span class="icon">${modeIcon}</span>
        <span class="label">Modo</span>
      </button>
      <button class="reader-action-btn" data-reader-action="fullscreen" type="button" title="${escapeHtml(getReaderFullscreenLabel())}">
        <span class="icon"><i class="fa-solid ${isReaderFullscreen() ? "fa-compress" : "fa-expand"}"></i></span>
        <span class="label">Tela cheia</span>
      </button>
      <button class="reader-action-btn" data-reader-action="toggle-direction" type="button" title="Direção de leitura">
        <span class="icon"><i class="fa-solid fa-arrows-left-right"></i></span>
        <span class="label">Direção</span>
      </button>
      <div class="reader-zoom-control" aria-label="Zoom">
        <button class="reader-btn-icon compact" data-reader-action="zoom-out" type="button" title="Diminuir zoom" aria-label="Diminuir zoom">−</button>
        <button class="reader-zoom-value" data-reader-action="zoom-reset" type="button" title="Resetar zoom" aria-label="Resetar zoom">${zoom}%</button>
        <button class="reader-btn-icon compact" data-reader-action="zoom-in" type="button" title="Aumentar zoom" aria-label="Aumentar zoom">+</button>
      </div>
      <div class="reader-brightness-control">
        <span><i class="fa-solid fa-sun"></i></span>
        <input data-reader-brightness type="range" min="10" max="100" value="${brightness}" aria-label="Brilho" />
      </div>
    </div>
  `;

  const topOverlay = document.querySelector<HTMLElement>(".reader-overlay.top");
  const bottomOverlay = document.querySelector<HTMLElement>(".reader-overlay.bottom");
  const readerSection = document.querySelector<HTMLElement>(".reader");
  if (topOverlay) {
    topOverlay.innerHTML = topHtml;
    topOverlay.setAttribute("aria-hidden", String(!controlsVisible));
  }
  if (bottomOverlay) {
    bottomOverlay.innerHTML = bottomHtml;
    bottomOverlay.setAttribute("aria-hidden", String(!controlsVisible));
  }
  if (readerSection) {
    readerSection.classList.toggle("controls-visible", controlsVisible);
    readerSection.style.setProperty("--reader-brightness", `${brightness}%`);
    readerSection.style.setProperty("--reader-zoom-percent", `${zoom}%`);
    readerSection.style.setProperty("--reader-zoom-scale", String(zoom / 100));
    readerSection.style.setProperty("--reader-max-width", `${Math.round(980 * (zoom / 100))}px`);
  }
}

function renderFittingIcon(fitting: FittingMode): string {
  const icons: Record<FittingMode, string> = {
    height: "↕",
    width: "↔",
    original: "⊞"
  };
  return icons[fitting];
}

function renderReader(content: ContentItem, page: number, mode: ReaderMode): string {
  const safePage = Math.min(Math.max(page, 0), Math.max(content.pageCount - 1, 0));
  const controlsVisible = state.reader?.controlsVisible ?? false;
  const fitting = state.reader?.fitting ?? "height";
  const zoom = state.reader?.zoom ?? 100;
  const brightness = state.reader?.brightness ?? 100;
  const paginationClass = mode === "paged-vertical" ? "vertical" : "horizontal";
  return `
    <section class="reader ${controlsVisible ? "controls-visible" : ""}" style="--reader-brightness: ${brightness}%; --reader-zoom-percent: ${zoom}%; --reader-zoom-scale: ${zoom / 100}; --reader-max-width: ${Math.round(980 * (zoom / 100))}px">
      <div class="reader-pagination ${paginationClass}">
        <button class="zone prev" data-reader-action="page-prev" aria-label="Página anterior"></button>
        <button class="zone next" data-reader-action="page-next" aria-label="Próxima página"></button>
      </div>
      <div class="reader-stage ${mode === "vertical-scroll" ? "vertical-scroll" : ""} ${fitting === "width" ? "fit-width" : fitting === "original" ? "fit-original" : "fit-height"}" id="reader-stage">
        ${renderReaderPages(content, safePage, mode)}
      </div>
      <div class="reader-overlay top" aria-hidden="${controlsVisible ? "false" : "true"}"></div>
      <div class="reader-overlay bottom" aria-hidden="${controlsVisible ? "false" : "true"}"></div>
    </section>
  `;
}

function renderReaderPages(content: ContentItem, page: number, mode: ReaderMode): string {
  if (content.pageCount === 0) {
    return `<div class="reader-page-message">Nenhuma página encontrada.</div>`;
  }

  if (mode === "vertical-scroll") {
    const chapter = getChapterForPage(content, page);
    if (chapter) {
      const start = chapter.startPage;
      const end = start + chapter.pageCount;
      return Array.from({ length: end - start }, (_, index) => {
        return renderPageMedia(content, start + index, true);
      }).join("");
    }
    return renderPageMedia(content, page, true);
  }

  return `
    <div class="reader-media-shell">
      ${renderPageMedia(content, page, false)}
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
          <button class="reader-bookmark-chip" data-reader-action="goto-bookmark" data-reader-bookmark-page="${bookmark.page}" type="button">
            Página ${bookmark.page + 1}
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function getPageUrl(content: ContentItem, page: number): string {
  return `/api/contents/${encodeURIComponent(content.id)}/pages/${page}`;
}

function bindShellEvents(): void {
  document.querySelector("#menu-button")?.addEventListener("click", () => {
    if (isMobileViewport()) {
      state.mobileNavOpen = !state.mobileNavOpen;
      if (state.mobileNavOpen) {
        closeNavigationPanels();
      }
    } else {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    }
    renderShell();
  });

  document.querySelector("#home-button")?.addEventListener("click", () => {
    state.search = "";
    openView("home");
  });

  document.querySelector("#search-button")?.addEventListener("click", () => {
    document.querySelector<HTMLInputElement>("#search")?.focus();
  });

  document.querySelector("#settings-button")?.addEventListener("click", () => {
    closeNavigationPanels();
    closeMobileNavigation();
    state.activeView = "settings";
    state.activeLibraryId = null;
    state.activeSeriesId = null;
    state.reader = null;
    state.settingsSection = state.user?.role === "admin" ? "server" : "account";
    state.serverSection = "libraries";
    renderShell();
  });

  document.querySelector("#account-button")?.addEventListener("click", () => {
    state.statsMenuOpen = false;
    state.accountMenuOpen = !state.accountMenuOpen;
    closeMobileNavigation();
    renderShell();
  });

  document.querySelector("#stats-button")?.addEventListener("click", () => {
    state.accountMenuOpen = false;
    state.statsMenuOpen = !state.statsMenuOpen;
    closeMobileNavigation();
    renderShell();
  });

  document.querySelector("#theme-toggle")?.addEventListener("click", () => {
    state.darkMode = !state.darkMode;
    localStorage.setItem("pugotiread-dark-mode", state.darkMode ? "dark" : "light");
    applyTheme();
    renderShell();
  });

  document.querySelector("#profile-button")?.addEventListener("click", () => {
    openView("profile");
  });

  document.querySelector("#mobile-nav-backdrop")?.addEventListener("click", () => {
    closeMobileNavigation();
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

  document.querySelectorAll<HTMLButtonElement>("[data-edit-library]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.openLibraryMenuId = null;
      void openLibraryEditModal(button.dataset.editLibrary ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-delete-personal-library]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void deletePersonalLibrary(button.dataset.deletePersonalLibrary ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-delete-library]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void deletePublicLibrary(button.dataset.deleteLibrary ?? "");
    });
  });

  document.querySelector("#vault-unlock-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void unlockPersonalVault(event.currentTarget as HTMLFormElement);
  });

  document.querySelector<HTMLInputElement>("#vault-password-input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const form = (event.target as HTMLInputElement).form;
    if (form) void unlockPersonalVault(form);
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

  document.querySelector("#hide-vault-sidebar-button")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleVaultMenuVisibility();
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

  document.querySelectorAll<HTMLFormElement>("[data-person-recommendation-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void savePersonCollectionRecommendations(form);
    });
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
    updateProfileFavoriteResults();
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

  document.querySelector("#request-profile-password-reset")?.addEventListener("click", async () => {
    if (!state.user?.email) {
      state.profilePasswordError = "Esta conta não possui e-mail cadastrado.";
      state.profilePasswordMessage = "";
      renderShell();
      return;
    }

    try {
      state.profilePasswordError = "";
      state.profilePasswordMessage = "";
      await api<{ message: string }>("/api/me/password/request", { method: "POST" });
      state.profilePasswordMessage = "Enviamos um link para o e-mail cadastrado.";
      renderShell();
    } catch (error) {
      state.profilePasswordError = error instanceof Error ? error.message : "Não foi possível enviar o link.";
      state.profilePasswordMessage = "";
      renderShell();
    }
  });

  document.querySelector("#profile-password-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const currentPassword = String(formData.get("currentPassword") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");

    if (newPassword !== confirmPassword) {
      state.profilePasswordError = "As senhas não conferem.";
      state.profilePasswordMessage = "";
      renderShell();
      return;
    }

    state.profilePasswordError = "";
    state.profilePasswordMessage = "";
    void (async () => {
      try {
        await api<void>("/api/me/password", {
          method: "PATCH",
          body: JSON.stringify({
            currentPassword,
            newPassword
          })
        });
        state.profilePasswordMessage = "Senha alterada com sucesso.";
        renderShell();
      } catch (error) {
        state.profilePasswordError = error instanceof Error ? error.message : "Não foi possível alterar a senha.";
        renderShell();
      }
    })();
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
    state.profilePasswordError = "";
    state.profilePasswordMessage = "";
    clearPasswordResetState();
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
      const nextView = (button.dataset.navView as AppState["activeView"]) ?? "home";
      closeNavigationPanels();
      closeMobileNavigation();
      state.activeView = nextView;
      state.activeLibraryId = null;
      state.activeSeriesId = null;
      state.activePeopleUserId = null;
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
      closeMobileNavigation();
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
      closeMobileNavigation();
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
      if (state.reader?.mode === "vertical-scroll") {
        const p = state.reader.page;
        requestAnimationFrame(() => scrollReaderToPage(p));
      }
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
      openReaderAtPageAndRender(content, startPage);
    });
  });

  document.querySelector("#reader-stage")?.addEventListener("scroll", () => {
    if (!state.reader || state.reader.mode !== "vertical-scroll") {
      return;
    }
    syncReaderPageFromScroll();
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

function findPublicContentById(contentId: string): ContentItem | null {
  return getPublicContents().find((item) => item.id === contentId) ?? null;
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
  const newPage = Math.min(Math.max(page, 0), maxPage);
  const oldPage = state.reader.page;
  state.reader.page = newPage;

  renderShell();
  if (mode === "vertical-scroll") {
    requestAnimationFrame(() => scrollReaderToPage(newPage));
  }

  if (newPage === oldPage) return;

  try {
    await api<void>("/api/progress", {
      method: "PUT",
      body: JSON.stringify({ contentId, currentPage: newPage })
    });
    await refreshProgress();
  } catch (error) {
    console.error(error);
  }
}

async function toggleReaderFullscreen(): Promise<void> {
  if (!state.reader || !document.fullscreenEnabled) {
    return;
  }

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
    updateReaderFullscreenButton();
  } catch (error) {
    console.error(error);
  }
}

function updateReaderFullscreenButton(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-reader-action="fullscreen"]');
  if (!button) {
    return;
  }

  const label = getReaderFullscreenLabel();
  const icon = isReaderFullscreen() ? "fa-compress" : "fa-expand";
  button.querySelector("i")!.className = `fa-solid ${icon}`;
  button.title = label;
  button.setAttribute("aria-label", label);
}

function openReader(content: ContentItem, page: number): void {
  const safePage = Math.min(Math.max(page, 0), Math.max(content.pageCount - 1, 0));
  state.reader = { content, page: safePage, mode: "vertical-scroll", fitting: "height", zoom: 100, brightness: 100, controlsVisible: false };
  state.activeSeriesId = content.id;
}

function openReaderAtPageAndRender(content: ContentItem, page: number): void {
  openReader(content, page);
  renderShell();
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
  if (!target) {
    return;
  }

  const stage = document.getElementById("reader-stage");
  if (!stage) {
    return;
  }

  // wait for all images before the target to load so offsetTop is correct
  if (page > 0) {
    const allLoaded = Array.from(stage.querySelectorAll<HTMLElement>("[data-reader-page-index]")).every((el) => {
      const idx = parseInt(el.getAttribute("data-reader-page-index") || "0", 10);
      if (idx >= page) return true;
      if (el instanceof HTMLImageElement) return el.complete && el.naturalHeight > 0;
      return true;
    });

    if (!allLoaded) {
      requestAnimationFrame(() => scrollReaderToPage(page));
      return;
    }
  }

  stage.scrollTop = target.offsetTop;
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
  return getContentsByIdsFrom(getAvailableContents(), contentIds);
}

function getContentsByIdsFrom(contents: ContentItem[], contentIds: string[]): ContentItem[] {
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

function getPublicContents(): ContentItem[] {
  return [...state.homeContents].sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { numeric: true }));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function bindReaderDelegatedEvents(): void {
  document.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-reader-action]");
    if (!state.reader) {
      return;
    }

    // Click on the stage (not on overlay or pagination) toggles controls
    if (!target) {
      const stage = (event.target as HTMLElement).closest("#reader-stage");
      if (stage && !(event.target as HTMLElement).closest(".reader-overlay, .reader-pagination")) {
        state.reader.controlsVisible = !state.reader.controlsVisible;
        renderShell();
        if (state.reader.mode === "vertical-scroll") {
          requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
        }
      }
      return;
    }

    const action = target.dataset.readerAction;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();

    switch (action) {
      case "close":
        state.reader = null;
        renderShell();
        break;

      case "toggle-mode":
        state.reader.mode = getNextReaderMode(state.reader.mode);
        state.reader.controlsVisible = true;
        renderShell();
        if (state.reader.mode === "vertical-scroll") {
          requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
        }
        break;

      case "toggle-fitting":
        state.reader.fitting = getNextFittingMode(state.reader.fitting);
        state.reader.controlsVisible = true;
        renderShell();
        break;

      case "zoom-in":
        setReaderZoom(state.reader.zoom + 25);
        break;

      case "zoom-out":
        setReaderZoom(state.reader.zoom - 25);
        break;

      case "zoom-reset":
        setReaderZoom(100);
        break;

      case "toggle-direction":
        // In Kavita, this toggles between LTR and RTL reading direction.
        // For now, cycle reader mode as a proxy.
        state.reader.mode = getNextReaderMode(state.reader.mode);
        state.reader.controlsVisible = true;
        renderShell();
        if (state.reader.mode === "vertical-scroll") {
          requestAnimationFrame(() => scrollReaderToPage(state.reader?.page ?? 0));
        }
        break;

      case "fullscreen":
        void toggleReaderFullscreen();
        break;

      case "bookmark":
        void handleReaderBookmark();
        break;

      case "page-prev":
        void setReaderPage(state.reader.page - 1);
        break;

      case "page-next":
        void setReaderPage(state.reader.page + 1);
        break;

      case "page-first":
        void setReaderPage(0);
        break;

      case "page-last":
        void setReaderPage(state.reader.content.pageCount - 1);
        break;

      case "chapter-prev":
        void setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, -1));
        break;

      case "chapter-next":
        void setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, 1));
        break;

      case "goto-bookmark":
        {
          const page = Number(target.dataset.readerBookmarkPage ?? "0");
          state.reader.mode = "horizontal";
          void setReaderPage(page);
        }
        break;
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (!state.reader) return;

    if (target.matches("[data-reader-page-slider]")) {
      void setReaderPage(Number((target as HTMLInputElement).value));
      return;
    }

    if (target.matches("[data-reader-brightness]")) {
      state.reader.brightness = Number((target as HTMLInputElement).value);
      state.reader.controlsVisible = true;
      renderShell();
    }
  });
}

async function handleReaderBookmark(): Promise<void> {
  if (!state.reader || !state.user) return;

  if (state.reader.mode === "vertical-scroll") {
    syncReaderPageFromScroll();
  }

  const { content, page } = state.reader;
  const contentId = content.id;
  const previousBookmarks = state.bookmarks;
  const existingBookmark = previousBookmarks.find((b) => b.contentId === contentId && b.page === page);

  state.reader.controlsVisible = true;
  state.bookmarks = existingBookmark
    ? previousBookmarks.filter((b) => !(b.contentId === contentId && b.page === page))
    : [...previousBookmarks, { userId: state.user.id, contentId, page, createdAt: new Date().toISOString() }];
  renderShell();
  if (state.reader.mode === "vertical-scroll") {
    requestAnimationFrame(() => scrollReaderToPage(page));
  }

  try {
    await api<{ marked: boolean }>("/api/bookmarks", { method: "POST", body: JSON.stringify({ contentId, page }) });
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
}

void boot();

bindReaderDelegatedEvents();

document.addEventListener("keydown", (event) => {
  if (state.user?.role === "admin" && event.ctrlKey && event.shiftKey && event.code === "KeyL") {
    event.preventDefault();
    toggleVaultMenuVisibility();
    return;
  }

  if (state.user?.role === "admin" && event.ctrlKey && event.shiftKey && event.code === "Period") {
    event.preventDefault();
    if (state.vaultUnlocked) {
      void lockPersonalVault();
    }
    return;
  }

  if (state.reader) {
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        pageStep(-1);
        break;
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        if (state.reader.mode === "vertical-scroll") {
          scrollReaderByViewport(1);
        } else {
          pageStep(1);
        }
        break;
      case " ":
        event.preventDefault();
        if (state.reader.mode === "vertical-scroll") {
          scrollReaderByViewport(1);
        } else {
          pageStep(1);
        }
        break;
      case "Escape":
        event.preventDefault();
        state.reader = null;
        renderShell();
        break;
      case "Home":
        event.preventDefault();
        void setReaderPage(0);
        break;
      case "End":
        event.preventDefault();
        void setReaderPage(state.reader.content.pageCount - 1);
        break;
      case "f":
        event.preventDefault();
        state.reader.fitting = getNextFittingMode(state.reader.fitting);
        renderShell();
        break;
      case "+":
      case "=":
        event.preventDefault();
        setReaderZoom(state.reader.zoom + 25);
        break;
      case "-":
        event.preventDefault();
        setReaderZoom(state.reader.zoom - 25);
        break;
      case "0":
        event.preventDefault();
        setReaderZoom(100);
        break;
      case "m":
        event.preventDefault();
        state.reader.mode = getNextReaderMode(state.reader.mode);
        state.reader.controlsVisible = true;
        renderShell();
        if (state.reader.mode === "vertical-scroll") {
          const p = state.reader.page;
          requestAnimationFrame(() => scrollReaderToPage(p));
        }
        break;
      case "c":
        event.preventDefault();
        state.reader.controlsVisible = !state.reader.controlsVisible;
        renderShell();
        break;
      case "b":
        event.preventDefault();
        void handleReaderBookmark();
        break;
      case "[":
        event.preventDefault();
        void setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, -1));
        break;
      case "]":
        event.preventDefault();
        void setReaderPage(getAdjacentChapterStartPage(state.reader.content, state.reader.page, 1));
        break;
    }
    return;
  }

  if (!event.ctrlKey || event.key.toLowerCase() !== "y") {
    return;
  }

  event.preventDefault();
  document.querySelector<HTMLInputElement>("#search")?.focus();
});

function pageStep(delta: -1 | 1): void {
  if (!state.reader) return;
  void setReaderPage(state.reader.page + delta);
}

function scrollReaderByViewport(direction: -1 | 1): void {
  const stage = document.querySelector<HTMLElement>("#reader-stage");
  if (!stage) return;
  stage.scrollBy({ top: stage.clientHeight * direction, behavior: "smooth" });
}

document.addEventListener("fullscreenchange", () => {
  updateReaderFullscreenButton();
});
