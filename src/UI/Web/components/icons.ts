function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export const ICONS = {
  menu: "ph-list",
  badge: "ph-squares-four",
  stats: "ph-chart-bar",
  settings: "ph-gear",
  caret: "ph-caret-down",
  caretRight: "ph-caret-right",
  home: "ph-house",
  want: "ph-book-open",
  collections: "ph-stack",
  lists: "ph-playlist",
  bookmarks: "ph-bookmark-simple",
  bookmarksFilled: "ph-bookmark-simple-fill",
  all: "ph-books",
  lock: "ph-lock",
  people: "ph-users",
  libraryBook: "ph-book",
  libraryManga: "ph-book-open-text",
  close: "ph-x",
  mark: "ph-seal-check",
  file: "ph-file-text",
  author: "ph-user",
  release: "ph-calendar",
  genres: "ph-tag",
  progress: "ph-gauge",
  rating: "ph-star",
  ratingFilled: "ph-star-fill",
  continue: "ph-play-circle",
  share: "ph-arrow-square-out",
  book: "ph-book",
  pencil: "ph-pencil",
  vaultOpen: "ph-lock-open",
  vaultClosed: "ph-lock",
  trash: "ph-trash",
  search: "ph-magnifying-glass",
  sun: "ph-sun",
  moon: "ph-moon",
  back: "ph-arrow-left",
  forward: "ph-arrow-right",
  rewind: "ph-rewind",
  fastForward: "ph-fast-forward",
  skipBack: "ph-skip-back",
  skipForward: "ph-skip-forward",
  fullscreen: "ph-corners-out",
  fullscreenExit: "ph-corners-in",
  direction: "ph-arrows-left-right",
  fitHeight: "ph-arrows-out-line-vertical",
  fitWidth: "ph-arrows-out-line-horizontal",
  fitOriginal: "ph-arrows-in",
  readerHorizontal: "ph-arrows-left-right",
  readerVertical: "ph-rows",
  grid: "ph-squares-four",
  moreVertical: "ph-dots-three-vertical",
  more: "ph-dots-three",
  minus: "ph-minus",
  plus: "ph-plus"
} as const;

export type IconName = keyof typeof ICONS;

export function renderIcon(name: IconName, label?: string): string {
  const title = label ? `<title>${escapeAttribute(label)}</title>` : "";
  const ariaLabel = label ? ` aria-label="${escapeAttribute(label)}"` : "";
  return `<svg class="phosphor-icon" viewBox="0 0 256 256" aria-hidden="${label ? "false" : "true"}"${ariaLabel} focusable="false" role="${label ? "img" : "presentation"}">${title}<use href="/phosphor-sprite.svg#${ICONS[name]}"></use></svg>`;
}

export function renderSidebarIcon(name: IconName, label: string): string {
  return renderIcon(name, label);
}
