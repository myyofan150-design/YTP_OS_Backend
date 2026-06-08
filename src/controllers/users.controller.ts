// src/controllers/users.controller.ts
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { q, run, RowDataPacket } from "../lib/db";
import { logActivity } from "../lib/logger";

const SEL = `id, uuid, name, email, role, status,
  avatar_url AS avatarUrl, last_login_at AS lastLoginAt,
  created_at AS createdAt, updated_at AS updatedAt`;

export async function listUsers(req: Request, res: Response): Promise<void> {
  try {
    const { role, status, search } = req.query as Record<string, string | undefined>;
    let sql = `SELECT ${SEL} FROM users WHERE 1=1`;
    const p: unknown[] = [];
    if (role)   { sql += " AND role = ?";   p.push(role); }
    if (status) { sql += " AND status = ?"; p.push(status); }
    if (search) { sql += " AND (name LIKE ? OR email LIKE ?)"; p.push(`%${search}%`, `%${search}%`); }
    sql += " ORDER BY created_at DESC";
    const rows = await q<RowDataPacket>(sql, p as string[]);
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[users/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getUser(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const rows = await q<RowDataPacket>(`SELECT ${SEL} FROM users WHERE id = ?`, [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "User not found" }); return; }
    res.json({ success: true, message: "OK", data: rows[0] });
  } catch (err) {
    console.error("[users/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function createUser(req: Request, res: Response): Promise<void> {
  try {
    const { name, email, password, role, clientId } = req.body as Record<string, string | undefined>;
    if (!name || !email || !password) {
      res.status(400).json({ success: false, message: "name, email and password are required" }); return;
    }
    if (role === "SUPER_ADMIN" && req.user!.role !== "SUPER_ADMIN") {
      res.status(403).json({ success: false, message: "Only SUPER_ADMIN can create another SUPER_ADMIN" }); return;
    }
    if (role === "CLIENT" && !clientId) {
      res.status(400).json({ success: false, message: "clientId is required when role is CLIENT" }); return;
    }
    const exists = await q<RowDataPacket>("SELECT id FROM users WHERE email = ?", [email]);
    if (exists[0]) { res.status(409).json({ success: false, message: "A user with this email already exists" }); return; }
    if (password.length < 8) { res.status(400).json({ success: false, message: "Password must be at least 8 characters" }); return; }

    const hash = await bcrypt.hash(password, 12);
    const result = await run(
      "INSERT INTO users (name, email, password_hash, role, client_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
      [name, email, hash, role ?? "EMPLOYEE", role === "CLIENT" ? (clientId ?? null) : null]
    );
    const newRows = await q<RowDataPacket>(`SELECT ${SEL} FROM users WHERE id = ?`, [result.insertId]);
    await logActivity(req.user!.id, "CREATE_USER", "User", result.insertId, undefined, { name, email, role }, req.ip);
    res.status(201).json({ success: true, message: "User created successfully", data: newRows[0] });
  } catch (err) {
    console.error("[users/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const existRows = await q<RowDataPacket>(`SELECT ${SEL} FROM users WHERE id = ?`, [id]);
    if (!existRows[0]) { res.status(404).json({ success: false, message: "User not found" }); return; }

    const { name, email, role, status, avatarUrl } = req.body as Record<string, string | undefined>;
    if (role && role !== existRows[0]["role"] && req.user!.role !== "SUPER_ADMIN" && req.user!.id === id) {
      res.status(403).json({ success: false, message: "You cannot change your own role" }); return;
    }

    const sets: string[] = [];
    const p: unknown[] = [];
    if (name      != null) { sets.push("name = ?");       p.push(name); }
    if (email     != null) { sets.push("email = ?");      p.push(email); }
    if (role      != null) { sets.push("role = ?");       p.push(role); }
    if (status    != null) { sets.push("status = ?");     p.push(status); }
    if (avatarUrl !== undefined) { sets.push("avatar_url = ?"); p.push(avatarUrl); }

    if (sets.length > 0) {
      p.push(id);
      await run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, p as string[]);
    }
    const updRows = await q<RowDataPacket>(`SELECT ${SEL} FROM users WHERE id = ?`, [id]);
    await logActivity(req.user!.id, "UPDATE_USER", "User", id, existRows[0], updRows[0], req.ip);
    res.json({ success: true, message: "User updated successfully", data: updRows[0] });
  } catch (err) {
    console.error("[users/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function toggleUserStatus(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    if (id === req.user!.id) {
      res.status(400).json({ success: false, message: "You cannot deactivate your own account" }); return;
    }
    const rows = await q<RowDataPacket>("SELECT id, status FROM users WHERE id = ?", [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "User not found" }); return; }

    const newStatus = rows[0]["status"] === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    await run("UPDATE users SET status = ? WHERE id = ?", [newStatus, id]);
    const updRows = await q<RowDataPacket>(`SELECT ${SEL} FROM users WHERE id = ?`, [id]);
    await logActivity(req.user!.id, `SET_USER_${newStatus}`, "User", id, { status: rows[0]["status"] }, { status: newStatus }, req.ip);
    res.json({
      success: true,
      message: `User ${newStatus === "ACTIVE" ? "activated" : "deactivated"} successfully`,
      data: updRows[0],
    });
  } catch (err) {
    console.error("[users/toggle-status]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"), 10);
    const { newPassword } = req.body as { newPassword?: string };
    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ success: false, message: "New password must be at least 8 characters" }); return;
    }
    const rows = await q<RowDataPacket>("SELECT id FROM users WHERE id = ?", [id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "User not found" }); return; }

    const hash = await bcrypt.hash(newPassword, 12);
    await run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, id]);
    await logActivity(req.user!.id, "RESET_PASSWORD", "User", id, undefined, undefined, req.ip);
    res.json({ success: true, message: "Password reset successfully", data: null });
  } catch (err) {
    console.error("[users/reset-password]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
