// Local disk storage provider — for development / self-hosted fallback.
// Serves files via the /uploads Express static route.
import fs from "fs";
import path from "path";
import type { StorageProvider, UploadOptions, UploadResult } from "./types";

const UPLOAD_DIR = process.env["UPLOAD_DIR"] || "./uploads";
const BASE_URL   = (process.env["API_BASE_URL"] || `http://localhost:${process.env["PORT"] || "5000"}`).replace(/\/$/, "");

export class LocalProvider implements StorageProvider {
  async upload(buffer: Buffer, opts: UploadOptions): Promise<UploadResult> {
    const subdir = opts.folder.replace(/^agency-os\//, ""); // strip prefix
    const dest = path.join(UPLOAD_DIR, subdir);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    const ext = path.extname(opts.filename);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const filePath = path.join(dest, unique);
    fs.writeFileSync(filePath, buffer);

    const relativePath = `uploads/${subdir}/${unique}`;
    return { url: `${BASE_URL}/${relativePath}`, publicId: relativePath };
  }

  async delete(url: string): Promise<void> {
    // url may be a full http URL or a relative path (legacy)
    const relativePath = url.startsWith("http")
      ? url.replace(`${BASE_URL}/`, "")
      : url;
    try { fs.unlinkSync(path.join(process.cwd(), relativePath)); } catch { /* gone */ }
  }
}
