const nodemailer = require("nodemailer");
const { generateEmailSubject } = require("./pdf-generator");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Détermine le type de candidature possible pour une offre.
 * Conservé pour usage futur — la logique principale est dans conversation.js.
 */
function getApplicationType(job) {
  if (job.contact_email) return "email";
  if (job.apply_url) return "formulaire";
  return "manual";
}

/**
 * Envoie une candidature par email
 */
async function sendApplicationEmail({
  to,
  jobTitle,
  company,
  userName,
  coverLetterPDF,
  coverLetterFilename,
  cvBuffer,
  cvFilename,
  customSubject,
  additionalInfo,
}) {
  const subject = customSubject || generateEmailSubject(jobTitle, userName);

  // Build email body
  let emailBody = `Madame, Monsieur,\n\n`;
  emailBody += `Veuillez trouver ci-joint ma candidature au poste de ${jobTitle} au sein de ${company}, accompagnée de mon CV et de ma lettre de motivation.\n\n`;

  // Add additional info (references, links, etc.)
  if (additionalInfo && additionalInfo.length > 0) {
    const links = additionalInfo.filter(i => i.includes("http") || i.includes("linkedin"));
    const texts = additionalInfo.filter(i => !i.includes("http") && !i.includes("linkedin"));

    if (links.length > 0) {
      emailBody += `Références :\n`;
      links.forEach(l => { emailBody += `- ${l}\n`; });
      emailBody += `\n`;
    }
    if (texts.length > 0) {
      emailBody += `Informations complémentaires :\n`;
      texts.forEach(t => { emailBody += `${t}\n`; });
      emailBody += `\n`;
    }
  }

  emailBody += `Je reste à votre disposition pour tout entretien à votre convenance.\n\n`;
  emailBody += `Cordialement,\n${userName}`;

  const attachments = [];

  if (coverLetterPDF) {
    attachments.push({
      filename: coverLetterFilename || "Lettre_de_motivation.pdf",
      content: coverLetterPDF,
      contentType: "application/pdf",
    });
  }

  if (cvBuffer) {
    attachments.push({
      filename: cvFilename || "CV.pdf",
      content: cvBuffer,
      contentType: "application/pdf",
    });
  }

  const mailOptions = {
    from: `"${userName}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text: emailBody,
    attachments,
  };

  return transporter.sendMail(mailOptions);
}

/**
 * Génère le message WhatsApp pour une candidature manuelle
 * (quand il faut postuler via le site)
 */
function generateManualApplicationMessage(job, coverLetterText, coverLetterFilename) {
  let msg = `📋 *Candidature préparée pour ${job.company}*\n\n`;
  msg += `📌 Poste : ${job.title}\n`;
  msg += `🔗 Lien pour postuler : ${job.url}\n\n`;
  msg += `✅ J'ai préparé votre lettre de motivation en PDF.\n`;
  msg += `📎 Fichier : *${coverLetterFilename}*\n\n`;
  msg += `👉 *Étapes :*\n`;
  msg += `1. Ouvrez le lien ci-dessus\n`;
  msg += `2. Cliquez sur "Postuler"\n`;
  msg += `3. Joignez votre CV + la lettre de motivation que je vous envoie\n`;
  msg += `4. Copiez cet objet pour l'email : *${generateEmailSubject(job.title, "Votre Nom")}*\n\n`;
  msg += `_Je vous relancerai dans 7 jours pour savoir si vous avez eu une réponse._`;

  return msg;
}


/**
 * Génère un email de relance
 */
async function sendFollowUpEmail({ to, jobTitle, company, userName }) {
  const subject = `Relance — Candidature ${jobTitle} - ${userName}`;

  const body = `Madame, Monsieur,

Je me permets de revenir vers vous concernant ma candidature au poste de ${jobTitle} au sein de ${company}, envoyée il y a une semaine.

Ce poste correspond pleinement à mon profil et à mes aspirations professionnelles. Je reste très motivé(e) et disponible pour un entretien à votre convenance.

Dans l'attente de votre retour, je vous prie d'agréer mes salutations distinguées.

${userName}`;

  return transporter.sendMail({
    from: `"${userName}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text: body,
  });
}

module.exports = {
  getApplicationType,
  sendApplicationEmail,
  generateManualApplicationMessage,
  sendFollowUpEmail,
};
