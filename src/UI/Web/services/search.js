import { state } from "../state/store.js";
export function normalizeText(value) {
    return value
        .normalize("NFD")
        .replaceAll(/\p{Diacritic}/gu, "")
        .toLowerCase();
}
export function parseSearch(search) {
    const trimmed = search.trim();
    if (!trimmed.startsWith(">")) {
        return { libraryId: null, query: trimmed };
    }
    const scopedText = trimmed.slice(1).trimStart();
    const normalizedScopedText = normalizeText(scopedText);
    const library = state.libraries.find((item) => {
        const libraryName = normalizeText(item.name);
        return (normalizedScopedText === libraryName ||
            normalizedScopedText.startsWith(`${libraryName} `));
    });
    if (!library) {
        return { libraryId: null, query: trimmed };
    }
    return {
        libraryId: library.id,
        query: scopedText.slice(library.name.length).trimStart()
    };
}
export function filterContents(contents, search) {
    const parsed = parseSearch(search);
    const query = normalizeText(parsed.query);
    return contents.filter((content) => {
        if (parsed.libraryId && content.libraryId !== parsed.libraryId) {
            return false;
        }
        return query.length === 0 || normalizeText(content.title).includes(query);
    });
}
//# sourceMappingURL=search.js.map