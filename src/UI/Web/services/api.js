import { state } from "../state/store.js";
export async function api(path, init) {
    const response = await fetch(path, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(state.vaultToken ? { "X-Vault-Token": state.vaultToken } : {}),
            ...(init?.headers ?? {})
        },
        credentials: "same-origin"
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "Erro inesperado." })));
        throw new Error(payload.error ?? "Erro inesperado.");
    }
    if (response.status === 204) {
        return undefined;
    }
    return (await response.json());
}
//# sourceMappingURL=api.js.map