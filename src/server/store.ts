import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { Bookmark, ContentCollection, ContentReview, Invitation, Library, ReadingProgress, SeriesMark, StoreShape, User } from "../shared/types.js";

export class Store {
  private data: StoreShape | null = null;

  async read(): Promise<StoreShape> {
    if (this.data) {
      return this.data;
    }

    const raw = await fs.readFile(config.dataFile, "utf8");
    this.data = this.normalize(JSON.parse(raw) as Partial<StoreShape>);
    return this.data;
  }

  private normalize(data: Partial<StoreShape>): StoreShape {
    return {
      users: (data.users ?? []).map((user) => ({
        ...user,
        email: user.email ?? "",
        avatarUrl: user.avatarUrl ?? "",
        nickname: user.nickname ?? "",
        biography: user.biography ?? "",
        location: user.location ?? "",
        favoriteContentIds: user.favoriteContentIds ?? [],
        canLogin: user.canLogin ?? true,
        canDownload: user.canDownload ?? true,
        canChangePassword: user.canChangePassword ?? true,
        lastActiveAt: user.lastActiveAt ?? null
      })),
      libraries: data.libraries ?? [],
      progress: data.progress ?? [],
      bookmarks: data.bookmarks ?? [],
      seriesMarks: data.seriesMarks ?? [],
      wantToRead: data.wantToRead ?? [],
      readingList: data.readingList ?? [],
      collections: (data.collections ?? []).map((collection) => ({
        ...collection,
        description: collection.description ?? "",
        sharedWithUserIds: collection.sharedWithUserIds ?? []
      })),
      reviews: data.reviews ?? [],
      invitations: data.invitations ?? []
    };
  }

  async write(next: StoreShape): Promise<void> {
    this.data = next;
    await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
    await fs.writeFile(config.dataFile, `${JSON.stringify(next, null, 2)}\n`);
  }

  async upsertProgress(progress: ReadingProgress): Promise<void> {
    const data = await this.read();
    const existingIndex = data.progress.findIndex(
      (item) => item.userId === progress.userId && item.contentId === progress.contentId
    );

    if (existingIndex >= 0) {
      data.progress[existingIndex] = progress;
    } else {
      data.progress.push(progress);
    }

    await this.write(data);
  }

  async removeProgress(userId: string, contentId: string): Promise<void> {
    const data = await this.read();
    data.progress = data.progress.filter((item) => !(item.userId === userId && item.contentId === contentId));
    await this.write(data);
  }

  async updateUserProfile(
    userId: string,
    updates: Pick<User, "avatarUrl" | "nickname" | "biography" | "location" | "favoriteContentIds">
  ): Promise<User | null> {
    const data = await this.read();
    const user = data.users.find((item) => item.id === userId);
    if (!user) {
      return null;
    }

    user.avatarUrl = updates.avatarUrl;
    user.nickname = updates.nickname;
    user.biography = updates.biography;
    user.location = updates.location;
    user.favoriteContentIds = updates.favoriteContentIds;
    await this.write(data);
    return user;
  }

  async createUser(user: User): Promise<User> {
    const data = await this.read();
    data.users.push(user);
    await this.write(data);
    return user;
  }

  async updateUser(userId: string, updates: Partial<Pick<User, "email" | "displayName" | "username" | "avatarUrl" | "nickname" | "biography" | "location" | "favoriteContentIds" | "canLogin" | "canDownload" | "canChangePassword" | "allowedLibraryIds" | "passwordHash">>): Promise<User | null> {
    const data = await this.read();
    const user = data.users.find((item) => item.id === userId);
    if (!user) {
      return null;
    }

    Object.assign(user, updates);
    await this.write(data);
    return user;
  }

  async deleteUser(userId: string): Promise<boolean> {
    const data = await this.read();
    const index = data.users.findIndex((item) => item.id === userId);
    if (index < 0) {
      return false;
    }

    data.users.splice(index, 1);
    data.progress = data.progress.filter((item) => item.userId !== userId);
    data.bookmarks = data.bookmarks.filter((item) => item.userId !== userId);
    data.seriesMarks = data.seriesMarks.filter((item) => item.userId !== userId);
    data.wantToRead = data.wantToRead.filter((item) => item.userId !== userId);
    data.readingList = data.readingList.filter((item) => item.userId !== userId);
    data.collections = data.collections.filter((item) => item.userId !== userId);
    data.reviews = data.reviews.filter((item) => item.userId !== userId);
    await this.write(data);
    return true;
  }

  async createInvitation(invitation: Invitation): Promise<Invitation> {
    const data = await this.read();
    data.invitations.push(invitation);
    await this.write(data);
    return invitation;
  }

  async getInvitation(token: string): Promise<Invitation | null> {
    const data = await this.read();
    return data.invitations.find((item) => item.token === token && !item.usedAt) ?? null;
  }

  async consumeInvitation(token: string): Promise<Invitation | null> {
    const data = await this.read();
    const invitation = data.invitations.find((item) => item.token === token && !item.usedAt);
    if (!invitation) {
      return null;
    }

    invitation.usedAt = new Date().toISOString();
    await this.write(data);
    return invitation;
  }

  async createLibrary(library: Library): Promise<Library> {
    const data = await this.read();
    data.libraries.push(library);

    for (const user of data.users) {
      if (library.isPersonal && user.id !== library.ownerUserId) {
        continue;
      }
      if (!user.allowedLibraryIds.includes(library.id)) {
        user.allowedLibraryIds.push(library.id);
      }
    }

    await this.write(data);
    return library;
  }

  async markLibraryScanned(libraryId: string, scannedAt: string): Promise<void> {
    const data = await this.read();
    const library = data.libraries.find((item) => item.id === libraryId);
    if (!library) {
      return;
    }

    library.lastScannedAt = scannedAt;
    await this.write(data);
  }

