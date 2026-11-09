function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export const ICONS = {
  menu: "menu", badge: "grid_view", stats: "bar_chart", settings: "settings",
  caret: "expand_more", caretRight: "chevron_right", home: "home", want: "auto_stories",
  collections: "stacks", lists: "playlist_play", bookmarks: "bookmark_border",
  bookmarksFilled: "bookmark", all: "library_books", lock: "lock", people: "group",
  libraryBook: "book_2", libraryManga: "menu_book", close: "close", mark: "verified",
  file: "description", author: "person", release: "calendar_month", genres: "sell",
  progress: "speed", rating: "star_border", ratingFilled: "star", continue: "play_circle",
  share: "open_in_new", logout: "logout", book: "book_2", pencil: "edit",
  vaultOpen: "lock_open", vaultClosed: "lock", trash: "delete", search: "search",
  sun: "light_mode", moon: "dark_mode", back: "arrow_back", forward: "arrow_forward",
  rewind: "fast_rewind", fastForward: "fast_forward", skipBack: "skip_previous",
  skipForward: "skip_next", fullscreen: "fullscreen", fullscreenExit: "fullscreen_exit",
  direction: "swap_horiz", fitHeight: "height", fitWidth: "width", fitOriginal: "fit_screen",
  readerHorizontal: "view_carousel", readerPagedVertical: "view_agenda",
  readerScroll: "view_stream", readerVertical: "view_stream", grid: "grid_view",
  moreVertical: "more_vert", more: "more_horiz", minus: "remove", plus: "add"
  ,writingSign: "edit", keyframes: "keyframes", bookmarkOff: "bookmark_remove"
} as const;

export type IconName = keyof typeof ICONS;

const TABLER_SIDEBAR_PATHS: Partial<Record<IconName, string>> = {
  menu: '<path d="M4 6l16 0"/><path d="M4 12l16 0"/><path d="M4 18l16 0"/>',
  settings: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  stats: '<path d="M3 12m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M9 8m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M15 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M4 20l14 0"/>',
  search: '<path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
  sun: '<path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M12 5l0 -2"/><path d="M17 7l1.4 -1.4"/><path d="M19 12l2 0"/><path d="M17 17l1.4 1.4"/><path d="M12 19l0 2"/><path d="M7 17l-1.4 1.4"/><path d="M6 12l-2 0"/><path d="M7 7l-1.4 -1.4"/>',
  moon: '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"/><path d="M17 4a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2"/><path d="M19 11h2m-1 -1v2"/>',
  home: '<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/>',
  want: '<path d="M10 19h-6a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1h6a2 2 0 0 1 2 2a2 2 0 0 1 2 -2h6a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-6a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2z"/><path d="M12 5v16"/><path d="M7 7h1"/><path d="M7 11h1"/><path d="M16 7h1"/><path d="M16 11h1"/><path d="M16 15h1"/>',
  collections: '<path d="M12 3l8 4.5l-8 4.5l-8 -4.5l8 -4.5"/><path d="M4 12l8 4.5l8 -4.5"/><path d="M4 16l8 4.5l8 -4.5"/>',
  lists: '<path d="M4 5h16"/><path d="M4 10h16"/><path d="M4 15h10"/><path d="M4 20h6"/>',
  bookmarks: '<path d="M6 4v16l6 -3l6 3v-16a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2"/>',
  all: '<path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M7 8h10"/><path d="M7 12h10"/><path d="M7 16h10"/>',
  people: '<path d="M9 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M5 21v-2a4 4 0 0 1 4 -4h4"/><path d="M16 16a4 4 0 0 1 4 4v1"/><path d="M5 11a4 4 0 0 1 0 -8"/>',
  book: '<path d="M19 4v16h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12z"/><path d="M19 16h-12a2 2 0 0 0 -2 2"/><path d="M9 8h6"/>',
  vaultOpen: '<path d="M5 11h14"/><path d="M12 11v4"/><path d="M8 11v-4a4 4 0 0 1 8 0v4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-8"/>',
  vaultClosed: '<path d="M5 11h14"/><path d="M12 11v4"/><path d="M8 11v-4a4 4 0 0 1 8 0v4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-8"/>',
  writingSign: '<path d="M3 21l3.75 -1.5L19.81 6.44a2.12 2.12 0 0 0 -3 -3L3.75 16.5L3 21"/><path d="M15 5l3 3"/>',
  keyframes: '<path d="M9 5h-4a2 2 0 0 0 -2 2v4"/><path d="M15 5h4a2 2 0 0 1 2 2v4"/><path d="M9 19h-4a2 2 0 0 1 -2 -2v-4"/><path d="M15 19h4a2 2 0 0 0 2 -2v-4"/><path d="M9 9h6v6H9z"/>',
  bookmarkOff: '<path d="M6 4a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v13"/><path d="M6 6v14l6 -3l3 1.5"/><path d="M3 3l18 18"/>',
};

function renderTablerIcon(name: IconName, label?: string): string | null {
  const paths = TABLER_SIDEBAR_PATHS[name];
  if (!paths) return null;
  const ariaLabel = label ? ` aria-label="${escapeAttribute(label)}"` : "";
  return `<span class="phosphor-icon tabler-icon" aria-hidden="${label ? "false" : "true"}"${ariaLabel} role="${label ? "img" : "presentation"}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span>`;
}

export function renderIcon(name: IconName, label?: string): string {
  const tablerIcon = renderTablerIcon(name, label);
  if (tablerIcon) return tablerIcon;
  const ariaLabel = label ? ` aria-label="${escapeAttribute(label)}"` : "";
  return `<span class="phosphor-icon material-symbols-rounded" aria-hidden="${label ? "false" : "true"}"${ariaLabel} role="${label ? "img" : "presentation"}">${ICONS[name]}</span>`;
}

export function renderSidebarIcon(name: IconName, label: string): string {
  return renderTablerIcon(name, label) ?? renderIcon(name, label);
}
