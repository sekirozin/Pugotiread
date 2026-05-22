export type UserRole = "admin" | "user";
export type LibraryKind = "manga" | "manhwa" | "book" | "other";
export type PageMediaType = "image" | "pdf";
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
}
export interface ContentItem {
    id: string;
    libraryId: string;
    title: string;
    description: string | null;
    authors: string[];
    releaseDate: string | null;
    rating: string | null;
    genres: string[];
    pageCount: number;
    chapterCount: number;
    chapters: ChapterInfo[];
    coverUrl: string | null;
    pageTypes: PageMediaType[];
}
export interface ReadingProgress {
    userId: string;
    contentId: string;
    currentPage: number;
    updatedAt: string;
}
export interface Bookmark {
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
    vaultTimeoutMinutes: number;
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
//# sourceMappingURL=types.d.ts.map