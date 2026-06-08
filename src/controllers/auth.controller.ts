// src/controllers/auth.controller.ts
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { q, run, RowDataPacket } from "../lib/db";
import { signToken, signTempToken, verifyTempToken } from "../lib/jwt";
import { logActivity } from "../lib/logger";
import { uploadFile } from "../lib/storage";
import { sendMail } from "../lib/mailer";

function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999));
}

function otpEmailHtml(name: string, otp: string): string {
  return `
    <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;background:#0d1229;border-radius:16px;color:#e2e8f0;">
      <h2 style="color:#03ff94;margin:0 0 8px;">Agency OS</h2>
      <p style="color:#94a3b8;margin:0 0 24px;font-size:14px;">Two-Step Verification</p>
      <p style="margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
      <p style="margin:0 0 24px;font-size:14px;color:#cbd5e1;">
        Use the code below to complete your login. It expires in <strong>10 minutes</strong>.
      </p>
      <div style="text-align:center;padding:20px 0;background:rgba(3,255,148,0.06);border:1px solid rgba(3,255,148,0.2);border-radius:12px;letter-spacing:10px;font-size:32px;font-weight:700;color:#03ff94;">
        ${otp}
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:#64748b;">
        If you didn't request this, someone may be trying to access your account.
      </p>
    </div>
  `;
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ success: false, message: "Email and password are required" }); return;
    }

    const rows = await q<RowDataPacket>(
      `SELECT id, uuid, name, email, password_hash AS passwordHash, role, status, avatar_url AS avatarUrl,
              two_factor_enabled AS twoFactorEnabled
       FROM users WHERE email = ?`,
      [email]
    );
    const user = rows[0];
    if (!user) { res.status(401).json({ success: false, message: "Invalid email or password" }); return; }
    if (user["status"] === "INACTIVE") {
      res.status(403).json({ success: false, message: "Account is deactivated. Contact your administrator." }); return;
    }

    const valid = await bcrypt.compare(password, String(user["passwordHash"]));
    if (!valid) { res.status(401).json({ success: false, message: "Invalid email or password" }); return; }

    // ── 2FA path ──────────────────────────────────────────────────────────────
    if (user["twoFactorEnabled"]) {
      const otp    = generateOtp();
      const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min

      await run(
        "UPDATE users SET two_factor_otp = ?, two_factor_otp_expiry = ? WHERE id = ?",
        [otp, expiry, user["id"]]
      );

      await sendMail(
        String(user["email"]),
        "Your Agency OS login code",
        otpEmailHtml(String(user["name"]), otp)
      );

      const tempToken = signTempToken({ id: Number(user["id"]), email: String(user["email"]) });

      res.json({
        success: true,
        message: "Verification code sent to your email",
        data: { requiresTwoFactor: true, tempToken },
      });
      return;
    }

    // ── Normal path ───────────────────────────────────────────────────────────
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

