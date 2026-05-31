// src/lib/db.ts — mysql2 connection pool (replaces Prisma)
import mysql from "mysql2/promise";
export type { RowDataPacket, ResultSetHeader } from "mysql2";

export const pool = mysql.createPool({
  host:               process.env["DB_HOST"]     || "localhost",
  port:               parseInt(process.env["DB_PORT"] || "3306", 10),
  user:               process.env["DB_USER"]     || "root",
  password:           process.env["DB_PASS"]     || "",
  database:           process.env["DB_NAME"]     || "ytp_os",
  waitForConnections: true,
  connectionLimit:    10,
  supportBigNumbers:  true,
  bigNumberStrings:   true,
  decimalNumbers:     true,
  timezone:           "+00:00",
  dateStrings:        true,
});

import type { RowDataPacket, ResultSetHeader } from "mysql2";

// SELECT helper — returns typed row array
export async function q<T extends RowDataPacket>(
  sql: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any[] = []
): Promise<T[]> {
  const [rows] = await pool.execute<T[]>(sql, params);
  return rows;
}

// INSERT / UPDATE / DELETE helper — returns ResultSetHeader
export async function run(
  sql: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any[] = []
): Promise<ResultSetHeader> {
  const [result] = await pool.execute<ResultSetHeader>(sql, params);
  return result;
}
