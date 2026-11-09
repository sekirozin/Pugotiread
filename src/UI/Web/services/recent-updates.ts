import type { ChapterInfo } from "../../../shared/types.js";

const RECENT_CHAPTER_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export function isRecentlyUpdatedChapter(chapter: Pick<ChapterInfo, "addedAt">): boolean {
  if (!chapter.addedAt) {
    return false;
  }

  const addedAt = Date.parse(chapter.addedAt);
  const age = Date.now() - addedAt;
  return Number.isFinite(addedAt) && age >= 0 && age <= RECENT_CHAPTER_WINDOW_MS;
}

export function hasRecentlyUpdatedChapters(chapters: ChapterInfo[]): boolean {
  const regularChapters = chapters.filter((chapter) => !chapter.isSpecial);
  const latestChapter = regularChapters.reduce<ChapterInfo | null>((latest, chapter) => {
    if (!latest || chapter.startPage > latest.startPage) {
      return chapter;
    }
    return latest;
  }, null);
  return latestChapter ? isRecentlyUpdatedChapter(latestChapter) : false;
}