export async function verify2fa(req: Request, res: Response): Promise<void> {
  try {
    const { tempToken, otp } = req.body as { tempToken?: string; otp?: string };
    if (!tempToken || !otp) {
      res.status(400).json({ success: false, message: "Token and code are required" }); return;
    }

    let decoded;
    try {
      decoded = verifyTempToken(tempToken);
    } catch {
      res.status(401).json({ success: false, message: "Session expired. Please login again." }); return;
    }

    const rows = await q<RowDataPacket>(
      `SELECT id, uuid, name, email, role, status, avatar_url AS avatarUrl,
              two_factor_otp AS twoFactorOtp, two_factor_otp_expiry AS twoFactorOtpExpiry
       FROM users WHERE id = ?`,
      [decoded.id]
    );
    const user = rows[0];
    if (!user) { res.status(401).json({ success: false, message: "User not found" }); return; }

    if (!user["twoFactorOtp"] || !user["twoFactorOtpExpiry"]) {
      res.status(401).json({ success: false, message: "No verification code pending" }); return;
    }

    // MySQL returns DATETIME as "YYYY-MM-DD HH:MM:SS" (no timezone) with dateStrings:true.
    // Append 'Z' so it's parsed as UTC, matching how it was stored.
    const expiryRaw = String(user["twoFactorOtpExpiry"]);
    const expiry = new Date(expiryRaw.includes("T") ? expiryRaw : expiryRaw.replace(" ", "T") + "Z");
    if (expiry < new Date()) {
      await run("UPDATE users SET two_factor_otp = NULL, two_factor_otp_expiry = NULL WHERE id = ?", [user["id"]]);
      res.status(401).json({ success: false, message: "Code has expired. Please login again." }); return;
    }

    if (String(user["twoFactorOtp"]) !== String(otp).trim()) {
      res.status(401).json({ success: false, message: "Invalid verification code" }); return;
    }

    // Clear OTP after successful use
    await run(
      "UPDATE users SET two_factor_otp = NULL, two_factor_otp_expiry = NULL, last_login_at = NOW() WHERE id = ?",
      [user["id"]]
    );
    await logActivity(Number(user["id"]), "LOGIN", "User", Number(user["id"]), undefined, undefined, req.ip);

    const token = signToken({
      id:    Number(user["id"]),
      uuid:  String(user["uuid"]),
      role:  String(user["role"]),
      email: String(user["email"]),
    });

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
    console.error("[auth/2fa/verify]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function toggle2fa(req: Request, res: Response): Promise<void> {
  try {
    const { enable, password } = req.body as { enable?: boolean; password?: string };
    if (typeof enable !== "boolean") {
      res.status(400).json({ success: false, message: "enable (boolean) is required" }); return;
    }

    const rows = await q<RowDataPacket>(
      "SELECT id, password_hash AS passwordHash, two_factor_enabled AS twoFactorEnabled FROM users WHERE id = ?",
      [req.user!.id]
    );
    const user = rows[0];
    if (!user) { res.status(404).json({ success: false, message: "User not found" }); return; }

    // Disabling 2FA requires password confirmation
    if (!enable) {
      if (!password) {
        res.status(400).json({ success: false, message: "Password is required to disable two-step verification" }); return;
      }
      const valid = await bcrypt.compare(password, String(user["passwordHash"]));
      if (!valid) {
        res.status(401).json({ success: false, message: "Incorrect password" }); return;
      }
    }

    await run(
      "UPDATE users SET two_factor_enabled = ?, two_factor_otp = NULL, two_factor_otp_expiry = NULL WHERE id = ?",
      [enable ? 1 : 0, req.user!.id]
    );

    res.json({
      success: true,
      message: enable ? "Two-step verification enabled" : "Two-step verification disabled",
      data: { twoFactorEnabled: enable },
    });
  } catch (err) {
    console.error("[auth/2fa/toggle]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function me(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT u.id, u.uuid, u.name, u.email, u.role, u.status,
              u.avatar_url AS avatarUrl, u.last_login_at AS lastLoginAt, u.created_at AS createdAt,
              u.two_factor_enabled AS twoFactorEnabled, u.client_id AS clientId,
              e.id AS empId, e.employee_code AS employeeCode, e.department, e.designation,
              e.joining_date AS joiningDate,
              c.uuid AS clientUuid, c.company_name AS clientCompanyName, c.logo_url AS clientLogoUrl
       FROM users u
       LEFT JOIN employees e ON e.user_id = u.id
       LEFT JOIN clients c ON c.id = u.client_id
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
        twoFactorEnabled: Boolean(row["twoFactorEnabled"]),
        employee: row["empId"] ? {
          id: row["empId"], employeeCode: row["employeeCode"],
          department: row["department"], designation: row["designation"], joiningDate: row["joiningDate"],
        } : null,
        client: row["clientId"] ? {
          id: row["clientId"], uuid: row["clientUuid"],
          companyName: row["clientCompanyName"], logoUrl: row["clientLogoUrl"],
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
    const { url } = await uploadFile(req.file.buffer, { folder: "avatars", filename: req.file.originalname, mimetype: req.file.mimetype });
    await run("UPDATE users SET avatar_url = ? WHERE id = ?", [url, req.user!.id]);

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
