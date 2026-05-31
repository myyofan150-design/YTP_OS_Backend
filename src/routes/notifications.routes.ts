// src/routes/notifications.routes.ts
import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { q, run, RowDataPacket } from "../lib/db";

const router = Router();
router.use(authenticate);

router.get("/", async (req: Request, res: Response) => {
  try {
    const unreadOnly = req.query["unread"] === "true";
    let sql = "SELECT id, user_id AS userId, type, title, body, link, is_read AS isRead, created_at AS createdAt FROM notifications WHERE user_id = ?";
    const p: unknown[] = [req.user!.id];
    if (unreadOnly) { sql += " AND is_read = 0"; }
    sql += " ORDER BY created_at DESC LIMIT 50";
    const rows = await q<RowDataPacket>(sql, p as string[]);
    res.json({ success: true, data: rows, message: "OK" });
  } catch {
    res.status(500).json({ success: false, message: "Failed" });
  }
});

router.get("/unread-count", async (req: Request, res: Response) => {
  try {
    const rows = await q<RowDataPacket>("SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0", [req.user!.id]);
    res.json({ success: true, data: { count: Number(rows[0]?.["cnt"] ?? 0) }, message: "OK" });
  } catch {
    res.status(500).json({ success: false, message: "Failed" });
  }
});

router.patch("/read-all", async (req: Request, res: Response) => {
  try {
    await run("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [req.user!.id]);
    res.json({ success: true, data: null, message: "All marked read" });
  } catch {
    res.status(500).json({ success: false, message: "Failed" });
  }
});

router.patch("/:id/read", async (req: Request, res: Response) => {
  try {
    const rows = await q<RowDataPacket>("SELECT id, user_id AS userId FROM notifications WHERE id = ?", [Number(req.params["id"])]);
    if (!rows[0] || Number(rows[0]["userId"]) !== req.user!.id) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    await run("UPDATE notifications SET is_read = 1 WHERE id = ?", [rows[0]["id"]]);
    res.json({ success: true, data: null, message: "Marked read" });
  } catch {
    res.status(500).json({ success: false, message: "Failed" });
  }
});

export default router;
