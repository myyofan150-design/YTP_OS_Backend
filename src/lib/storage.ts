// src/lib/storage.ts
// File upload abstraction using multer. Saves files to uploads/<subfolder>/.
// Returns the relative path for storage in the database.

import multer from "multer";
import path from "path";
import fs from "fs";

const UPLOAD_DIR = process.env["UPLOAD_DIR"] || "./uploads";

function getStorage(subfolder: string) {
  const dest = path.join(UPLOAD_DIR, subfolder);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dest),
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = path.extname(file.originalname);
      cb(null, `${unique}${ext}`);
    },
  });
}

export function createUploader(subfolder: string, maxSizeMb = 10) {
  return multer({
    storage: getStorage(subfolder),
    limits: { fileSize: maxSizeMb * 1024 * 1024 },
  });
}

// Returns a relative path suitable for storing in the database
export function getRelativePath(subfolder: string, filename: string): string {
  return `uploads/${subfolder}/${filename}`;
}
