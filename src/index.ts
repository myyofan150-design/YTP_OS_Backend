// src/index.ts
// Express app entry point. Sets up middleware, mounts routes, and starts the server.

import dotenv from "dotenv";
import path from "path";
dotenv.config({
  path: path.resolve(process.cwd(), process.env["NODE_ENV"] === "production" ? ".env.production" : ".env"),
});
import { createServer } from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { Server as SocketServer } from "socket.io";
import { setupSocketHandlers } from "./lib/socket";

const app = express();
const PORT = parseInt(process.env["PORT"] || "5000", 10);

// ─── Security & Parsing ───────────────────────────────────────────────────
app.use(helmet());
const allowedOrigins = (process.env["CORS_ORIGIN"] || "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Static File Serving (uploads) ───────────────────────────────────────
// Allow cross-origin image/file loads (helmet sets same-origin by default)
// Use UPLOAD_DIR env var so this matches wherever multer actually saves files.
const uploadsDir = process.env["UPLOAD_DIR"] || path.join(process.cwd(), "uploads");
app.use("/uploads", (_req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}, express.static(uploadsDir));

// ─── Health Check ─────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok", timestamp: new Date() }, message: "Agency OS Backend is running" });
});

// ─── Routes ───────────────────────────────────────────────────────────────
import authRoutes       from "./routes/auth.routes";
import usersRoutes      from "./routes/users.routes";
import clientsRoutes    from "./routes/clients.routes";
import employeesRoutes  from "./routes/employees.routes";
import tasksRoutes      from "./routes/tasks.routes";
import attendanceRoutes from "./routes/attendance.routes";
import leaveRoutes      from "./routes/leave.routes";
import payrollRoutes       from "./routes/payroll.routes";
import invoicesRoutes      from "./routes/invoices.routes";
import dashboardRoutes     from "./routes/dashboard.routes";
import notificationsRoutes from "./routes/notifications.routes";
import workspaceRoutes             from "./routes/workspace.routes";
import subscriptionsRoutes         from "./routes/subscriptions.routes";
import leadsRoutes                 from "./routes/leads.routes";
import todoRoutes                  from "./routes/todo.routes";
import notesRoutes                 from "./routes/notes.routes";
import chatRoutes                  from "./routes/chat.routes";
import settingsRoutes              from "./routes/settings.routes";
import { startSubscriptionExpiryJob } from "./jobs/subscription-expiry.job";
import { startTodoReminderJob }        from "./jobs/todo-reminder.job";
import { startNotesSnoozeJob }         from "./jobs/notes-snooze.job";

app.use("/api/auth",          authRoutes);
app.use("/api/users",         usersRoutes);
app.use("/api/clients",       clientsRoutes);
app.use("/api/employees",     employeesRoutes);
app.use("/api/tasks",         tasksRoutes);
app.use("/api/attendance",    attendanceRoutes);
app.use("/api/leave",         leaveRoutes);
app.use("/api/payroll",       payrollRoutes);
app.use("/api/invoices",      invoicesRoutes);
app.use("/api/dashboard",     dashboardRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/workspace",     workspaceRoutes);
app.use("/api/subscriptions", subscriptionsRoutes);
app.use("/api/leads",         leadsRoutes);
app.use("/api/todo",          todoRoutes);
app.use("/api/notes",         notesRoutes);
app.use("/api/chat",          chatRoutes);
app.use("/api/settings",      settingsRoutes);

// ─── 404 Handler ──────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ─── HTTP server + Socket.io ───────────────────────────────────────────────
const httpServer = createServer(app);

const allowedSocketOrigins = (process.env["CORS_ORIGIN"] || "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((o) => o.trim());

export const io = new SocketServer(httpServer, {
  cors: {
    origin: allowedSocketOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

setupSocketHandlers(io);

// ─── Start Server ─────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n🚀 Agency OS Backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
  startSubscriptionExpiryJob();
  startTodoReminderJob();
  startNotesSnoozeJob();
});

export default app;
