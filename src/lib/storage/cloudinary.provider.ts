import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";
import type { StorageProvider, UploadOptions, UploadResult } from "./types";

cloudinary.config({
  cloud_name: process.env["CLOUDINARY_CLOUD_NAME"]!,
  api_key:    process.env["CLOUDINARY_API_KEY"]!,
  api_secret: process.env["CLOUDINARY_API_SECRET"]!,
  secure:     true,
});

function resourceType(mimetype: string): "image" | "video" | "raw" {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  return "raw";
}

// Cloudinary URLs encode the resource type in the path, e.g.:
//   https://res.cloudinary.com/{cloud}/image/upload/v{ver}/{public_id}.jpg
//   https://res.cloudinary.com/{cloud}/raw/upload/v{ver}/{public_id}.pdf
// For image/video the public_id has no extension; for raw it does.
function parseUrl(url: string): { type: "image" | "video" | "raw"; publicId: string } | null {
  const m = url.match(/cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:[^/]+\/)*v?\d*\/?(.+)$/);
  if (!m) return null;
  const type = m[1] as "image" | "video" | "raw";
  let publicId = m[2]!;
  if (type !== "raw") publicId = publicId.replace(/\.[^.]+$/, "");
  return { type, publicId };
}

export class CloudinaryProvider implements StorageProvider {
  async upload(buffer: Buffer, opts: UploadOptions): Promise<UploadResult> {
    const rType = resourceType(opts.mimetype);

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: rType,
          folder: opts.folder,
          use_filename: true,
          unique_filename: true,
        },
        (err, result) => {
          if (err || !result) return reject(err ?? new Error("Cloudinary upload failed"));
          resolve({ url: result.secure_url, publicId: result.public_id });
        }
      );

      const readable = new Readable();
      readable.push(buffer);
      readable.push(null);
      readable.pipe(stream);
    });
  }

  async delete(url: string): Promise<void> {
    const parsed = parseUrl(url);
    if (!parsed) return; // not a Cloudinary URL — nothing to do
    await cloudinary.uploader.destroy(parsed.publicId, { resource_type: parsed.type });
  }
}
