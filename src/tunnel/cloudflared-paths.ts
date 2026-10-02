import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TUNNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultDirectories(platform: NodeJS.Platform): string[] {
  const home = path.join(os.homedir(), ".cloudflared");
  return platform === "win32" ? [home] : [home, "/etc/cloudflared", "/usr/local/etc/cloudflared"];
}

function defaultFile(filename: string, platform: NodeJS.Platform): string {
  const candidates = defaultDirectories(platform).map((dir) => path.join(dir, filename));
  for (const candidate of candidates) {
    try {
      fs.statSync(candidate);
      return candidate;
    } catch (error) {
      // An inaccessible configured file is a diagnostic failure, not permission
      // to silently select another credential. Only missing files are skipped.
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return candidate;
    }
  }
  return candidates[0];
}

export function cloudflaredCertPath(platform: NodeJS.Platform = process.platform): string {
  const override = process.env.TUNNEL_ORIGIN_CERT?.trim();
  return override ? path.resolve(override) : defaultFile("cert.pem", platform);
}

export function hasCloudflaredCert(): boolean {
  try { return fs.statSync(cloudflaredCertPath()).isFile(); }
  catch { return false; }
}

/** Resolve exactly the credential the UUID-based runner will pass to cloudflared. */
export function cloudflaredCredentialPath(tunnelId: string, platform: NodeJS.Platform = process.platform): string | null {
  const normalized = tunnelId.trim();
  if (!TUNNEL_ID_RE.test(normalized)) return null;
  const override = process.env.TUNNEL_CRED_FILE?.trim();
  return override ? path.resolve(override) : defaultFile(`${normalized}.json`, platform);
}
