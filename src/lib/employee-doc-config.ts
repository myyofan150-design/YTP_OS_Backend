// src/lib/employee-doc-config.ts

export interface DocConfigItem {
  name: string;
  docType: string;
  category: string;
  isMandatory: boolean;
}

export const MANDATORY_DOCUMENTS: DocConfigItem[] = [
  { name: "Aadhaar Card",                    docType: "ID_PROOF", category: "identity",  isMandatory: true },
  { name: "PAN Card",                        docType: "ID_PROOF", category: "identity",  isMandatory: true },
  { name: "Bank Passbook / Cancelled Cheque", docType: "OTHER",   category: "banking",   isMandatory: true },
  { name: "Highest Education Certificate",   docType: "OTHER",    category: "education", isMandatory: true },
];

export const OPTIONAL_DOCUMENTS: DocConfigItem[] = [
  { name: "Passport",               docType: "ID_PROOF", category: "identity",   isMandatory: false },
  { name: "Experience Certificate", docType: "OTHER",    category: "experience", isMandatory: false },
  { name: "Last 3 Payslips",        docType: "OTHER",    category: "experience", isMandatory: false },
  { name: "Relieving Letter",       docType: "OTHER",    category: "experience", isMandatory: false },
  { name: "Skill Certificates",     docType: "OTHER",    category: "other",      isMandatory: false },
];
