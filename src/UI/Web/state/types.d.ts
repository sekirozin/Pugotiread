import type { Bookmark, ContentItem, Invitation, Library, LibraryKind, PublicContentReview, PublicUser, ReadingProgress } from "../../../shared/types.js";
export type UserCollection = {
    id: string;
    userId: string;
    name: string;
    description: string;
    sharedWithUserIds: string[];
    ownerDisplayName: string;
    contentIds: string[];
};
export type PeopleUser = PublicUser & {
    reviewCount: number;
};
export type ReaderMode = "horizontal" | "paged-vertical" | "vertical-scroll";
export type FittingMode = "height" | "width" | "original";
export type AppState = {
    user: PublicUser | null;
    libraries: Library[];
    personalLibraries: Library[];
    adminUsers: PublicUser[];
    peopleUsers: PeopleUser[];
    contents: ContentItem[];
    homeContents: ContentItem[];
    activeLibraryId: string | null;
    loadingLibraryId: string | null;
    libraryLoadError: string;
    activeSeriesId: string | null;
    activeView: "home" | "want" | "collections" | "lists" | "bookmarks" | "all" | "vault" | "people" | "library" | "profile" | "settings";
    settingsSection: "account" | "server";
    serverSection: "libraries" | "users" | "vault";
    accountMenuOpen: boolean;
    statsMenuOpen: boolean;
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
        directories: Array<{
            name: string;
            path: string;
        }>;
    } | null;
    sidebarCollapsed: boolean;
    mobileNavOpen: boolean;
    darkMode: boolean;
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
    profilePasswordError: string;
    profilePasswordMessage: string;
    invitePathToken: string | null;
    inviteData: Invitation | null;
    inviteError: string;
    inviteCreateAccountOpen: boolean;
    setupRequired: boolean;
    setupError: string;
    passwordResetOpen: boolean;
    passwordResetEmail: string;
    passwordResetMessage: string;
    passwordResetError: string;
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
        role: "admin" | "user";
        allowedLibraryIds: string[];
        canLogin: boolean;
        canDownload: boolean;
        canChangePassword: boolean;
    };
    reader: {
        content: ContentItem;
        page: number;
        mode: ReaderMode;
        fitting: FittingMode;
        brightness: number;
        controlsVisible: boolean;
    } | null;
};
export type ParsedSearch = {
    libraryId: string | null;
    query: string;
};
export type GoogleCredentialResponse = {
    credential?: string;
};
export type GoogleConfig = {
    enabled: boolean;
    clientId: string;
};
export type GoogleAccounts = {
    accounts: {
        id: {
            initialize(options: {
                client_id: string;
                callback: (response: GoogleCredentialResponse) => void;
            }): void;
            renderButton(element: HTMLElement, options: {
                theme: string;
                size: string;
                width: number;
                text?: string;
            }): void;
        };
    };
};
//# sourceMappingURL=types.d.ts.map