function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export const ICONS = {
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

export function renderIcon(name: keyof typeof ICONS): string {
  return ICONS[name];
}

export const SIDEBAR_ICON_PATHS = {
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

export function renderSidebarIcon(name: keyof typeof SIDEBAR_ICON_PATHS, label: string): string {
  return `<img class="nav-image-icon" src="${SIDEBAR_ICON_PATHS[name]}" alt="" aria-hidden="true" title="${escapeAttribute(label)}" />`;
}
