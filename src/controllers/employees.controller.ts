// src/controllers/employees.controller.ts
import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import bcrypt from "bcryptjs";
import PDFDocument from "pdfkit";
import { q, run, pool, RowDataPacket } from "../lib/db";
import { encrypt, decrypt } from "../lib/encryption";
import { logActivity } from "../lib/logger";
import { MANDATORY_DOCUMENTS } from "../lib/employee-doc-config";

const SENSITIVE_ROLES = ["SUPER_ADMIN", "ADMIN", "HR", "ACCOUNTANT"];
const ALLOWED_DOC_TYPES = [".pdf", ".png", ".jpg", ".jpeg", ".docx", ".xlsx"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeDecrypt(v: unknown): string | null {
  if (!v) return null;
  try { return decrypt(String(v)); } catch { return null; }
}

async function nextEmployeeCode(): Promise<string> {
  const rows = await q<RowDataPacket>("SELECT employee_code AS employeeCode FROM employees ORDER BY employee_code DESC LIMIT 1");
  if (!rows[0]) return "YTP-001";
  const num = parseInt(String(rows[0]["employeeCode"]).replace("YTP-", ""), 10);
  return `YTP-${String(isNaN(num) ? 1 : num + 1).padStart(3, "0")}`;
}

async function resolveEmployee(uuid: string): Promise<{ id: number; userId: number } | null> {
  const rows = await q<RowDataPacket>("SELECT id, user_id AS userId FROM employees WHERE uuid = ?", [uuid]);
  if (!rows[0]) return null;
  return { id: Number(rows[0]["id"]), userId: Number(rows[0]["userId"]) };
}

function calculateSalaryTotals(components: Array<{ componentType: string; amount: number }>) {
  const grossSalary    = components.filter(c => c.componentType === "earning").reduce((s, c) => s + Number(c.amount), 0);
  const totalDeductions = components.filter(c => c.componentType === "deduction").reduce((s, c) => s + Number(c.amount), 0);
  return { grossSalary, totalDeductions, netSalary: grossSalary - totalDeductions };
}

// ─── SELECT template (used by list + create return query) ─────────────────────

const EMP_SEL = `
  e.id, e.uuid, e.user_id AS userId, e.employee_code AS employeeCode,
  e.department, e.designation, e.joining_date AS joiningDate,
  e.shift_start AS shiftStart, e.shift_end AS shiftEnd, e.base_salary AS baseSalary,
  e.bank_name AS bankName, e.bank_account AS bankAccount, e.bank_ifsc AS bankIfsc,
  e.pan_number AS panNumber, e.emergency_contact AS emergencyContact,
  e.emergency_phone AS emergencyPhone, e.status,
  e.created_at AS createdAt, e.updated_at AS updatedAt,
  e.personal_email AS personalEmail, e.phone, e.date_of_birth AS dateOfBirth,
  e.gender, e.photo_url AS photoUrl,
  e.education_qualification AS educationQualification, e.school_college AS schoolCollege,
  e.marital_status AS maritalStatus, e.nationality, e.blood_group AS bloodGroup,
  e.employee_type AS employeeType, e.work_mode AS workMode,
  e.work_location AS workLocation, e.reporting_manager_id AS reportingManagerId,
  e.probation_end_date AS probationEndDate, e.confirmation_date AS confirmationDate,
  e.contract_end_date AS contractEndDate,
  e.contract_renewal_reminder AS contractRenewalReminder,
  e.ctc, e.skill_tags AS skillTags,
  e.background_verification_status AS backgroundVerificationStatus,
  e.last_working_date AS lastWorkingDate, e.exit_reason AS exitReason,
  e.exit_type AS exitType, e.settlement_status AS settlementStatus,
  e.rehire_eligible AS rehireEligible, e.exit_notes AS exitNotes,
  u.id AS uId, u.name AS uName, u.email AS uEmail,
  COALESCE(e.photo_url, u.avatar_url) AS uAvatarUrl
`.trim();

function mapEmployee(row: RowDataPacket) {
  return {
    id: row["id"], uuid: row["uuid"], userId: row["userId"],
    employeeCode: row["employeeCode"], department: row["department"],
    designation: row["designation"], joiningDate: row["joiningDate"],
    shiftStart: row["shiftStart"], shiftEnd: row["shiftEnd"],
    baseSalary: row["baseSalary"],
    bankName: row["bankName"], bankAccount: row["bankAccount"],
    bankIfsc: row["bankIfsc"], panNumber: row["panNumber"],
    emergencyContact: row["emergencyContact"], emergencyPhone: row["emergencyPhone"],
    status: row["status"], createdAt: row["createdAt"], updatedAt: row["updatedAt"],
    // New personal fields
    personalEmail: row["personalEmail"], phone: row["phone"],
    dateOfBirth: row["dateOfBirth"], gender: row["gender"], photoUrl: row["photoUrl"],
    educationQualification: row["educationQualification"], schoolCollege: row["schoolCollege"],
    maritalStatus: row["maritalStatus"], nationality: row["nationality"],
    bloodGroup: row["bloodGroup"],
    // New job fields
    employeeType: row["employeeType"], workMode: row["workMode"],
    workLocation: row["workLocation"], reportingManagerId: row["reportingManagerId"],
    probationEndDate: row["probationEndDate"], confirmationDate: row["confirmationDate"],
    contractEndDate: row["contractEndDate"], contractRenewalReminder: row["contractRenewalReminder"],
    ctc: row["ctc"], skillTags: row["skillTags"] ? (() => { try { return JSON.parse(row["skillTags"]); } catch { return []; } })() : [],
    // Exit fields
    backgroundVerificationStatus: row["backgroundVerificationStatus"],
    lastWorkingDate: row["lastWorkingDate"], exitReason: row["exitReason"],
    exitType: row["exitType"], settlementStatus: row["settlementStatus"],
    rehireEligible: row["rehireEligible"], exitNotes: row["exitNotes"],
    user: { id: row["uId"], name: row["uName"], email: row["uEmail"], avatarUrl: row["uAvatarUrl"] },
  };
}

// ─── Section A: List + Stats + Detail ─────────────────────────────────────────

export async function listEmployees(req: Request, res: Response): Promise<void> {
  try {
    const { status, department, search, employeeType, workMode } = req.query as Record<string, string | undefined>;
    let sql = `SELECT ${EMP_SEL} FROM employees e JOIN users u ON e.user_id = u.id WHERE 1=1`;
    const p: unknown[] = [];
    if (status)       { sql += " AND e.status = ?";        p.push(status); }
    if (department)   { sql += " AND e.department = ?";    p.push(department); }
    if (employeeType) { sql += " AND e.employee_type = ?"; p.push(employeeType); }
    if (workMode)     { sql += " AND e.work_mode = ?";     p.push(workMode); }
    if (search) {
      sql += " AND (u.name LIKE ? OR u.email LIKE ? OR e.designation LIKE ? OR e.employee_code LIKE ?)";
      p.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += " ORDER BY u.name ASC";
    const rows = await q<RowDataPacket>(sql, p as string[]);
    res.json({ success: true, message: "OK", data: rows.map(mapEmployee) });
  } catch (err) {
    console.error("[employees/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getEmployeeStats(req: Request, res: Response): Promise<void> {
  try {
    const [statsRows, missingMandatoryRows, birthdayRows, recentJoinRows, contractListRows] = await Promise.all([
      q<RowDataPacket>(`
        SELECT
          COUNT(*)                                                                        AS total,
          SUM(status = 'ACTIVE')                                                          AS active,
          SUM(status = 'PROBATION')                                                       AS onProbation,
          SUM(status = 'NOTICE_PERIOD')                                                   AS onNoticePeriod,
          SUM(
            contract_end_date IS NOT NULL
            AND contract_end_date >= CURDATE()
            AND contract_end_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
          )                                                                               AS contractsExpiringSoon
        FROM employees
      `),
      q<RowDataPacket>(`
        SELECT COUNT(*) AS cnt
        FROM employees e
        WHERE e.status IN ('ACTIVE','PROBATION')
        AND (
          SELECT COUNT(*) FROM employee_documents d
          WHERE d.employee_id = e.id AND d.is_mandatory = 1
        ) < ${MANDATORY_DOCUMENTS.length}
      `),
      q<RowDataPacket>(`
        SELECT u.name, e.photo_url AS photoUrl, e.date_of_birth AS dateOfBirth
        FROM employees e JOIN users u ON e.user_id = u.id
        WHERE e.date_of_birth IS NOT NULL
          AND MONTH(e.date_of_birth) = MONTH(CURDATE())
          AND e.status IN ('ACTIVE','PROBATION')
        ORDER BY DAY(e.date_of_birth) ASC
      `),
      q<RowDataPacket>(`
        SELECT u.name, e.photo_url AS photoUrl, e.designation, e.joining_date AS joiningDate
        FROM employees e JOIN users u ON e.user_id = u.id
        WHERE e.status IN ('ACTIVE','PROBATION')
        ORDER BY e.joining_date DESC
        LIMIT 5
      `),
      q<RowDataPacket>(`
        SELECT u.name, e.photo_url AS photoUrl, e.contract_end_date AS contractEndDate
        FROM employees e JOIN users u ON e.user_id = u.id
        WHERE e.contract_end_date IS NOT NULL
          AND e.contract_end_date >= CURDATE()
          AND e.contract_end_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
          AND e.status IN ('ACTIVE','PROBATION','NOTICE_PERIOD')
        ORDER BY e.contract_end_date ASC
      `),
    ]);
    const s = statsRows[0];
    res.json({
      success: true, message: "OK",
      data: {
        total:                  Number(s?.["total"]                         ?? 0),
        active:                 Number(s?.["active"]                        ?? 0),
        onProbation:            Number(s?.["onProbation"]                   ?? 0),
        onNoticePeriod:         Number(s?.["onNoticePeriod"]                ?? 0),
        contractsExpiringSoon:  Number(s?.["contractsExpiringSoon"]         ?? 0),
        missingMandatoryDocs:   Number(missingMandatoryRows[0]?.["cnt"]     ?? 0),
        birthdaysThisMonth:     birthdayRows.map(r => ({
          name: r["name"], photoUrl: r["photoUrl"] ?? null, dateOfBirth: r["dateOfBirth"],
        })),
        recentJoins:            recentJoinRows.map(r => ({
          name: r["name"], photoUrl: r["photoUrl"] ?? null,
          designation: r["designation"] ?? null, joiningDate: r["joiningDate"],
        })),
        contractsExpiringSoonList: contractListRows.map(r => ({
          name: r["name"], photoUrl: r["photoUrl"] ?? null, contractEndDate: r["contractEndDate"],
        })),
      },
    });
  } catch (err) {
    console.error("[employees/stats]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getEmployee(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>(
      `SELECT ${EMP_SEL}, u.role AS uRole, u.status AS uStatus
       FROM employees e JOIN users u ON e.user_id = u.id WHERE e.uuid = ?`, [uuid]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const row = rows[0];

    if (req.user!.role === "EMPLOYEE" && req.user!.id !== Number(row["userId"])) {
      res.status(403).json({ success: false, message: "Access denied" }); return;
    }

    const empId = Number(row["id"]);
    const year  = new Date().getFullYear();

    // Parallel fetches for all sub-tables (explicit aliases → camelCase)
    const [balRows, docRows, addrRows, bankDetailRows, emergencyRows, salaryRows, assetRows, agreementRows] = await Promise.all([
      q<RowDataPacket>("SELECT * FROM leave_balances WHERE employee_id = ? AND year = ?", [empId, year]),
      q<RowDataPacket>(`
        SELECT id, doc_type AS docType, doc_category AS docCategory, name,
               file_path AS filePath, is_mandatory AS isMandatory,
               verification_status AS verificationStatus, verified_at AS verifiedAt,
               expiry_date AS expiryDate, uploaded_by AS uploadedBy, created_at AS createdAt
        FROM employee_documents WHERE employee_id = ? ORDER BY created_at DESC`, [empId]),
      q<RowDataPacket>(`
        SELECT id, employee_id AS employeeId, flat_door AS flatDoor, street, city,
               pin_code AS pinCode, state, country
        FROM employee_addresses WHERE employee_id = ?`, [empId]),
      q<RowDataPacket>("SELECT * FROM employee_bank_details WHERE employee_id = ?", [empId]),
      q<RowDataPacket>(`
        SELECT id, contact_order AS contactOrder, name, relationship, phone, email
        FROM employee_emergency_contacts WHERE employee_id = ? ORDER BY contact_order`, [empId]),
      q<RowDataPacket>(`
        SELECT id, component_type AS componentType, name, amount,
               is_mandatory AS isMandatory, is_custom AS isCustom, sort_order AS sortOrder
        FROM employee_salary_components WHERE employee_id = ? ORDER BY component_type, sort_order`, [empId]),
      q<RowDataPacket>(`
        SELECT id, uuid, asset_name AS assetName, asset_type AS assetType,
               assigned_date AS assignedDate, return_date AS returnDate,
               serial_number AS serialNumber, notes, created_at AS createdAt
        FROM employee_assets WHERE employee_id = ? ORDER BY created_at DESC`, [empId]),
      q<RowDataPacket>(`
        SELECT id, uuid, agreement_type AS agreementType, name,
               file_path AS filePath, version, signed_at AS signedAt,
               notes, created_at AS createdAt
        FROM employee_agreements WHERE employee_id = ? ORDER BY created_at DESC`, [empId]),
    ]);

    // Seed leave balance if missing
    let lbRaw = balRows[0] ?? null;
    if (!lbRaw) {
      await run("INSERT INTO leave_balances (employee_id, year, casual_total, sick_total, paid_total) VALUES (?, ?, 12, 6, 15)", [empId, year]);
      const fresh = await q<RowDataPacket>("SELECT * FROM leave_balances WHERE employee_id = ? AND year = ?", [empId, year]);
      lbRaw = fresh[0] ?? null;
    }
    const leaveBalance = lbRaw ? {
      id:          Number(lbRaw["id"]),
      employeeId:  Number(lbRaw["employee_id"]),
      year:        Number(lbRaw["year"]),
      casualTotal: Number(lbRaw["casual_total"]  ?? 0),
      casualUsed:  Number(lbRaw["casual_used"]   ?? 0),
      sickTotal:   Number(lbRaw["sick_total"]    ?? 0),
      sickUsed:    Number(lbRaw["sick_used"]     ?? 0),
      paidTotal:   Number(lbRaw["paid_total"]    ?? 0),
      paidUsed:    Number(lbRaw["paid_used"]     ?? 0),
      compOff:     Number(lbRaw["comp_off"]      ?? 0),
    } : null;

    const canSeeSensitive = SENSITIVE_ROLES.includes(req.user!.role);
    const isOwnEmployee   = req.user!.role === "EMPLOYEE" && req.user!.id === Number(row["userId"]);
    const canSeeBank      = canSeeSensitive || isOwnEmployee;
    const emp             = mapEmployee(row);

    // Decrypt bank details from employee_bank_details (new table)
    const rawBank = bankDetailRows[0] ?? null;
    const bankDetails = rawBank
      ? {
          id:                 rawBank["id"],
          bankName:           rawBank["bank_name"],
          accountNumber:      canSeeBank ? safeDecrypt(rawBank["account_number"]) : null,
          accountHolderName:  rawBank["account_holder_name"],
          ifscCode:           rawBank["ifsc_code"],
          panNumber:          canSeeBank ? safeDecrypt(rawBank["pan_number"])     : null,
          aadhaarNumber:      canSeeBank ? safeDecrypt(rawBank["aadhaar_number"]) : null,
          uanNumber:          rawBank["uan_number"],
          esicNumber:         rawBank["esic_number"],
        }
      : null;

    // Salary component totals
    const salaryTotals = calculateSalaryTotals(
      salaryRows.map(c => ({ componentType: String(c["component_type"]), amount: Number(c["amount"]) }))
    );

    res.json({
      success: true, message: "OK",
      data: {
        ...emp,
        user:         { ...emp.user, role: row["uRole"], status: row["uStatus"] },
        // Legacy inline bank (kept for backward compat)
        bankAccount:  canSeeBank ? safeDecrypt(row["bankAccount"]) : null,
        panNumber:    canSeeBank ? safeDecrypt(row["panNumber"])   : null,
        // Sub-records (all rows already mapped to camelCase by SELECT aliases)
        address:           addrRows[0] ?? null,
        bankDetails,
        emergencyContacts: emergencyRows,
        salaryComponents:  salaryRows,
        salaryTotals,
        assets:            assetRows,
        documents:         docRows,
        agreements:        agreementRows,
        leaveBalance,
      },
    });
  } catch (err) {
    console.error("[employees/get]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section B: Extended createEmployee ───────────────────────────────────────

export async function createEmployee(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const {
      name, email, password,
      department, designation, joiningDate, shiftStart, shiftEnd, baseSalary,
      bankName, bankAccount, bankIfsc, panNumber, emergencyContact, emergencyPhone,
      // New personal
      personalEmail, phone, dateOfBirth, gender, photoUrl,
      educationQualification, schoolCollege, maritalStatus, nationality, bloodGroup,
      // New job
      employeeType, workMode, workLocation, reportingManagerId,
      probationEndDate, confirmationDate, contractEndDate, ctc, skillTags,
      // Sub-records
      address, bankDetails, emergencyContacts,
    } = body;

    if (!name || !email || !password || !joiningDate || baseSalary == null || baseSalary === "") {
      res.status(400).json({ success: false, message: "name, email, password, joiningDate and baseSalary are required" }); return;
    }
    const exists = await q<RowDataPacket>("SELECT id FROM users WHERE email = ?", [String(email)]);
    if (exists[0]) { res.status(409).json({ success: false, message: "A user with this email already exists" }); return; }
    if (String(password).length < 8) { res.status(400).json({ success: false, message: "Password must be at least 8 characters" }); return; }

    const passwordHash    = await bcrypt.hash(String(password), 12);
    const employeeCode    = await nextEmployeeCode();
    const encBankAccount  = bankAccount ? encrypt(String(bankAccount)) : null;
    const encPanNumber    = panNumber   ? encrypt(String(panNumber))   : null;

    const conn = await pool.getConnection();
    let empId: number;
    try {
      await conn.beginTransaction();

      // 1. Create user
      const [uRes] = await conn.execute(
        "INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, 'EMPLOYEE', 'ACTIVE')",
        [String(name), String(email), passwordHash]
      ) as [RowDataPacket, unknown];
      const userId = (uRes as unknown as { insertId: number }).insertId;

      // 2. Create employee (extended)
      const [eRes] = await conn.execute(
        `INSERT INTO employees (
          user_id, employee_code, department, designation, joining_date,
          shift_start, shift_end, base_salary,
          bank_name, bank_account, bank_ifsc, pan_number,
          emergency_contact, emergency_phone,
          personal_email, phone, date_of_birth, gender, photo_url,
          education_qualification, school_college, marital_status, nationality, blood_group,
          employee_type, work_mode, work_location, reporting_manager_id,
          probation_end_date, confirmation_date, contract_end_date,
          contract_renewal_reminder, ctc, skill_tags
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          30, ?, ?
        )`,
        [
          userId, employeeCode,
          department  ? String(department)  : null,
          designation ? String(designation) : null,
          String(joiningDate),
          shiftStart  ? String(shiftStart)  : "09:00:00",
          shiftEnd    ? String(shiftEnd)    : "18:00:00",
          Number(baseSalary),
          bankName    ? String(bankName)    : null,
          encBankAccount, bankIfsc ? String(bankIfsc) : null, encPanNumber,
          emergencyContact ? String(emergencyContact) : null,
          emergencyPhone   ? String(emergencyPhone)   : null,
          personalEmail ? String(personalEmail) : null,
          phone         ? String(phone)         : null,
          dateOfBirth   ? String(dateOfBirth)   : null,
          gender        ? String(gender)        : null,
          photoUrl      ? String(photoUrl)      : null,
          educationQualification ? String(educationQualification) : null,
          schoolCollege          ? String(schoolCollege)          : null,
          maritalStatus          ? String(maritalStatus)          : null,
          nationality            ? String(nationality)            : null,
          bloodGroup             ? String(bloodGroup)             : null,
          employeeType  ? String(employeeType)  : "full_time",
          workMode      ? String(workMode)      : "office",
          workLocation  ? String(workLocation)  : null,
          reportingManagerId ? Number(reportingManagerId) : null,
          probationEndDate   ? String(probationEndDate)   : null,
          confirmationDate   ? String(confirmationDate)   : null,
          contractEndDate    ? String(contractEndDate)    : null,
          ctc            ? Number(ctc)            : null,
          skillTags      ? JSON.stringify(skillTags) : null,
        ]
      ) as [RowDataPacket, unknown];
      empId = (eRes as unknown as { insertId: number }).insertId;

      // 3. Leave balance
      await conn.execute(
        "INSERT INTO leave_balances (employee_id, year, casual_total, sick_total, paid_total) VALUES (?, ?, 12, 6, 15)",
        [empId, new Date().getFullYear()]
      );

      // 4. Address (optional)
      if (address && typeof address === "object") {
        const a = address as Record<string, unknown>;
        await conn.execute(
          "INSERT INTO employee_addresses (employee_id, flat_door, street, city, pin_code, state, country) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [empId, a["flatDoor"] ?? null, a["street"] ?? null, a["city"] ?? null, a["pinCode"] ?? null, a["state"] ?? null, a["country"] ?? "India"] as any[]
        );
      }

      // 5. Bank details in dedicated table (optional)
      if (bankDetails && typeof bankDetails === "object") {
        const bd = bankDetails as Record<string, unknown>;
        await conn.execute(
          `INSERT INTO employee_bank_details
            (employee_id, bank_name, account_number, account_holder_name, ifsc_code, pan_number, aadhaar_number, uan_number, esic_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            empId,
            bd["bankName"]         ? String(bd["bankName"])                   : null,
            bd["accountNumber"]    ? encrypt(String(bd["accountNumber"]))     : null,
            bd["accountHolderName"]? String(bd["accountHolderName"])          : null,
            bd["ifscCode"]         ? String(bd["ifscCode"])                   : null,
            bd["panNumber"]        ? encrypt(String(bd["panNumber"]))         : null,
            bd["aadhaarNumber"]    ? encrypt(String(bd["aadhaarNumber"]))     : null,
            bd["uanNumber"]        ? String(bd["uanNumber"])                  : null,
            bd["esicNumber"]       ? String(bd["esicNumber"])                 : null,
          ]
        );
      }

      // 6. Emergency contacts (up to 2, optional)
      if (Array.isArray(emergencyContacts)) {
        for (const ec of (emergencyContacts as unknown[]).slice(0, 2)) {
          const c = ec as Record<string, unknown>;
          if (c["name"] && c["phone"]) {
            await conn.execute(
              "INSERT INTO employee_emergency_contacts (employee_id, contact_order, name, relationship, phone, email) VALUES (?, ?, ?, ?, ?, ?)",
              [empId, c["contactOrder"] ?? 1, String(c["name"]), c["relationship"] ?? null, String(c["phone"]), c["email"] ?? null] as any[]
            );
          }
        }
      }

      // 7. Mandatory salary components
      const defaultComponents: [string, string, number, boolean, number][] = [
        ["earning",   "Basic Salary",       Number(baseSalary), true,  1],
        ["earning",   "HRA",                0,                  true,  2],
        ["earning",   "Special Allowance",  0,                  false, 3],
        ["deduction", "PF",                 0,                  true,  1],
        ["deduction", "Professional Tax",   0,                  true,  2],
      ];
      for (const [type, cName, amount, mandatory, sortOrder] of defaultComponents) {
        await conn.execute(
          "INSERT INTO employee_salary_components (employee_id, component_type, name, amount, is_mandatory, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
          [empId, type, cName, amount, mandatory ? 1 : 0, sortOrder]
        );
      }

      // 8. Initial status history entry
      await conn.execute(
        "INSERT INTO employee_status_history (employee_id, old_status, new_status, changed_by, reason) VALUES (?, NULL, 'ACTIVE', ?, 'Initial creation')",
        [empId, req.user!.id]
      );

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    const rows = await q<RowDataPacket>(
      `SELECT ${EMP_SEL} FROM employees e JOIN users u ON e.user_id = u.id WHERE e.id = ?`, [empId]
    );
    await logActivity(req.user!.id, "employee.created", "Employee", empId, undefined, { employeeCode, name, email }, req.ip);
    res.status(201).json({ success: true, message: "Employee created", data: mapEmployee(rows[0]) });
  } catch (err) {
    console.error("[employees/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Legacy general PATCH (kept for backward compat) ──────────────────────────

export async function updateEmployee(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const existRows = await q<RowDataPacket>("SELECT id, user_id AS userId FROM employees WHERE uuid = ?", [uuid]);
    if (!existRows[0]) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const { id: empId, userId } = existRows[0] as { id: number; userId: number };

    const {
      department, designation, shiftStart, shiftEnd, baseSalary,
      bankName, bankAccount, bankIfsc, panNumber,
      emergencyContact, emergencyPhone, status, name, email,
    } = req.body as Record<string, unknown>;

    const empSets: string[] = [];
    const empP: unknown[] = [];
    if (department       != null) { empSets.push("department = ?");        empP.push(String(department)); }
    if (designation      != null) { empSets.push("designation = ?");       empP.push(String(designation)); }
    if (shiftStart       != null) { empSets.push("shift_start = ?");       empP.push(String(shiftStart)); }
    if (shiftEnd         != null) { empSets.push("shift_end = ?");         empP.push(String(shiftEnd)); }
    if (baseSalary       != null) { empSets.push("base_salary = ?");       empP.push(Number(baseSalary)); }
    if (bankName         != null) { empSets.push("bank_name = ?");         empP.push(String(bankName)); }
    if (bankAccount      != null) { empSets.push("bank_account = ?");      empP.push(encrypt(String(bankAccount))); }
    if (bankIfsc         != null) { empSets.push("bank_ifsc = ?");         empP.push(String(bankIfsc)); }
    if (panNumber        != null) { empSets.push("pan_number = ?");        empP.push(encrypt(String(panNumber))); }
    if (emergencyContact != null) { empSets.push("emergency_contact = ?"); empP.push(String(emergencyContact)); }
    if (emergencyPhone   != null) { empSets.push("emergency_phone = ?");   empP.push(String(emergencyPhone)); }
    if (status           != null) { empSets.push("status = ?");            empP.push(String(status)); }

    if (empSets.length > 0) {
      empP.push(empId);
      await run(`UPDATE employees SET ${empSets.join(", ")} WHERE id = ?`, empP as string[]);
    }
    if (name != null || email != null) {
      const uSets: string[] = [];
      const uP: unknown[] = [];
      if (name  != null) { uSets.push("name = ?");  uP.push(String(name)); }
      if (email != null) { uSets.push("email = ?"); uP.push(String(email)); }
      uP.push(userId);
      await run(`UPDATE users SET ${uSets.join(", ")} WHERE id = ?`, uP as string[]);
    }
    const updRows = await q<RowDataPacket>(
      `SELECT ${EMP_SEL} FROM employees e JOIN users u ON e.user_id = u.id WHERE e.id = ?`, [empId]
    );
    await logActivity(req.user!.id, "employee.updated", "Employee", empId, existRows[0], updRows[0], req.ip);
    res.json({ success: true, message: "Employee updated", data: mapEmployee(updRows[0]) });
  } catch (err) {
    console.error("[employees/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section C: Granular PATCH routes ─────────────────────────────────────────

export async function updatePersonal(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const body = req.body as Record<string, unknown>;

    const sets: string[] = [];
    const p: unknown[] = [];
    const fields: [string, string][] = [
      ["personalEmail", "personal_email"], ["phone", "phone"],
      ["dateOfBirth", "date_of_birth"], ["gender", "gender"],
      ["photoUrl", "photo_url"], ["educationQualification", "education_qualification"],
      ["schoolCollege", "school_college"], ["maritalStatus", "marital_status"],
      ["nationality", "nationality"], ["bloodGroup", "blood_group"],
    ];
    for (const [key, col] of fields) {
      if (body[key] != null) { sets.push(`${col} = ?`); p.push(String(body[key])); }
    }
    if (sets.length > 0) { p.push(emp.id); await run(`UPDATE employees SET ${sets.join(", ")} WHERE id = ?`, p); }

    if (body["name"] != null) {
      await run("UPDATE users SET name = ? WHERE id = ?", [String(body["name"]), emp.userId]);
    }

    // Upsert address
    if (body["address"] != null && typeof body["address"] === "object") {
      const a = body["address"] as Record<string, unknown>;
      const addrRows = await q<RowDataPacket>("SELECT id FROM employee_addresses WHERE employee_id = ?", [emp.id]);
      if (addrRows[0]) {
        await run(
          "UPDATE employee_addresses SET flat_door=?, street=?, city=?, pin_code=?, state=?, country=? WHERE employee_id=?",
          [a["flatDoor"] ?? null, a["street"] ?? null, a["city"] ?? null, a["pinCode"] ?? null, a["state"] ?? null, a["country"] ?? "India", emp.id]
        );
      } else {
        await run(
          "INSERT INTO employee_addresses (employee_id, flat_door, street, city, pin_code, state, country) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [emp.id, a["flatDoor"] ?? null, a["street"] ?? null, a["city"] ?? null, a["pinCode"] ?? null, a["state"] ?? null, a["country"] ?? "India"]
        );
      }
    }

    await logActivity(req.user!.id, "employee.personal_updated", "Employee", emp.id, undefined, body, req.ip);
    res.json({ success: true, message: "Personal details updated", data: null });
  } catch (err) {
    console.error("[employees/personal]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateJob(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const body = req.body as Record<string, unknown>;

    const sets: string[] = [];
    const p: unknown[] = [];
    const strFields: [string, string][] = [
      ["department", "department"], ["designation", "designation"],
      ["workMode", "work_mode"], ["workLocation", "work_location"],
      ["probationEndDate", "probation_end_date"], ["confirmationDate", "confirmation_date"],
      ["contractEndDate", "contract_end_date"], ["shiftStart", "shift_start"],
      ["shiftEnd", "shift_end"],
      ["employeeType", "employee_type"],
    ];
    for (const [key, col] of strFields) {
      if (body[key] != null) { sets.push(`${col} = ?`); p.push(String(body[key])); }
    }
    if (body["reportingManagerId"] != null) { sets.push("reporting_manager_id = ?"); p.push(Number(body["reportingManagerId"])); }
    if (body["contractRenewalReminder"] != null) { sets.push("contract_renewal_reminder = ?"); p.push(Number(body["contractRenewalReminder"])); }
    if (body["ctc"] != null) { sets.push("ctc = ?"); p.push(Number(body["ctc"])); }
    if (body["skillTags"] != null) { sets.push("skill_tags = ?"); p.push(JSON.stringify(body["skillTags"])); }

    if (sets.length > 0) { p.push(emp.id); await run(`UPDATE employees SET ${sets.join(", ")} WHERE id = ?`, p); }
    await logActivity(req.user!.id, "employee.job_updated", "Employee", emp.id, undefined, body, req.ip);
    res.json({ success: true, message: "Job details updated", data: null });
  } catch (err) {
    console.error("[employees/job]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateBank(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const { bankName, accountNumber, accountHolderName, ifscCode, panNumber, aadhaarNumber, uanNumber, esicNumber } = req.body as Record<string, unknown>;

    const encAccount  = accountNumber  ? encrypt(String(accountNumber))  : null;
    const encPan      = panNumber      ? encrypt(String(panNumber))      : null;
    const encAadhaar  = aadhaarNumber  ? encrypt(String(aadhaarNumber))  : null;

    const existing = await q<RowDataPacket>("SELECT id FROM employee_bank_details WHERE employee_id = ?", [emp.id]);
    if (existing[0]) {
      await run(
        "UPDATE employee_bank_details SET bank_name=?, account_number=?, account_holder_name=?, ifsc_code=?, pan_number=?, aadhaar_number=?, uan_number=?, esic_number=? WHERE employee_id=?",
        [bankName ?? null, encAccount, accountHolderName ?? null, ifscCode ?? null, encPan, encAadhaar, uanNumber ?? null, esicNumber ?? null, emp.id]
      );
    } else {
      await run(
        "INSERT INTO employee_bank_details (employee_id, bank_name, account_number, account_holder_name, ifsc_code, pan_number, aadhaar_number, uan_number, esic_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [emp.id, bankName ?? null, encAccount, accountHolderName ?? null, ifscCode ?? null, encPan, encAadhaar, uanNumber ?? null, esicNumber ?? null]
      );
    }

    await logActivity(req.user!.id, "employee.bank_updated", "Employee", emp.id, undefined, { bankName, ifscCode }, req.ip);
    res.json({ success: true, message: "Bank details updated", data: null });
  } catch (err) {
    console.error("[employees/bank]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateEmergencyContacts(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const { contacts } = req.body as { contacts: Array<Record<string, unknown>> };
    if (!Array.isArray(contacts)) { res.status(400).json({ success: false, message: "contacts must be an array" }); return; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("DELETE FROM employee_emergency_contacts WHERE employee_id = ?", [emp.id]);
      for (const c of contacts.slice(0, 2)) {
        if (c["name"] && c["phone"]) {
          await conn.execute(
            "INSERT INTO employee_emergency_contacts (employee_id, contact_order, name, relationship, phone, email) VALUES (?, ?, ?, ?, ?, ?)",
            [emp.id, c["contactOrder"] ?? 1, String(c["name"]), c["relationship"] ?? null, String(c["phone"]), c["email"] ?? null] as any[]
          );
        }
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    await logActivity(req.user!.id, "employee.emergency_contacts_updated", "Employee", emp.id, undefined, { count: contacts.length }, req.ip);
    res.json({ success: true, message: "Emergency contacts updated", data: null });
  } catch (err) {
    console.error("[employees/emergency-contacts]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateSalary(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const { components } = req.body as { components: Array<Record<string, unknown>> };
    if (!Array.isArray(components)) { res.status(400).json({ success: false, message: "components must be an array" }); return; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("DELETE FROM employee_salary_components WHERE employee_id = ?", [emp.id]);
      for (const c of components) {
        await conn.execute(
          "INSERT INTO employee_salary_components (employee_id, component_type, name, amount, is_mandatory, is_custom, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [emp.id, String(c["componentType"]), String(c["name"]), Number(c["amount"]), c["isMandatory"] ? 1 : 0, c["isCustom"] ? 1 : 0, Number(c["sortOrder"] ?? 0)]
        );
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    const totals = calculateSalaryTotals(
      components.map(c => ({ componentType: String(c["componentType"]), amount: Number(c["amount"]) }))
    );
    await logActivity(req.user!.id, "employee.salary_updated", "Employee", emp.id, undefined, totals, req.ip);
    res.json({ success: true, message: "Salary components updated", data: { components, ...totals } });
  } catch (err) {
    console.error("[employees/salary]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const { status, reason, lastWorkingDate, exitReason, exitType, settlementStatus, rehireEligible, exitNotes } = req.body as Record<string, unknown>;
    if (!status) { res.status(400).json({ success: false, message: "status is required" }); return; }

    const currentRows = await q<RowDataPacket>("SELECT status FROM employees WHERE id = ?", [emp.id]);
    const oldStatus   = currentRows[0]?.["status"] ?? null;

    const sets: string[] = ["status = ?"];
    const p: unknown[]   = [String(status)];
    if (lastWorkingDate  != null) { sets.push("last_working_date = ?");  p.push(String(lastWorkingDate)); }
    if (exitReason       != null) { sets.push("exit_reason = ?");        p.push(String(exitReason)); }
    if (exitType         != null) { sets.push("exit_type = ?");          p.push(String(exitType)); }
    if (settlementStatus != null) { sets.push("settlement_status = ?");  p.push(String(settlementStatus)); }
    if (rehireEligible   != null) { sets.push("rehire_eligible = ?");    p.push(rehireEligible ? 1 : 0); }
    if (exitNotes        != null) { sets.push("exit_notes = ?");         p.push(String(exitNotes)); }
    p.push(emp.id);
    await run(`UPDATE employees SET ${sets.join(", ")} WHERE id = ?`, p);

    await run(
      "INSERT INTO employee_status_history (employee_id, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)",
      [emp.id, oldStatus, String(status), req.user!.id, reason ?? null]
    );

    await logActivity(req.user!.id, "employee.status_changed", "Employee", emp.id, { status: oldStatus }, { status: String(status) }, req.ip);
    res.json({ success: true, message: "Status updated", data: null });
  } catch (err) {
    console.error("[employees/status]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section D: Asset management ──────────────────────────────────────────────

export async function createAsset(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const { assetName, assetType, assignedDate, serialNumber, notes } = req.body as Record<string, unknown>;
    if (!assetName) { res.status(400).json({ success: false, message: "assetName is required" }); return; }

    const result = await run(
      "INSERT INTO employee_assets (employee_id, asset_name, asset_type, assigned_date, serial_number, notes) VALUES (?, ?, ?, ?, ?, ?)",
      [emp.id, String(assetName), assetType ?? null, assignedDate ?? null, serialNumber ?? null, notes ?? null]
    );
    const rows = await q<RowDataPacket>("SELECT * FROM employee_assets WHERE id = ?", [result.insertId]);
    await logActivity(req.user!.id, "employee.asset_assigned", "EmployeeAsset", result.insertId, undefined, { assetName }, req.ip);
    res.status(201).json({ success: true, message: "Asset assigned", data: rows[0] });
  } catch (err) {
    console.error("[employees/assets/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getAssets(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    if (req.user!.role === "EMPLOYEE" && req.user!.id !== emp.userId) {
      res.status(403).json({ success: false, message: "Access denied" }); return;
    }
    const rows = await q<RowDataPacket>("SELECT * FROM employee_assets WHERE employee_id = ? ORDER BY created_at DESC", [emp.id]);
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[employees/assets/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateAsset(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>("SELECT id FROM employee_assets WHERE uuid = ?", [req.params["assetUuid"] ?? ""]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Asset not found" }); return; }
    const { returnDate, notes, assetType, serialNumber } = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const p: unknown[] = [];
    if (returnDate   != null) { sets.push("return_date = ?");    p.push(String(returnDate)); }
    if (notes        != null) { sets.push("notes = ?");          p.push(String(notes)); }
    if (assetType    != null) { sets.push("asset_type = ?");     p.push(String(assetType)); }
    if (serialNumber != null) { sets.push("serial_number = ?");  p.push(String(serialNumber)); }
    if (sets.length > 0) { p.push(Number(rows[0]["id"])); await run(`UPDATE employee_assets SET ${sets.join(", ")} WHERE id = ?`, p); }
    res.json({ success: true, message: "Asset updated", data: null });
  } catch (err) {
    console.error("[employees/assets/update]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteAsset(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>("SELECT id FROM employee_assets WHERE uuid = ?", [req.params["assetUuid"] ?? ""]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Asset not found" }); return; }
    await run("DELETE FROM employee_assets WHERE id = ?", [Number(rows[0]["id"])]);
    res.json({ success: true, message: "Asset deleted", data: null });
  } catch (err) {
    console.error("[employees/assets/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section E: Agreement management ─────────────────────────────────────────

export async function createAgreement(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }
    const body = req.body as Record<string, string>;
    if (!body["agreementType"] || !body["name"]) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ success: false, message: "agreementType and name are required" }); return;
    }
    const relativePath = `uploads/employee-agreements/${req.file.filename}`;
    const result = await run(
      "INSERT INTO employee_agreements (employee_id, agreement_type, name, file_path, version, signed_at, uploaded_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [emp.id, body["agreementType"], body["name"], relativePath, body["version"] ?? "v1", body["signedAt"] ?? null, req.user!.id, body["notes"] ?? null]
    );
    await logActivity(req.user!.id, "employee.agreement_uploaded", "EmployeeAgreement", result.insertId, undefined, { name: body["name"] }, req.ip);
    res.status(201).json({ success: true, message: "Agreement uploaded", data: { id: result.insertId, name: body["name"], filePath: relativePath } });
  } catch (err) {
    console.error("[employees/agreements/create]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getAgreements(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const rows = await q<RowDataPacket>("SELECT * FROM employee_agreements WHERE employee_id = ? ORDER BY created_at DESC", [emp.id]);
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[employees/agreements/list]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteAgreement(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>("SELECT id, file_path AS filePath FROM employee_agreements WHERE uuid = ?", [req.params["agreementUuid"] ?? ""]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Agreement not found" }); return; }
    try { fs.unlinkSync(path.join(process.cwd(), String(rows[0]["filePath"]))); } catch { /* file gone */ }
    await run("DELETE FROM employee_agreements WHERE id = ?", [Number(rows[0]["id"])]);
    res.json({ success: true, message: "Agreement deleted", data: null });
  } catch (err) {
    console.error("[employees/agreements/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Section F: Status history ────────────────────────────────────────────────

export async function getStatusHistory(req: Request, res: Response): Promise<void> {
  try {
    const emp = await resolveEmployee(String(req.params["uuid"] ?? ""));
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const rows = await q<RowDataPacket>(
      `SELECT sh.id, sh.old_status AS oldStatus, sh.new_status AS newStatus,
              sh.reason, sh.changed_at AS changedAt,
              u.id AS changedById, u.name AS changedByName
       FROM employee_status_history sh
       LEFT JOIN users u ON sh.changed_by = u.id
       WHERE sh.employee_id = ?
       ORDER BY sh.changed_at DESC`,
      [emp.id]
    );
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[employees/status-history]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ─── Existing document + leave + PDF routes (unchanged) ───────────────────────

export async function uploadDocument(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id FROM employees WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_DOC_TYPES.includes(ext)) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ success: false, message: `File type not allowed. Allowed: ${ALLOWED_DOC_TYPES.join(", ")}` }); return;
    }
    const body        = req.body as Record<string, string>;
    const docName     = body["name"]        || req.file.originalname;
    const docType     = body["docType"]     || "OTHER";
    const docCategory = body["docCategory"] || "other";
    const isMandatory = (body["isMandatory"] === "true" || body["isMandatory"] === "1") ? 1 : 0;
    const expiryDate  = body["expiryDate"]  || null;
    const relativePath = `uploads/employee-docs/${req.file.filename}`;
    const result = await run(
      "INSERT INTO employee_documents (employee_id, doc_type, name, file_path, uploaded_by, doc_category, is_mandatory, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [rows[0]["id"], docType, docName, relativePath, req.user!.id, docCategory, isMandatory, expiryDate]
    );
    res.status(201).json({
      success: true, message: "Document uploaded",
      data: { id: result.insertId, name: docName, filePath: relativePath, docType, docCategory, isMandatory: !!isMandatory },
    });
  } catch (err) {
    console.error("[employees/documents/upload]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteDocument(req: Request, res: Response): Promise<void> {
  try {
    const docId = parseInt(String(req.params["docId"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id, file_path AS filePath FROM employee_documents WHERE id = ?", [docId]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Document not found" }); return; }
    try { fs.unlinkSync(path.join(process.cwd(), String(rows[0]["filePath"]))); } catch { /* gone */ }
    await run("DELETE FROM employee_documents WHERE id = ?", [docId]);
    await logActivity(req.user!.id, "employee.document_deleted", "EmployeeDocument", docId, undefined, undefined, req.ip);
    res.json({ success: true, message: "Document deleted", data: null });
  } catch (err) {
    console.error("[employees/documents/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function uploadPhoto(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const emp = await resolveEmployee(uuid);
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    if (!req.file) { res.status(400).json({ success: false, message: "No file uploaded" }); return; }
    const relativePath = `uploads/employee-photos/${req.file.filename}`;
    await run("UPDATE employees SET photo_url = ? WHERE id = ?", [relativePath, emp.id]);
    await logActivity(req.user!.id, "employee.photo_uploaded", "Employee", emp.id, undefined, undefined, req.ip);
    res.json({ success: true, message: "Photo uploaded", data: { photoUrl: relativePath } });
  } catch (err) {
    console.error("[employees/photo]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function deleteEmployee(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const emp = await resolveEmployee(uuid);
    if (!emp) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    await run("DELETE FROM employees WHERE id = ?", [emp.id]);
    await run("DELETE FROM users WHERE id = ?", [emp.userId]);
    await logActivity(req.user!.id, "employee.deleted", "Employee", emp.id, undefined, undefined, req.ip);
    res.json({ success: true, message: "Employee deleted", data: null });
  } catch (err) {
    console.error("[employees/delete]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function verifyDocument(req: Request, res: Response): Promise<void> {
  try {
    const docId = parseInt(String(req.params["docId"] ?? "0"), 10);
    const rows = await q<RowDataPacket>("SELECT id FROM employee_documents WHERE id = ?", [docId]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Document not found" }); return; }

    const { verificationStatus, verificationNotes } = req.body as Record<string, string>;
    if (!verificationStatus || !["verified", "rejected"].includes(verificationStatus)) {
      res.status(400).json({ success: false, message: "verificationStatus must be 'verified' or 'rejected'" }); return;
    }

    await run(
      "UPDATE employee_documents SET verification_status = ?, verified_by = ?, verified_at = NOW(), verification_notes = ? WHERE id = ?",
      [verificationStatus, req.user!.id, verificationNotes ?? null, docId]
    );
    await logActivity(req.user!.id, "employee.document_verified", "EmployeeDocument", docId, undefined, { verificationStatus, verificationNotes }, req.ip);
    res.json({ success: true, message: `Document ${verificationStatus}`, data: null });
  } catch (err) {
    console.error("[employees/documents/verify]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getDocumentChecklist(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const empRows = await q<RowDataPacket>("SELECT id, user_id AS userId FROM employees WHERE uuid = ?", [uuid]);
    if (!empRows[0]) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const emp = empRows[0];

    if (req.user!.role === "EMPLOYEE" && req.user!.id !== Number(emp["userId"])) {
      res.status(403).json({ success: false, message: "Access denied" }); return;
    }

    const docs = await q<RowDataPacket>(
      `SELECT id, doc_type AS docType, doc_category AS docCategory, name, file_path AS filePath,
              is_mandatory AS isMandatory, verification_status AS verificationStatus,
              verified_at AS verifiedAt, expiry_date AS expiryDate, created_at AS uploadedAt
       FROM employee_documents WHERE employee_id = ? ORDER BY created_at DESC`,
      [Number(emp["id"])]
    );

    const mandatoryUploaded = docs.filter(d => d["isMandatory"]);
    const identityDocs  = mandatoryUploaded.filter(d => d["docCategory"] === "identity");
    const bankingDocs   = mandatoryUploaded.filter(d => d["docCategory"] === "banking");
    const educationDocs = mandatoryUploaded.filter(d => d["docCategory"] === "education");

    let identitySlot = 0;
    const checklist = MANDATORY_DOCUMENTS.map(config => {
      let matchedDoc: RowDataPacket | null = null;
      if (config.category === "identity") {
        matchedDoc = identityDocs[identitySlot] ?? null;
        identitySlot++;
      } else if (config.category === "banking") {
        matchedDoc = bankingDocs[0] ?? null;
      } else if (config.category === "education") {
        matchedDoc = educationDocs[0] ?? null;
      }
      return {
        name:               config.name,
        category:           config.category,
        isMandatory:        config.isMandatory,
        uploaded:           matchedDoc !== null,
        verificationStatus: matchedDoc ? String(matchedDoc["verificationStatus"]) : null,
        document:           matchedDoc ?? null,
      };
    });

    const optionalDocuments = docs.filter(d => !d["isMandatory"]);

    res.json({ success: true, message: "OK", data: { checklist, optionalDocuments } });
  } catch (err) {
    console.error("[employees/documents/checklist]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getLeaveBalance(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;
    const rows = await q<RowDataPacket>("SELECT id, user_id AS userId FROM employees WHERE uuid = ?", [uuid]);
    if (!rows[0]) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    if (req.user!.role === "EMPLOYEE" && req.user!.id !== Number(rows[0]["userId"])) {
      res.status(403).json({ success: false, message: "Access denied" }); return;
    }
    const year = new Date().getFullYear();
    const balRows = await q<RowDataPacket>("SELECT * FROM leave_balances WHERE employee_id = ? AND year = ?", [rows[0]["id"], year]);
    let balance = balRows[0] ?? null;
    if (!balance) {
      await run("INSERT INTO leave_balances (employee_id, year, casual_total, sick_total, paid_total) VALUES (?, ?, 12, 6, 15)", [rows[0]["id"], year]);
      const fresh = await q<RowDataPacket>("SELECT * FROM leave_balances WHERE employee_id = ? AND year = ?", [rows[0]["id"], year]);
      balance = fresh[0] ?? null;
    }
    res.json({ success: true, message: "OK", data: balance });
  } catch (err) {
    console.error("[employees/leave-balance]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function exportEmployeePdf(req: Request, res: Response): Promise<void> {
  try {
    const { uuid } = req.params as Record<string, string>;

    const rows = await q<RowDataPacket>(
      `SELECT ${EMP_SEL}, u.role AS uRole, u.status AS uStatus, u.last_login_at AS uLastLoginAt
       FROM employees e JOIN users u ON e.user_id = u.id WHERE e.uuid = ?`,
      [uuid]
    );
    if (!rows[0]) { res.status(404).json({ success: false, message: "Employee not found" }); return; }
    const row = rows[0];
    const year = new Date().getFullYear();
    const canSeeSensitive = SENSITIVE_ROLES.includes(req.user!.role);

    const [balRows, docRows] = await Promise.all([
      q<RowDataPacket>("SELECT * FROM leave_balances WHERE employee_id = ? AND year = ?", [row["id"], year]),
      q<RowDataPacket>("SELECT doc_type AS docType, name, created_at AS uploadedAt FROM employee_documents WHERE employee_id = ? ORDER BY created_at DESC", [row["id"]]),
    ]);
    const lb = balRows[0] ?? null;

    const bankAccount = canSeeSensitive ? (safeDecrypt(row["bankAccount"]) ?? "—") : "RESTRICTED";
    const panNumber   = canSeeSensitive ? (safeDecrypt(row["panNumber"])   ?? "—") : "RESTRICTED";

    const fmtDate = (d: unknown): string =>
      d ? new Date(d as string).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

    const employeeCode = String(row["employeeCode"] || "UNKNOWN");
    const genDate = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="employee-${employeeCode}-profile.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
    doc.pipe(res);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const M  = 40;
    const CW = PW - M * 2;

    const DARK  = "#1E293B"; const BODY  = "#374151"; const LABEL = "#111827";
    const ALT   = "#F8FAFC"; const GRAY  = "#6B7280"; const RED   = "#DC2626";
    const RULE  = "#CBD5E1"; const THEAD = "#E2E8F0";

    const sectionHeader = (title: string, y: number, confidential = false): number => {
      doc.save().rect(M, y, CW, 22).fill(DARK).restore();
      const text = confidential ? `CONFIDENTIAL  ${title}` : title;
      doc.font("Helvetica-Bold").fillColor("white").fontSize(10).text(text, M + 8, y + 6, { width: CW - 16, lineBreak: false });
      return y + 28;
    };
    const field = (label: string, value: string, x: number, y: number, w: number): number => {
      doc.font("Helvetica-Bold").fillColor(LABEL).fontSize(10).text(`${label}:`, x, y, { width: 115, lineBreak: false });
      doc.font("Helvetica").fillColor(BODY).fontSize(10).text(String(value || "—"), x + 120, y, { width: w - 120, lineBreak: false });
      return y + 16;
    };
    const tblHeader = (cols: string[], y: number, ws: number[]): number => {
      doc.save().rect(M, y, CW, 18).fill(THEAD).restore();
      let x = M;
      cols.forEach((c, i) => { doc.font("Helvetica-Bold").fillColor(LABEL).fontSize(9).text(c, x + 4, y + 4, { width: (ws[i] ?? 80) - 8, lineBreak: false }); x += ws[i] ?? 80; });
      return y + 18;
    };
    const tblRow = (cells: string[], y: number, ws: number[], alt: boolean, bold = false): number => {
      if (alt) doc.save().rect(M, y, CW, 18).fill(ALT).restore();
      let x = M;
      cells.forEach((c, i) => { doc.font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(BODY).fontSize(9).text(String(c ?? "—"), x + 4, y + 4, { width: (ws[i] ?? 80) - 8, lineBreak: false }); x += ws[i] ?? 80; });
      return y + 18;
    };
    const check = (needed: number, y: number): number => {
      if (y + needed > PH - M - 35) { doc.addPage(); return M + 10; } return y;
    };

    let y = M;
    doc.font("Helvetica-Bold").fillColor(DARK).fontSize(18).text("YouTooPreneur Agency OS", M, y, { width: CW * 0.65, lineBreak: false });
    doc.font("Helvetica-Bold").fillColor(GRAY).fontSize(14).text("EMPLOYEE PROFILE", M, y + 3, { width: CW, align: "right", lineBreak: false });
    y += 30;
    doc.moveTo(M, y).lineTo(PW - M, y).strokeColor(RULE).lineWidth(1).stroke(); y += 8;
    doc.font("Helvetica").fillColor(GRAY).fontSize(9).text(`Generated on: ${genDate}`, M, y, { width: CW, align: "right", lineBreak: false }); y += 13;
    doc.font("Helvetica").fillColor(RED).fontSize(9).text("Confidential — Internal Use Only", M, y, { width: CW, align: "right", lineBreak: false }); y += 22;

    y = check(130, y); y = sectionHeader("Employee Overview", y);
    const hw = CW / 2 - 8; const c1 = M; const c2 = M + CW / 2 + 8; const sY = y;
    let lY = sY;
    lY = field("Employee ID",  employeeCode,                       c1, lY, hw);
    lY = field("Full Name",    String(row["uName"]        || "—"), c1, lY, hw);
    lY = field("Designation",  String(row["designation"]  || "—"), c1, lY, hw);
    lY = field("Department",   String(row["department"]   || "—"), c1, lY, hw);
    lY = field("Status",       String(row["status"]       || "—"), c1, lY, hw);
    let rY = sY;
    rY = field("Joining Date",    fmtDate(row["joiningDate"]),                                c2, rY, hw);
    rY = field("Shift",           `${row["shiftStart"] ?? "—"} — ${row["shiftEnd"] ?? "—"}`, c2, rY, hw);
    rY = field("Work Mode",       String(row["workMode"]       || "—"),                       c2, rY, hw);
    rY = field("Employment Type", String(row["employeeType"]   || "—"),                       c2, rY, hw);
    rY = field("Reporting Mgr",   "—",                                                        c2, rY, hw);
    y = Math.max(lY, rY) + 14;

    y = check(70, y); y = sectionHeader("Contact Details", y);
    y = field("Work Email",    String(row["uEmail"]           || "—"), M, y, CW);
    y = field("Personal Email",String(row["personalEmail"]    || "—"), M, y, CW);
    y = field("Phone",         String(row["phone"]            || "—"), M, y, CW);
    y = field("Emergency",     String(row["emergencyContact"] || "—"), M, y, CW);
    y = field("Emrg. Phone",   String(row["emergencyPhone"]   || "—"), M, y, CW);
    y += 14;

    if (canSeeSensitive) {
      y = check(60, y); y = sectionHeader("Salary Structure (Confidential)", y, true);
      y = field("Base Salary", `INR ${Number(row["baseSalary"] ?? 0).toLocaleString("en-IN")}`, M, y, CW);
      if (row["ctc"]) y = field("CTC", `INR ${Number(row["ctc"]).toLocaleString("en-IN")}`, M, y, CW);
      y += 14;
    }

    if (canSeeSensitive) {
      y = check(90, y); y = sectionHeader("Bank & Tax Details (Confidential)", y, true);
      y = field("Bank Name",   String(row["bankName"]  || "—"), M, y, CW);
      y = field("Account No.", bankAccount,                     M, y, CW);
      y = field("IFSC Code",   String(row["bankIfsc"]  || "—"), M, y, CW);
      y = field("PAN Number",  panNumber,                       M, y, CW);
      y += 14;
    }

    y = check(70, y); y = sectionHeader("Emergency Contacts", y);
    if (row["emergencyContact"] || row["emergencyPhone"]) {
      y = field("Name",  String(row["emergencyContact"] || "—"), M, y, CW);
      y = field("Phone", String(row["emergencyPhone"]   || "—"), M, y, CW);
    } else {
      doc.font("Helvetica").fillColor(GRAY).fontSize(10).text("No emergency contacts on file", M, y, { width: CW, lineBreak: false }); y += 16;
    }
    y += 14;

    y = check(110, y); y = sectionHeader(`Leave Balance (${year})`, y);
    const lw = [CW * 0.4, CW * 0.2, CW * 0.2, CW * 0.2];
    y = tblHeader(["Leave Type", "Total", "Used", "Remaining"], y, lw);
    if (lb) {
      y = tblRow(["Casual Leave", String(lb["casual_total"] ?? 0), String(lb["casual_used"] ?? 0), String(Number(lb["casual_total"] ?? 0) - Number(lb["casual_used"] ?? 0))], y, lw, false);
      y = tblRow(["Sick Leave",   String(lb["sick_total"]   ?? 0), String(lb["sick_used"]   ?? 0), String(Number(lb["sick_total"]   ?? 0) - Number(lb["sick_used"]   ?? 0))], y, lw, true);
      y = tblRow(["Paid Leave",   String(lb["paid_total"]   ?? 0), String(lb["paid_used"]   ?? 0), String(Number(lb["paid_total"]   ?? 0) - Number(lb["paid_used"]   ?? 0))], y, lw, false);
      y = tblRow(["Comp Off",     String(lb["comp_off"]     ?? 0), "0",                            String(lb["comp_off"] ?? 0)], y, lw, true);
    } else {
      doc.font("Helvetica").fillColor(GRAY).fontSize(10).text("No leave balance data available", M + 4, y + 4, { width: CW, lineBreak: false }); y += 22;
    }
    y += 14;

    y = check(80, y); y = sectionHeader("Documents", y);
    if (docRows.length === 0) {
      doc.font("Helvetica").fillColor(GRAY).fontSize(10).text("No documents uploaded", M, y, { width: CW, lineBreak: false }); y += 16;
    } else {
      const dw = [CW * 0.45, CW * 0.25, CW * 0.3];
      y = tblHeader(["Document Name", "Type", "Uploaded On"], y, dw);
      docRows.forEach((d, i) => { y = check(22, y); y = tblRow([String(d["name"] ?? "—"), String(d["docType"] ?? "—"), fmtDate(d["uploadedAt"])], y, dw, i % 2 === 1); });
    }

    const range = doc.bufferedPageRange();
    const total = range.count;
    for (let i = 0; i < total; i++) {
      doc.switchToPage(range.start + i);
      const fy = PH - 22;
      doc.moveTo(M, fy - 8).lineTo(PW - M, fy - 8).strokeColor(RULE).lineWidth(0.5).stroke();
      doc.font("Helvetica").fillColor(GRAY).fontSize(8).text("YouTooPreneur Agency OS — Confidential", M, fy, { width: CW / 2, lineBreak: false });
      doc.font("Helvetica").fillColor(GRAY).fontSize(8).text(`Page ${i + 1} of ${total}`, M, fy, { width: CW, align: "right", lineBreak: false });
    }

    logActivity(req.user!.id, "employee.profile_exported_pdf", "Employee", Number(row["id"]), undefined, { exportedBy: req.user!.id, timestamp: new Date() }, req.ip).catch(console.error);
    doc.end();
  } catch (err) {
    console.error("[employees/export-pdf]", err);
    if (!res.headersSent) res.status(500).json({ success: false, message: "PDF generation failed" });
  }
}

// ─── getEmployeeDirectory ─────────────────────────────────────────────────────
// Lightweight, non-sensitive list — any authenticated user can access this.
// Returns only id, name, email, and avatarUrl for ACTIVE employees.

export async function getEmployeeDirectory(req: Request, res: Response): Promise<void> {
  try {
    const rows = await q<RowDataPacket>(
      `SELECT u.id, u.name, u.email,
              COALESCE(u.avatar_url, e.photo_url) AS avatarUrl
       FROM employees e
       JOIN users u ON u.id = e.user_id
       WHERE e.status = 'ACTIVE' AND u.status = 'ACTIVE'
       ORDER BY u.name ASC`
    );
    res.json({ success: true, message: "OK", data: rows });
  } catch (err) {
    console.error("[employees/directory]", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}
