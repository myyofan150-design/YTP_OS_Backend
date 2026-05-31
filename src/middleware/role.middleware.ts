// src/middleware/role.middleware.ts
// Role-based access control middleware. Use after authenticate().
// requireRole("ADMIN", "HR") — returns 403 if the user's role is not in the list.

import { Request, Response, NextFunction } from "express";

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: `Access denied. Required roles: ${roles.join(", ")}`,
      });
      return;
    }
    next();
  };
}
