// src/lib/jwt.ts
// Signs and verifies JWT tokens using the JWT_SECRET env variable.

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env["JWT_SECRET"] || "changeme_in_production";
const JWT_EXPIRES_IN = process.env["JWT_EXPIRES_IN"] || "8h";

export interface TokenPayload {
  id: number;
  uuid: string;
  role: string;
  email: string;
}

export interface TempTokenPayload {
  id: number;
  email: string;
  scope: "2fa_pending";
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

// Short-lived token issued after password check, before 2FA verification
export function signTempToken(payload: Omit<TempTokenPayload, "scope">): string {
  return jwt.sign({ ...payload, scope: "2fa_pending" }, JWT_SECRET, { expiresIn: "10m" });
}

export function verifyTempToken(token: string): TempTokenPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as TempTokenPayload;
  if (decoded.scope !== "2fa_pending") throw new Error("Invalid token scope");
  return decoded;
}
