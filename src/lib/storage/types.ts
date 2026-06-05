export interface UploadOptions {
  folder: string;    // e.g. "agency-os/avatars"
  filename: string;  // original filename — used as public_id hint
  mimetype: string;
}

export interface UploadResult {
  url: string;      // Full CDN URL — stored in DB
  publicId: string; // Provider key — used for deletion
}

export interface StorageProvider {
  upload(buffer: Buffer, options: UploadOptions): Promise<UploadResult>;
  delete(url: string): Promise<void>;
}
