export function deviceHints() {
    if (typeof navigator === 'undefined')
        return {};
    const device = navigator;
    return { deviceMemory: device.deviceMemory, hardwareConcurrency: device.hardwareConcurrency, saveData: device.connection?.saveData, effectiveType: device.connection?.effectiveType };
}
export function readerBudget(hints) {
    const capable = (hints.deviceMemory ?? 0) >= 8 && (hints.hardwareConcurrency ?? 0) >= 8;
    return { pdfCanvases: capable ? 6 : 3, pdfPixels: capable ? 4_000_000 : 2_000_000, pdfConcurrency: capable ? 2 : 1, pdfMargin: capable ? 1000 : 400, imageEntries: capable ? 8 : 4, imageBytes: capable ? 64 * 1024 * 1024 : 24 * 1024 * 1024 };
}
export function canvasSize(width, height, dpr, maxPixels) {
    const scale = Math.min(dpr || 1, 2, Math.sqrt(maxPixels / (width * height)));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}
export function canvasPixels(width, height, dpr, maxPixels) {
    const size = canvasSize(width, height, dpr, maxPixels);
    return size.width * size.height;
}
export function imagePrefetchOffsets(hints, direction) {
    if (hints.saveData || hints.effectiveType === 'slow-2g' || hints.effectiveType === '2g')
        return [];
    const step = direction < 0 ? -1 : 1;
    return hints.effectiveType === '3g' ? [step] : [step, 2 * step, -step];
}
