/** Folder convention shared by the library and the PDF copy writer. */
export const RPG_SHEETS_FOLDER = 'Fichas';
export function isRpgSheetFolder(folder) {
    return (folder ?? '').split(/[\\/]+/).some(part => part.trim().toLowerCase() === RPG_SHEETS_FOLDER.toLowerCase());
}
export function rpgSheetCopyFolder(relativeFile) {
    const parts = relativeFile.split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2 || parts[0].toLowerCase() === RPG_SHEETS_FOLDER.toLowerCase())
        return RPG_SHEETS_FOLDER;
    return `${parts[0]}/${RPG_SHEETS_FOLDER}`;
}
