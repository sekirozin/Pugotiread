export type UserRole = "admin" | "superuser" | "user";

export type LibraryKind = "manga" | "manhwa" | "book" | "comic" | "lightNovel" | "other";

export type PageMediaType = "image" | "pdf" | "epub";
export type ReaderMode = "horizontal" | "paged-vertical" | "vertical-scroll";
export type ReaderFittingMode = "height" | "width" | "original";
export type ReaderDirection = "ltr" | "rtl";

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string;
  googleSub?: string;
  nickname: string;
  biography: string;
  location: string;
  favoriteContentIds: string[];
  canLogin: boolean;
  canDownload: boolean;
  canChangePassword: boolean;
  passwordChangeRequiresEmailConfirmation: boolean;
  lastActiveAt: string | null;
  role: UserRole;
  passwordHash: string;
  allowedLibraryIds: string[];
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string;
  nickname: string;
  biography: string;
  location: string;
  favoriteContentIds: string[];
  canLogin: boolean;
  canDownload: boolean;
  canChangePassword: boolean;
  passwordChangeRequiresEmailConfirmation: boolean;
  lastActiveAt: string | null;
  needsNickname?: boolean;
  allowedLibraryIds: string[];
  role: UserRole;
}

export interface Library {
  id: string;
  name: string;
  kind: LibraryKind;
  path: string;
  isPersonal?: boolean;
  ownerUserId?: string | null;
  lastScannedAt?: string;
}

export interface ChapterInfo {
  name: string;
  startPage: number;
  pageCount: number;
  isSpecial: boolean;
  addedAt?: string | null;
}

export interface ContentItem {
  id: string;
  libraryId: string;
  title: string;
  description: string | null;
  authors: string[];
  artists?: string[];
  releaseDate: string | null;
  rating: string | null;
  publicationStatus?: string | null;
  /** Nota externa do Google Books, quando disponível para livros. */
  externalRating?: string | null;
  genres: string[];
  pageCount: number;
  chapterCount: number;
  chapters: ChapterInfo[];
  coverUrl: string | null;
  pageTypes: PageMediaType[];
  system?: string | null;
  formOwnerUserId?: string | null;
  formVisibility?: "private" | "shared" | "public";
  rpgRole?: "module" | "template";
}

export interface PdfFormCopyAccess {
  moduleId?: string | null;
  contentId: string;
  title?: string;
  sourceId: string;
  ownerUserId: string;
  ownerDisplayName: string;
  visibility: "private" | "shared" | "public";
  sharedWithUserIds: string[];
  system: string;
}

export interface RpgDocument {
  id: string;
  contentId: string;
  role: "module" | "template";
}

export interface RpgDetails {
  document: RpgDocument | null;
  documents: Array<RpgDocument & { title: string }>;
  templateIds: string[];
  templates: ContentItem[];
  modules: ContentItem[];
  mySheets: ContentItem[];
  sharedSheets: ContentItem[];
  copy: PdfFormCopyAccess | null;
  canManage: boolean;
  users: Array<{ id: string; displayName: string }>;
}

export interface ReadingProgress {
  userId: string;
  contentId: string;
  currentPage: number;
  /** Fraction of the text read inside an EPUB spine document (0..1). */
  epubOffset?: number;
  updatedAt: string;
}

export interface Bookmark {
  name?: string;
  userId: string;
  contentId: string;
  page: number;
  createdAt: string;
}

export interface SeriesMark {
  userId: string;
  contentId: string;
  createdAt: string;
}

export interface ContentCollection {
  id: string;
  userId: string;
  name: string;
  description: string;
  sharedWithUserIds: string[];
  contentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ContentReview {
  userId: string;
  contentId: string;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface Invitation {
  token: string;
  email: string;
  displayName: string;
  username: string;
  role: UserRole;
  allowedLibraryIds: string[];
  canLogin: boolean;
  canDownload: boolean;
  canChangePassword: boolean;
  createdAt: string;
  usedAt: string | null;
}

export interface PasswordResetToken {
  token: string;
  userId: string;
  email: string;
  purpose: "password-reset";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface PublicContentReview {
  userId: string;
  contentId: string;
  displayName: string;
  role: UserRole;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerSettings {
  startupLibraries?: Record<string, string>;
  vaultTimeoutMinutes: number;
  readingDefaults: Record<LibraryKind, {
    mode: ReaderMode;
    fitting: ReaderFittingMode;
    direction: ReaderDirection;
    controlsVisible: boolean;
  }>;
}

export interface StoreShape {
  settings: ServerSettings;
  users: User[];
  libraries: Library[];
  progress: ReadingProgress[];
  bookmarks: Bookmark[];
  seriesMarks: SeriesMark[];
  wantToRead: SeriesMark[];
  readingList: SeriesMark[];
  collections: ContentCollection[];
  reviews: ContentReview[];
  invitations: Invitation[];
  passwordResetTokens: PasswordResetToken[];
}
