/**
 * Génère un PDF professionnel de lettre de motivation
 * Utilise PDFKit pour créer un document formaté
 * 
 * npm install pdfkit
 */

const PDFDocument = require("pdfkit");

/**
 * Formate le nom: "Elisa Blanchart" → "Elisa_BLANCHART"
 */
function formatName(userName) {
  const parts = userName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  const lastName = parts.slice(1).join("_").toUpperCase();
  return `${firstName}_${lastName}`;
}

/**
 * Nettoie un texte pour un nom de fichier
 */
function cleanForFilename(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .substring(0, 30);
}

/**
 * Génère le nom du fichier CV personnalisé
 * Ex: CV_Elisa_BLANCHART_AMOA_SAP.pdf
 */
function generateCVFilename(jobTitle, company, userName) {
  const name = formatName(userName);
  const title = cleanForFilename(jobTitle);
  return `CV_${name}_${title}.pdf`;
}

/**
 * Génère le nom du fichier LM personnalisé
 * Ex: LM_Elisa_BLANCHART_AMOA_SAP.pdf
 */
function generateLMFilename(jobTitle, company, userName) {
  const name = formatName(userName);
  const title = cleanForFilename(jobTitle);
  return `LM_${name}_${title}.pdf`;
}

/**
 * Génère l'objet du mail
 * Ex: Candidature AMOA SAP Transformation digitale - Elisa BLANCHART
 */
function generateEmailSubject(jobTitle, userName) {
  const parts = userName.trim().split(/\s+/);
  const firstName = parts[0]?.charAt(0).toUpperCase() + parts[0]?.slice(1).toLowerCase();
  const lastName = parts.slice(1).join(" ").toUpperCase();
  return `Candidature ${jobTitle} - ${firstName} ${lastName}`;
}

/**
 * Crée un PDF professionnel de lettre de motivation
 * Retourne un Buffer du PDF
 */
function createCoverLetterPDF({ userName, userEmail, userPhone, date, company, companyAddress, jobTitle, body }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 60, bottom: 60, left: 65, right: 65 },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // === EN-TÊTE: Coordonnées du candidat ===
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(userName, { align: "left" });

    if (userEmail) {
      doc.font("Helvetica").fontSize(10).text(userEmail);
    }
    if (userPhone) {
      doc.font("Helvetica").fontSize(10).text(userPhone);
    }

    doc.moveDown(1.5);

    // === Destinataire ===
    doc
      .font("Helvetica")
      .fontSize(10)
      .text(company, { align: "right" });

    if (companyAddress) {
      doc.text(companyAddress, { align: "right" });
    }

    doc.moveDown(1);

    // === Date ===
    doc
      .font("Helvetica")
      .fontSize(10)
      .text(date || formatDate(new Date()), { align: "right" });

    doc.moveDown(1.5);

    // === Objet ===
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(`Objet : Candidature au poste de ${jobTitle}`);

    doc.moveDown(1.2);

    // === Corps de la lettre ===
    const paragraphs = body.split("\n\n").filter(Boolean);

    for (const para of paragraphs) {
      doc
        .font("Helvetica")
        .fontSize(10.5)
        .text(para.trim(), {
          align: "justify",
          lineGap: 3,
        });
      doc.moveDown(0.8);
    }

    doc.moveDown(0.5);

    // === Signature ===
    doc
      .font("Helvetica")
      .fontSize(10.5)
      .text("Cordialement,", { align: "left" });
    doc.moveDown(0.5);
    doc
      .font("Helvetica-Bold")
      .fontSize(10.5)
      .text(userName, { align: "left" });

    doc.end();
  });
}

function formatDate(date) {
  const months = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
  ];
  return `Le ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

module.exports = { createCoverLetterPDF, generateLMFilename, generateCVFilename, generateEmailSubject };
