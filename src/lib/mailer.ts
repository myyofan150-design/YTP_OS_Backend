// src/lib/mailer.ts
// Nodemailer abstraction. Reads SMTP settings from env variables.
// Call sendMail(to, subject, html) from any controller.

import nodemailer from "nodemailer";

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env["SMTP_HOST"],
    port: parseInt(process.env["SMTP_PORT"] || "587", 10),
    secure: parseInt(process.env["SMTP_PORT"] || "587", 10) === 465,
    auth: {
      user: process.env["SMTP_USER"],
      pass: process.env["SMTP_PASS"],
    },
  });
}

export async function sendMail(
  to: string | string[],
  subject: string,
  html: string
): Promise<void> {
  const transporter = createTransporter();
  await transporter.sendMail({
    from: process.env["SMTP_FROM"] || "Agency OS <noreply@agencyos.com>",
    to: Array.isArray(to) ? to.join(", ") : to,
    subject,
    html,
  });
}
