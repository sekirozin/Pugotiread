import type { IncomingMessage, ServerResponse } from "node:http";
import type { PublicUser, User } from "../shared/types.js";
export declare function toPublicUser(user: User): PublicUser;
type GoogleTokenPayload = {
    sub: string;
    email: string;
    email_verified: boolean | string;
    name?: string;
    picture?: string;
    aud: string;
    iss: string;
    exp: number;
};
export declare function verifyGoogleIdToken(credential: string): Promise<GoogleTokenPayload>;
export declare function hashPassword(password: string): string;
export declare function verifyPassword(user: User, password: string): boolean;
export declare function isPasswordHashReady(passwordHash: string): boolean;
export declare function createSessionToken(userId: string): string;
export declare function getCookie(req: IncomingMessage, name: string): string | null;
export declare function getCurrentUser(req: IncomingMessage): Promise<User | null>;
export declare function setSessionCookie(res: ServerResponse, token: string): void;
export declare function clearSessionCookie(res: ServerResponse): void;
export {};
//# sourceMappingURL=auth.d.ts.map