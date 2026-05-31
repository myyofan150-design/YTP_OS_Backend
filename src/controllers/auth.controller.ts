// src/controllers/auth.controller.ts
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { q, run, RowDataPacket } from "../lib/db";
import { signToken } from "../lib/jwt";
import { logActivity } from "../lib/logger";

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ success: false, message: "Email and password are required" }); return;
    }

    const rows = await q<RowDataPacket>(
      "SELECT id, uuid, name, email, password_hash AS passwordHash, role, status, avatar_url AS avatarUrl FROM users WHERE email = ?",
      [email]
    );
    const user = rows[0];
    if (!user) { res.status(401).json({ success: false, message: "Invalid email or password" }); return; }
    if (user["status"] === "INACTIVE") {
      res.status(403).json({ success: false, message: "Account is deactivated. Contact your administrator." }); return;
    }

    const valid = await bcrypt.compare(password, String(user["passwordHash"]));
    if (!valid) { res.status(401).json({ success: false, message: "Invalid email or password" }); return; }

    const token = signToken({
      id:    Number(user["id"]),
      uuid:  String(user["uuid"]),
      role:  String(user["role"]),
      email: String(user["email"]),
    });

    await run("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user["id"]]);
    await logActivity(Number(user["id"]), "LOGIN", "User", Number(user["id"]), undefined, undefined, req.ip);

    res.json({
      success: true, message: "Login successful",
      data: {
        token,
        user: {
          id:        user["id"],
          uuid:      user["uuid"],
          name:      user["name"],
          email:     user["email"],
          role:      user["role"],
          status:    user["status"],
          avatarUrl: user["avatarUrl"],
        },
      },
    });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function me(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT u.id, u.uuid, u.name, u.email, u.role, u.status,
              u.avatar_url AS avatarUrl, u.last_login_at AS lastLoginAt, u.created_at AS createdAt,
              e.id AS empId, e.employee_code AS employeeCode, e.department, e.designation,
              e.joining_date AS joiningDate
       FROM users u LEFT JOIN employees e ON e.user_id = u.id
       WHERE u.id = ?`,
      [req.user!.id]
    );
    const row = rows[0];
    if (!row) { res.status(404).json({ success: false, message: "User not found" }); return; }

    res.json({
      success: true, message: "OK",
      data: {
        id: row["id"], uuid: row["uuid"], name: row["name"], email: row["email"],
        role: row["role"], status: row["status"], avatarUrl: row["avatarUrl"],
        lastLoginAt: row["lastLoginAt"], createdAt: row["createdAt"],
        employee: row["empId"] ? {
          id: row["empId"], employeeCode: row["employeeCode"],
          department: row["department"], designation: row["designation"], joiningDate: row["joiningDate"],
        } : null,
      },
    });
  } catch (err) {
    console.error("[auth/me]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function uploadAvatar(req: Request, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded" }); return;
    }
    if (!req.file.mimetype.startsWith("image/")) {
      res.status(400).json({ success: false, message: "Only image files are allowed" }); return;
    }
    const relativePath = `uploads/avatars/${req.file.filename}`;
    await run("UPDATE users SET avatar_url = ? WHERE id = ?", [relativePath, req.user!.id]);

    const rows = await q<RowDataPacket>(
      "SELECT id, uuid, name, email, role, status, avatar_url AS avatarUrl FROM users WHERE id = ?",
      [req.user!.id]
    );
    const u = rows[0];
    res.json({
      success: true, message: "Avatar updated successfully",
      data: {
        id: u["id"], uuid: u["uuid"], name: u["name"], email: u["email"],
        role: u["role"], status: u["status"], avatarUrl: u["avatarUrl"],
      },
    });
  } catch (err) {
    console.error("[auth/avatar]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  try {
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, message: "Current and new passwords are required" }); return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ success: false, message: "New password must be at least 8 characters" }); return;
    }

    const rows = await q<RowDataPacket>("SELECT id, password_hash AS passwordHash FROM users WHERE id = ?", [req.user!.id]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "User not found" }); return; }

    const valid = await bcrypt.compare(currentPassword, String(rows[0]["passwordHash"]));
    if (!valid) { res.status(401).json({ success: false, message: "Current password is incorrect" }); return; }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, req.user!.id]);
    await logActivity(req.user!.id, "CHANGE_PASSWORD", "User", req.user!.id, undefined, undefined, req.ip);

    res.json({ success: true, message: "Password changed successfully", data: null });
  } catch (err) {
    console.error("[auth/change-password]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
