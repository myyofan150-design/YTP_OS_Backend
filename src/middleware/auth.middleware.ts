// src/middleware/auth.middleware.ts
// Reads the Authorization header, extracts the Bearer token, verifies it with JWT,
// and attaches the decoded user payload to req.user. Returns 401 if invalid.

import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      res.status(401).json({ success: false, message: "Token missing" });
      return;
    }

    const decoded = verifyToken(token);
    req.user = {
      id: decoded.id,
      uuid: decoded.uuid,
      role: decoded.role,
      email: decoded.email,
    };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}
