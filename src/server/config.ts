import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Centraliza caminhos e portas para facilitar Docker, ZimaOS e execução local.
export const config = {
  port: Number(process.env.PORT ?? 8099),
  sessionSecret: process.env.SESSION_SECRET ?? "pugotiread-dev-secret",
  dataFile: process.env.DATA_FILE ?? path.join(projectRoot, "data/store.json"),
  publicDir: process.env.PUBLIC_DIR ?? path.join(projectRoot, "public"),
  clientDir: process.env.CLIENT_DIR ?? path.join(projectRoot, "dist/client"),
  mediaRoot: process.env.MEDIA_ROOT ?? path.join(projectRoot, "media"),
  vaultMediaRoot: process.env.VAULT_MEDIA_ROOT ?? path.join(projectRoot, "media/cofre")
};
