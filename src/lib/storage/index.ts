// Storage service — provider-agnostic file upload/delete.
// Switch providers by setting STORAGE_PROVIDER=cloudinary|local in .env.
// Add new providers by implementing StorageProvider and adding a case below.

import multer from "multer";
import type { StorageProvider, UploadOptions, UploadResult } from "./types";

export type { UploadResult };

function createProvider(): StorageProvider {
  const name = (process.env["STORAGE_PROVIDER"] || "local").toLowerCase();
  if (name === "cloudinary") {
    const { CloudinaryProvider } = require("./cloudinary.provider");
    return new CloudinaryProvider();
  }
  if (name === "local") {
    const { LocalProvider } = require("./local.provider");
    return new LocalProvider();
  }
  throw new Error(`Unknown STORAGE_PROVIDER: "${name}". Supported: cloudinary, local`);
}

const provider: StorageProvider = createProvider();
console.log(`[storage] provider = ${(process.env["STORAGE_PROVIDER"] || "local").toLowerCase()}`);

// Returns a multer instance using in-memory buffering.
// Controllers call uploadFile() after multer runs to push the buffer to the provider.
export function createUploader(subfolder: string, maxSizeMb = 10): multer.Multer {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMb * 1024 * 1024 },
  });
}

// Upload a buffer to the active provider under the given folder.
// `folder` is the short subfolder name, e.g. "avatars", "employee-docs".
export async function uploadFile(
  buffer: Buffer,
  opts: { folder: string; filename: string; mimetype: string }
): Promise<UploadResult> {
  return provider.upload(buffer, {
    folder: `agency-os/${opts.folder}`,
    filename: opts.filename,
    mimetype: opts.mimetype,
  });
}

// Delete a file by its stored URL (or legacy relative path for local provider).
export async function deleteFile(url: string): Promise<void> {
  return provider.delete(url);
}
