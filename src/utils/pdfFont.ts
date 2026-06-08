import path from "path";
import PDFDocument from "pdfkit";

const FONTS_DIR = path.join(__dirname, "../assets/fonts");

export const PDF_FONT_R = path.join(FONTS_DIR, "NotoSans-Regular.ttf");
export const PDF_FONT_B = path.join(FONTS_DIR, "NotoSans-Bold.ttf");

export function registerPdfFonts(doc: InstanceType<typeof PDFDocument>) {
  doc.registerFont("R", PDF_FONT_R);
  doc.registerFont("B", PDF_FONT_B);
}
