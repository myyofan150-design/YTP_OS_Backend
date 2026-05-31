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

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