  async toggleBookmark(bookmark: Bookmark): Promise<{ marked: boolean }> {
    const data = await this.read();
    const existingIndex = data.bookmarks.findIndex(
      (item) =>
        item.userId === bookmark.userId &&
        item.contentId === bookmark.contentId &&
        item.page === bookmark.page
    );

    if (existingIndex >= 0) {
      data.bookmarks.splice(existingIndex, 1);
      await this.write(data);
      return { marked: false };
    }

    data.bookmarks.push(bookmark);
    await this.write(data);
    return { marked: true };
  }

  async toggleSeriesMark(mark: SeriesMark): Promise<{ marked: boolean }> {
    const data = await this.read();
    const existingIndex = data.seriesMarks.findIndex(
      (item) => item.userId === mark.userId && item.contentId === mark.contentId
    );

    if (existingIndex >= 0) {
      data.seriesMarks.splice(existingIndex, 1);
      await this.write(data);
      return { marked: false };
    }

    data.seriesMarks.push(mark);
    await this.write(data);
    return { marked: true };
  }

  async addToWantToRead(mark: SeriesMark): Promise<void> {
    const data = await this.read();
    if (!data.wantToRead.some((item) => item.userId === mark.userId && item.contentId === mark.contentId)) {
      data.wantToRead.push(mark);
      await this.write(data);
    }
  }

  async removeFromWantToRead(userId: string, contentId: string): Promise<void> {
    const data = await this.read();
    data.wantToRead = data.wantToRead.filter((item) => !(item.userId === userId && item.contentId === contentId));
    await this.write(data);
  }

  async addToReadingList(mark: SeriesMark): Promise<void> {
    const data = await this.read();
    if (!data.readingList.some((item) => item.userId === mark.userId && item.contentId === mark.contentId)) {
      data.readingList.push(mark);
      await this.write(data);
    }
  }

  async removeFromReadingList(userId: string, contentId: string): Promise<void> {
    const data = await this.read();
    data.readingList = data.readingList.filter((item) => !(item.userId === userId && item.contentId === contentId));
    await this.write(data);
  }

  async addToCollection(userId: string, collectionId: string, contentId: string): Promise<ContentCollection | null> {
    const data = await this.read();
    const collection = data.collections.find((item) => item.userId === userId && item.id === collectionId);
    if (!collection) {
      return null;
    }

    if (!collection.contentIds.includes(contentId)) {
      collection.contentIds.push(contentId);
      collection.updatedAt = new Date().toISOString();
      await this.write(data);
    }

    return collection;
  }

  async createCollection(collection: ContentCollection): Promise<ContentCollection> {
    const data = await this.read();
    data.collections.push(collection);
    await this.write(data);
    return collection;
  }

  async updateCollection(userId: string, collectionId: string, updates: Pick<ContentCollection, "name" | "description">): Promise<ContentCollection | null> {
    const data = await this.read();
    const collection = data.collections.find((item) => item.userId === userId && item.id === collectionId);
    if (!collection) {
      return null;
    }

    collection.name = updates.name;
    collection.description = updates.description;
    collection.updatedAt = new Date().toISOString();
    await this.write(data);
    return collection;
  }

  async updateCollectionSharing(userId: string, collectionId: string, sharedWithUserIds: string[]): Promise<ContentCollection | null> {
    const data = await this.read();
    const collection = data.collections.find((item) => item.userId === userId && item.id === collectionId);
    if (!collection) {
      return null;
    }

    collection.sharedWithUserIds = sharedWithUserIds;
    collection.updatedAt = new Date().toISOString();
    await this.write(data);
    return collection;
  }

  async deleteCollection(userId: string, collectionId: string): Promise<boolean> {
    const data = await this.read();
    const collectionIndex = data.collections.findIndex((item) => item.userId === userId && item.id === collectionId);
    if (collectionIndex < 0) {
      return false;
    }

    data.collections.splice(collectionIndex, 1);
    await this.write(data);
    return true;
  }

  async removeFromCollection(userId: string, collectionId: string, contentId: string): Promise<ContentCollection | null> {
    const data = await this.read();
    const collection = data.collections.find((item) => item.userId === userId && item.id === collectionId);
    if (!collection) {
      return null;
    }

    collection.contentIds = collection.contentIds.filter((item) => item !== contentId);
    collection.updatedAt = new Date().toISOString();
    await this.write(data);
    return collection;
  }

  async removeContentForUser(userId: string, contentId: string): Promise<void> {
    const data = await this.read();
    data.progress = data.progress.filter((item) => !(item.userId === userId && item.contentId === contentId));
    data.bookmarks = data.bookmarks.filter((item) => !(item.userId === userId && item.contentId === contentId));
    data.seriesMarks = data.seriesMarks.filter((item) => !(item.userId === userId && item.contentId === contentId));
    data.wantToRead = data.wantToRead.filter((item) => !(item.userId === userId && item.contentId === contentId));
    data.readingList = data.readingList.filter((item) => !(item.userId === userId && item.contentId === contentId));
    for (const collection of data.collections.filter((item) => item.userId === userId)) {
      collection.contentIds = collection.contentIds.filter((item) => item !== contentId);
      collection.updatedAt = new Date().toISOString();
    }
    await this.write(data);
  }

  async upsertReview(review: ContentReview): Promise<void> {
    const data = await this.read();
    const existingIndex = data.reviews.findIndex(
      (item) => item.userId === review.userId && item.contentId === review.contentId
    );

    if (existingIndex >= 0) {
      data.reviews[existingIndex] = review;
    } else {
      data.reviews.push(review);
    }

    await this.write(data);
  }
}

export const store = new Store();
