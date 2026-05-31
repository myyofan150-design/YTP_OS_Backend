// src/types/express.d.ts
// Extends Express Request to carry the authenticated user payload after JWT verification.

import "express";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        uuid: string;
        role: string;
        email: string;
      };
    }
  }
}
