# Graph Report - .  (2026-05-25)

## Corpus Check
- 175 files · ~94,319 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1082 nodes · 2104 edges · 70 communities (52 shown, 18 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.57)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Recent Updates UI|Recent Updates UI]]
- [[_COMMUNITY_Shared Types Settings|Shared Types Settings]]
- [[_COMMUNITY_Web App Core|Web App Core]]
- [[_COMMUNITY_Authentication Tokens|Authentication Tokens]]
- [[_COMMUNITY_Server Media Routes|Server Media Routes]]
- [[_COMMUNITY_EPUB Processing|EPUB Processing]]
- [[_COMMUNITY_Compiled Web App|Compiled Web App]]
- [[_COMMUNITY_Store Initialization|Store Initialization]]
- [[_COMMUNITY_HTTP Helpers|HTTP Helpers]]
- [[_COMMUNITY_Store Data Methods|Store Data Methods]]
- [[_COMMUNITY_Settings Rendering|Settings Rendering]]
- [[_COMMUNITY_Shell Actions|Shell Actions]]
- [[_COMMUNITY_Content Lookup|Content Lookup]]
- [[_COMMUNITY_Collection Actions|Collection Actions]]
- [[_COMMUNITY_Deployment Architecture|Deployment Architecture]]
- [[_COMMUNITY_Media Scanner|Media Scanner]]
- [[_COMMUNITY_Public Content Lookup|Public Content Lookup]]
- [[_COMMUNITY_Package Dependencies|Package Dependencies]]
- [[_COMMUNITY_Shared Domain Types|Shared Domain Types]]
- [[_COMMUNITY_Reader Overlay|Reader Overlay]]
- [[_COMMUNITY_Avatar Topbar|Avatar Topbar]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Boot Google Flow|Boot Google Flow]]
- [[_COMMUNITY_Library Loading|Library Loading]]
- [[_COMMUNITY_Data Store Tables|Data Store Tables]]
- [[_COMMUNITY_Vault Refresh Flow|Vault Refresh Flow]]
- [[_COMMUNITY_Sidebar Navigation|Sidebar Navigation]]
- [[_COMMUNITY_Cache Service|Cache Service]]
- [[_COMMUNITY_Reader Progress|Reader Progress]]
- [[_COMMUNITY_Series Reviews|Series Reviews]]
- [[_COMMUNITY_Series Actions|Series Actions]]
- [[_COMMUNITY_Mailer Service|Mailer Service]]
- [[_COMMUNITY_Admin Users|Admin Users]]
- [[_COMMUNITY_Profile View|Profile View]]
- [[_COMMUNITY_Admin User Forms|Admin User Forms]]
- [[_COMMUNITY_Icon Rendering|Icon Rendering]]
- [[_COMMUNITY_Server Config|Server Config]]
- [[_COMMUNITY_Project Documentation|Project Documentation]]
- [[_COMMUNITY_Sample Manhwa Titles|Sample Manhwa Titles]]
- [[_COMMUNITY_Colorist Cover|Colorist Cover]]
- [[_COMMUNITY_Solo Leveling Cover|Solo Leveling Cover]]
- [[_COMMUNITY_Cache Declarations|Cache Declarations]]
- [[_COMMUNITY_Beginning After End Cover|Beginning After End Cover]]
- [[_COMMUNITY_Authentication Module|Authentication Module]]
- [[_COMMUNITY_Server Configuration|Server Configuration]]
- [[_COMMUNITY_One Piece Cover|One Piece Cover]]
- [[_COMMUNITY_Attack Titan Cover|Attack Titan Cover]]
- [[_COMMUNITY_One Punch Cover|One Punch Cover]]
- [[_COMMUNITY_Vagabond Cover|Vagabond Cover]]
- [[_COMMUNITY_Sun Ken Rock Cover|Sun Ken Rock Cover]]
- [[_COMMUNITY_Baskerville Cover|Baskerville Cover]]
- [[_COMMUNITY_Haitatsusaki Cover|Haitatsusaki Cover]]
- [[_COMMUNITY_Reincarnation Cover|Reincarnation Cover]]
- [[_COMMUNITY_Baskerville Duplicate Cover|Baskerville Duplicate Cover]]
- [[_COMMUNITY_Lock Closed Icon|Lock Closed Icon]]

