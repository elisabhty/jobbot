// Module partagé pour l'envoi de messages WhatsApp.
// Évite le circular require : server.js → conversation.js → server.js
// Les deux peuvent importer ce fichier sans dépendance circulaire.

const twilio = require("twilio");
const UI = require("./whatsapp-ui");

let _client = null;

function getClient() {
  if (!_client) {
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}

async function sendWhatsApp(to, body) {
  try {
    const client = getClient();
    if (typeof body === "string") {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to,
        body,
      });
    } else if (body && body.type) {
      await UI.sendMessage(to, body);
    }
    console.log(`[SENT] ${to}: ${typeof body === "string" ? body.substring(0, 50) : body.type}...`);
  } catch (e) {
    console.error("Send WhatsApp error:", e);
  }
}

module.exports = { sendWhatsApp };
