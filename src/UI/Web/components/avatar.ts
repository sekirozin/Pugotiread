import type { PublicUser } from "../../../shared/types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "U";
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
  return `${first}${second}`.toUpperCase();
}

function avatarStyle(name: string): string {
  const variants = [
    ["#1c31a5", "#101f78"],
    ["#101f78", "#020f59"],
    ["#1c31a5", "#020f59"],
    ["#101f78", "#000524"]
  ];
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) % variants.length;
  }

  const [first, second] = variants[hash] ?? variants[0];
  return `--avatar-a: ${first}; --avatar-b: ${second};`;
}

export function renderAvatar(user: PublicUser | null, className = "avatar"): string {
  const userName = user?.nickname || user?.displayName || user?.username || "Usuário";
  if (user?.avatarUrl) {
    return `<span class="${className} photo-avatar" style="background-image: url('${escapeHtml(user.avatarUrl)}')"></span>`;
  }

  return `<span class="${className}" style="${avatarStyle(userName)}">${escapeHtml(getInitials(userName))}</span>`;
}
