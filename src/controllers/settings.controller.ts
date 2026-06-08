// src/controllers/settings.controller.ts
import { Request, Response } from "express";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";
import { uploadFile, deleteFile } from "../lib/storage";

const GENERAL_KEYS = ["company_name", "company_tagline", "company_email", "company_logo_url", "company_phone", "company_address", "company_seal_url", "sidebar_icon_url"] as const;

export async function getGeneralSettings(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      "SELECT `key`, value FROM system_settings WHERE `key` IN (?, ?, ?, ?, ?, ?, ?, ?)",
      [...GENERAL_KEYS]
    );
    const settings: Record<string, string | null> = {};
    for (const key of GENERAL_KEYS) settings[key] = null;
    rows.forEach(r => { settings[String(r["key"])] = r["value"] ? String(r["value"]) : null; });
    res.json({ success: true, data: settings, message: "OK" });
  } catch (err) {
    console.error("[settings/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateGeneralSettings(req: Request, res: Response): Promise<void> {
  try {
    const { company_name, company_tagline, company_email, company_phone, company_address } = req.body as Record<string, string | undefined>;

    const updates: { key: string; value: string | null }[] = [];
    if (company_name    !== undefined) updates.push({ key: "company_name",    value: company_name    || null });
    if (company_tagline !== undefined) updates.push({ key: "company_tagline", value: company_tagline || null });
    if (company_email   !== undefined) updates.push({ key: "company_email",   value: company_email   || null });
    if (company_phone   !== undefined) updates.push({ key: "company_phone",   value: company_phone   || null });
    if (company_address !== undefined) updates.push({ key: "company_address", value: company_address || null });

    for (const u of updates) {
      await run(
        "INSERT INTO system_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
        [u.key, u.value]
      );
    }

    await logActivity(req.user!.id, "settings.updated", "SystemSettings", 0, undefined, req.body, req.ip);
    const rows = await q<RowDataPacket>(
      "SELECT `key`, value FROM system_settings WHERE `key` IN (?, ?, ?, ?, ?, ?, ?, ?)",
      [...GENERAL_KEYS]
    );
    const settings: Record<string, string | null> = {};
    for (const key of GENERAL_KEYS) settings[key] = null;
    rows.forEach(r => { settings[String(r["key"])] = r["value"] ? String(r["value"]) : null; });
    res.json({ success: true, data: settings, message: "Settings updated" });
  } catch (err) {
    console.error("[settings/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function uploadCompanyLogo(req: Request, res: Response): Promise<void> {
  try {
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }

    // Delete old logo from cloud storage before uploading the new one
    const existing = await q<RowDataPacket>("SELECT value FROM system_settings WHERE `key` = 'company_logo_url'");
    const oldUrl = existing[0]?.["value"] as string | null;
    if (oldUrl) await deleteFile(oldUrl);

    const { url } = await uploadFile(req.file.buffer, { folder: "settings", filename: req.file.originalname, mimetype: req.file.mimetype });
    await run(
      "INSERT INTO system_settings (`key`, value) VALUES ('company_logo_url', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [url]
    );
    await logActivity(req.user!.id, "settings.logo_uploaded", "SystemSettings", 0, undefined, { url }, req.ip);
    res.json({ success: true, data: { logoUrl: url }, message: "Logo uploaded" });
  } catch (err) {
    console.error("[settings/logo]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function uploadCompanySeal(req: Request, res: Response): Promise<void> {
  try {
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }

    const existing = await q<RowDataPacket>("SELECT value FROM system_settings WHERE `key` = 'company_seal_url'");
    const oldUrl = existing[0]?.["value"] as string | null;
    if (oldUrl) await deleteFile(oldUrl);

    const { url } = await uploadFile(req.file.buffer, { folder: "settings", filename: req.file.originalname, mimetype: req.file.mimetype });
    await run(
      "INSERT INTO system_settings (`key`, value) VALUES ('company_seal_url', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [url]
    );
    await logActivity(req.user!.id, "settings.seal_uploaded", "SystemSettings", 0, undefined, { url }, req.ip);
    res.json({ success: true, data: { sealUrl: url }, message: "Seal uploaded" });
  } catch (err) {
    console.error("[settings/seal]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function uploadSidebarIcon(req: Request, res: Response): Promise<void> {
  try {
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }

    const existing = await q<RowDataPacket>("SELECT value FROM system_settings WHERE `key` = 'sidebar_icon_url'");
    const oldUrl = existing[0]?.["value"] as string | null;
    if (oldUrl) await deleteFile(oldUrl);

    const { url } = await uploadFile(req.file.buffer, { folder: "settings", filename: req.file.originalname, mimetype: req.file.mimetype });
    await run(
      "INSERT INTO system_settings (`key`, value) VALUES ('sidebar_icon_url', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [url]
    );
    await logActivity(req.user!.id, "settings.sidebar_icon_uploaded", "SystemSettings", 0, undefined, { url }, req.ip);
    res.json({ success: true, data: { sidebarIconUrl: url }, message: "Sidebar icon uploaded" });
  } catch (err) {
    console.error("[settings/sidebar-icon]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
