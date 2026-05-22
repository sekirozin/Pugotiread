import type { IncomingMessage, ServerResponse } from "node:http";
export declare function readJson<T>(req: IncomingMessage): Promise<T>;
export declare function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void;
export declare function sendNoContent(res: ServerResponse): void;
export declare function sendFile(res: ServerResponse, filePath: string): Promise<void>;
export declare function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void>;
//# sourceMappingURL=http.d.ts.map