## God Nodes (most connected - your core abstractions)
1. `renderShell()` - 72 edges
2. `renderShell()` - 67 edges
3. `escapeHtml()` - 54 edges
4. `escapeHtml()` - 50 edges
5. `Store` - 44 edges
6. `Store` - 44 edges
7. `handleApi()` - 35 edges
8. `handleApi()` - 26 edges
9. `ContentItem` - 15 edges
10. `Library` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Pugotiread README` --references--> `JSON Database`  [EXTRACTED]
  README.md → data/store.json
- `Pugotiread README` --references--> `Frontend Application Logic`  [EXTRACTED]
  README.md → src/client/app.ts
- `pugotiread Docker Service` --implements--> `Homelab/ZimaOS Deployment Target`  [EXTRACTED]
  docker-compose.yml → README.md
- `Dark/Light Mode Toggle` --implements--> `Static HTML/CSS/TypeScript Frontend`  [EXTRACTED]
  SESSAO_LOG.md → README.md
- `Small Legible First-stage Base` --rationale_for--> `Static HTML/CSS/TypeScript Frontend`  [EXTRACTED]
  docs/ARCHITECTURE.md → README.md

## Hyperedges (group relationships)
- **Pugotiread Core Architecture** — readme_node_typescript_backend, architecture_native_http_server, readme_json_api, readme_static_frontend, readme_json_store, readme_media_scanning, readme_reader [EXTRACTED 1.00]
- **Docker and ZimaOS Deployment** — compose_pugotiread_service, compose_autoheal_service, compose_healthcheck, compose_media_mount, readme_homelab_zimaos [EXTRACTED 1.00]
- **Authentication and Permissions** — readme_cookie_session_login, readme_google_invite_login, compose_google_client_id, readme_demo_users, readme_library_permissions [EXTRACTED 1.00]
- **Media Storage and Cache** — compose_media_mount, readme_personal_vault, compose_cache_dir, readme_cover_discovery, readme_media_scanning [EXTRACTED 1.00]
- **Removed Pugotidownloader Flow** — session_pugotidownloader_attempt, session_pugotidownloader_removal, compose_pugotiread_service, readme_media_scanning [EXTRACTED 1.00]

## Communities (70 total, 18 thin omitted)

### Community 0 - "Recent Updates UI"
Cohesion: 0.05
Nodes (56): SIDEBAR_ICON_PATHS, renderLatestChapters(), renderSeriesCardMeta(), hasRecentlyUpdatedChapters(), isRecentlyUpdatedChapter(), ChapterInfo, escapeAttribute(), ICONS (+48 more)

### Community 1 - "Shared Types Settings"
Cohesion: 0.05
Nodes (52): GoogleTokenPayload, Store, defaultReadingDefaults, libraryKinds, readerFittingModes, readerModes, Bookmark, ContentCollection (+44 more)

### Community 2 - "Web App Core"
Cohesion: 0.05
Nodes (39): appElement, canMoveLibraryStep(), closeMobileNavigation(), closeNavigationPanels(), ensureGoogleScript(), getGoogleConfig(), getLibraryAutocomplete(), getOrderedChapters() (+31 more)

### Community 3 - "Authentication Tokens"
Cohesion: 0.05
Nodes (27): GoogleJwk, GoogleTokenPayload, decodeBase64UrlJson(), getCookie(), getCurrentUser(), getGoogleKeys(), isPasswordHashReady(), verifyGoogleIdToken() (+19 more)

### Community 4 - "Server Media Routes"
Cohesion: 0.07
Nodes (48): getContentType(), sendBuffer(), sendHtml(), getNoDetectedContentMessage(), invalidateLibraryScanCache(), isSyncSkippedLibraryKind(), parseContentEpubAssetPath(), getContentEpubAsset() (+40 more)

### Community 5 - "EPUB Processing"
Cohesion: 0.07
Nodes (51): decodeXml(), EpubChapter, EpubInfo, epubInfoCache, execFileAsync, extractHtmlPart(), findAdjacentBookCoverPath(), findEpubPath() (+43 more)

### Community 6 - "Compiled Web App"
Cohesion: 0.06
Nodes (33): appElement, canMoveLibraryStep(), closeMobileNavigation(), closeNavigationPanels(), getChapterForPage(), getContentProgressPercent(), getFittingLabel(), getLibraryAutocomplete() (+25 more)

### Community 7 - "Store Initialization"
Cohesion: 0.06
Nodes (4): parseSettingJson(), makeInitialStore(), normalizeVaultTimeoutMinutes(), Store

### Community 8 - "HTTP Helpers"
Cohesion: 0.09
Nodes (39): contentTypes, getFileCacheControl(), getStaticCacheControl(), imageExtensions, sendFile(), sendJson(), serveStatic(), buildUserFromInput() (+31 more)

### Community 10 - "Settings Rendering"
Cohesion: 0.07
Nodes (43): applyTheme(), boot(), escapeHtml(), getLibraryKindLabel(), getPasswordResetTokenFromPath(), getSettingsSectionTitle(), loadInviteFlow(), renderAdminUserModal() (+35 more)

### Community 11 - "Shell Actions"
Cohesion: 0.07
Nodes (42): addProfileFavorite(), addToCollection(), addToReadingList(), addToWantToRead(), bindShellEvents(), cancelCollectionEdit(), closeAdminUserDeleteModal(), closeCollectionDeleteModal() (+34 more)

### Community 12 - "Content Lookup"
Cohesion: 0.07
Nodes (40): escapeHtml(), getContentsByIds(), getContentsByIdsFrom(), getLibraryKindLabel(), getOwnedCollections(), getSettingsSectionTitle(), getUserLabel(), renderAdminUserModal() (+32 more)

### Community 13 - "Collection Actions"
Cohesion: 0.07
Nodes (40): addProfileFavorite(), addToCollection(), addToReadingList(), addToWantToRead(), bindShellEvents(), cancelCollectionEdit(), closeAdminUserDeleteModal(), closeCollectionDeleteModal() (+32 more)

### Community 14 - "Deployment Architecture"
Cohesion: 0.08
Nodes (32): Native node:http Server, Small Legible First-stage Base, SQLite as Natural Evolution, pugotiread-autoheal Service, CACHE_DIR /app/data/cache, GOOGLE_CLIENT_ID Environment Variable, /health Docker Healthcheck, Read-only /media Mount (+24 more)

### Community 15 - "Media Scanner"
Cohesion: 0.15
Nodes (21): coverNames, findCoverPath(), getContentCoverPath(), getContentCoverThumbnail(), getContentPagePath(), getLibraryIdFromContentId(), getLibraryMtime(), getPageType() (+13 more)

### Community 16 - "Public Content Lookup"
Cohesion: 0.11
Nodes (23): findPublicContentById(), getAvailableContents(), getContentsByIds(), getContentsByIdsFrom(), getOwnedCollections(), getPublicContents(), getUserLabel(), renderCollectionsView() (+15 more)

### Community 17 - "Package Dependencies"
Cohesion: 0.10
Nodes (20): dependencies, better-sqlite3, sharp, description, devDependencies, tsx, @types/better-sqlite3, @types/node (+12 more)

### Community 18 - "Shared Domain Types"
Cohesion: 0.11
Nodes (18): Bookmark, ChapterInfo, ContentCollection, ContentItem, ContentReview, Invitation, Library, LibraryKind (+10 more)

### Community 19 - "Reader Overlay"
Cohesion: 0.13
Nodes (18): getChapterForPage(), getContentProgressPercent(), getFittingLabel(), getPageUrl(), getReaderChapterProgress(), getReaderFullscreenLabel(), getReaderModeIconLabel(), getReaderModeLabel() (+10 more)

### Community 20 - "Avatar Topbar"
Cohesion: 0.23
Nodes (14): avatarStyle(), escapeHtml(), getInitials(), renderAvatar(), escapeHtml(), formatDuration(), renderAccountMenu(), renderStatsMenu() (+6 more)

### Community 21 - "TypeScript Config"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir, rootDir (+5 more)

### Community 22 - "Boot Google Flow"
Cohesion: 0.15
Nodes (14): applyTheme(), boot(), ensureGoogleScript(), getGoogleConfig(), getPasswordResetTokenFromPath(), loadInviteFlow(), mountGoogleButton(), renderInitialSetup() (+6 more)

### Community 23 - "Library Loading"
Cohesion: 0.18
Nodes (14): clearVaultInactivityTimer(), loadHome(), loadLibraryContents(), lockPersonalVault(), refreshLibraries(), refreshPersonalVault(), registerVaultActivity(), saveVaultSettings() (+6 more)

### Community 24 - "Data Store Tables"
Cohesion: 0.15
Nodes (12): bookmarks, collections, invitations, libraries, progress, readingList, reviews, seriesMarks (+4 more)

### Community 25 - "Vault Refresh Flow"
Cohesion: 0.18
Nodes (13): clearVaultInactivityTimer(), loadHome(), loadLibraryContents(), lockPersonalVault(), refreshLibraries(), refreshPersonalVault(), registerVaultActivity(), saveVaultSettings() (+5 more)

### Community 26 - "Sidebar Navigation"
Cohesion: 0.36
Nodes (11): escapeHtml(), renderLibraryButton(), renderLibraryContextMenu(), renderMainSidebar(), renderNavButton(), renderServerSectionButton(), renderSettingsButton(), renderSettingsSidebar() (+3 more)

### Community 28 - "Reader Progress"
Cohesion: 0.18
Nodes (11): getOrderedChapters(), getProgressChapterLabel(), getProgressForContent(), getRatingClass(), openReader(), openReaderAtPageAndRender(), openReaderAtProgress(), renderSeriesMetaItem() (+3 more)

### Community 29 - "Series Reviews"
Cohesion: 0.20
Nodes (10): findContentById(), getAvailableContents(), getSelectedSeries(), loadSeriesReviews(), markSeriesRead(), markSeriesUnread(), openSeries(), pageStep() (+2 more)

### Community 30 - "Series Actions"
Cohesion: 0.20
Nodes (10): findContentById(), getSelectedSeries(), loadSeriesReviews(), markSeriesRead(), markSeriesUnread(), openSeries(), pageStep(), refreshProgress() (+2 more)

### Community 31 - "Mailer Service"
Cohesion: 0.44
Nodes (8): MailMessage, escapeHeader(), makeMessage(), sendCommand(), sendPasswordResetEmail(), sendSmtpMessage(), upgradeToTls(), waitForResponse()

### Community 32 - "Admin Users"
Cohesion: 0.25
Nodes (8): closeAdminUserModal(), createLinkOnlyInvite(), deleteAdminUser(), openAdminUserModal(), refreshAdminUsers(), resetAdminUserDraft(), submitAdminUserForm(), syncAdminUserDraftFromInputs()

### Community 33 - "Profile View"
Cohesion: 0.29
Nodes (8): findPublicContentById(), getPublicContents(), renderProfileFavoriteResults(), renderProfileForm(), renderProfilePasswordSection(), renderProfileReview(), renderProfileView(), updateProfileFavoriteResults()

### Community 34 - "Admin User Forms"
Cohesion: 0.25
Nodes (8): closeAdminUserModal(), createLinkOnlyInvite(), deleteAdminUser(), openAdminUserModal(), refreshAdminUsers(), resetAdminUserDraft(), submitAdminUserForm(), syncAdminUserDraftFromInputs()

### Community 35 - "Icon Rendering"
Cohesion: 0.47
Nodes (5): IconName, escapeAttribute(), ICONS, renderIcon(), renderSidebarIcon()

### Community 36 - "Server Config"
Cohesion: 0.40
Nodes (3): config, envFileValues, projectRoot

### Community 37 - "Project Documentation"
Cohesion: 0.67
Nodes (3): Frontend Application Logic, Pugotiread README, JSON Database

### Community 38 - "Sample Manhwa Titles"
Cohesion: 0.67
Nodes (3): Colorist, Stellar Swordmaster, The Beginning After The End

## Knowledge Gaps
- **149 isolated node(s):** `name`, `version`, `description`, `private`, `type` (+144 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Store` connect `Store Data Methods` to `Authentication Tokens`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Why does `Store` connect `Store Initialization` to `Shared Types Settings`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Why does `Library` connect `Shared Types Settings` to `Recent Updates UI`, `Web App Core`, `Server Media Routes`, `EPUB Processing`, `Sidebar Navigation`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _149 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Recent Updates UI` be split into smaller, more focused modules?**
  _Cohesion score 0.05228105228105228 - nodes in this community are weakly interconnected._
- **Should `Shared Types Settings` be split into smaller, more focused modules?**
  _Cohesion score 0.05403348554033485 - nodes in this community are weakly interconnected._
- **Should `Web App Core` be split into smaller, more focused modules?**
  _Cohesion score 0.052597402597402594 - nodes in this community are weakly interconnected._