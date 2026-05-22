import type { Bookmark, ContentCollection, ContentReview, Invitation, Library, PasswordResetToken, ReadingProgress, SeriesMark, ServerSettings, StoreShape, User } from "../shared/types.js";
export declare const defaultServerSettings: ServerSettings;
export declare function normalizeVaultTimeoutMinutes(value: unknown): number;
export declare class Store {
    private db;
    constructor();
    private ensureTables;
    private ensureColumn;
    private ensureCompatibility;
    private tryMigrateFromJson;
    private seedIfEmpty;
    private usersToRows;
    private rowToUser;
    private writeAllSync;
    read(): Promise<StoreShape>;
    write(data: StoreShape): Promise<void>;
    upsertProgress(progress: ReadingProgress): Promise<void>;
    removeProgress(userId: string, contentId: string): Promise<void>;
    updateUserProfile(userId: string, updates: Pick<User, "avatarUrl" | "nickname" | "biography" | "location" | "favoriteContentIds">): Promise<User | null>;
    createUser(user: User): Promise<User>;
    updateSettings(updates: Partial<ServerSettings>): Promise<ServerSettings>;
    updateUser(userId: string, updates: Partial<Pick<User, "email" | "displayName" | "username" | "avatarUrl" | "googleSub" | "nickname" | "biography" | "location" | "favoriteContentIds" | "canLogin" | "canDownload" | "canChangePassword" | "passwordChangeRequiresEmailConfirmation" | "allowedLibraryIds" | "passwordHash" | "role">>): Promise<User | null>;
    deleteUser(userId: string): Promise<boolean>;
    createInvitation(invitation: Invitation): Promise<Invitation>;
    getInvitation(token: string): Promise<Invitation | null>;
    consumeInvitation(token: string): Promise<Invitation | null>;
    createPasswordResetToken(token: PasswordResetToken): Promise<PasswordResetToken>;
    getPasswordResetToken(tokenValue: string): Promise<PasswordResetToken | null>;
    consumePasswordResetToken(tokenValue: string): Promise<PasswordResetToken | null>;
    createLibrary(library: Library): Promise<Library>;
    updateLibrary(libraryId: string, updates: Pick<Library, "name" | "kind" | "path">): Promise<Library | null>;
    deleteLibrary(libraryId: string): Promise<boolean>;
    markLibraryScanned(libraryId: string, scannedAt: string): Promise<void>;
    toggleBookmark(bookmark: Bookmark): Promise<{
        marked: boolean;
    }>;
    toggleSeriesMark(mark: SeriesMark): Promise<{
        marked: boolean;
    }>;
    addToWantToRead(mark: SeriesMark): Promise<void>;
    removeFromWantToRead(userId: string, contentId: string): Promise<void>;
    addToReadingList(mark: SeriesMark): Promise<void>;
    removeFromReadingList(userId: string, contentId: string): Promise<void>;
    addToCollection(userId: string, collectionId: string, contentId: string): Promise<ContentCollection | null>;
    createCollection(collection: ContentCollection): Promise<ContentCollection>;
    updateCollection(userId: string, collectionId: string, updates: Pick<ContentCollection, "name" | "description">): Promise<ContentCollection | null>;
    updateCollectionSharing(userId: string, collectionId: string, sharedWithUserIds: string[]): Promise<ContentCollection | null>;
    deleteCollection(userId: string, collectionId: string): Promise<boolean>;
    removeFromCollection(userId: string, collectionId: string, contentId: string): Promise<ContentCollection | null>;
    removeContentForUser(userId: string, contentId: string): Promise<void>;
    upsertReview(review: ContentReview): Promise<void>;
    private rowToCollection;
}
export declare const store: Store;
//# sourceMappingURL=store.d.ts.map