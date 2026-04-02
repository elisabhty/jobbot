/**
 * WhatsApp Interactive Messages via Twilio
 * 
 * 3 types de messages :
 * - TEXT    → message simple
 * - BUTTONS → jusqu'à 3 boutons cliquables (quick reply)
 * - LIST    → menu déroulant avec sections (4+ options)
 * 
 * Twilio utilise le Content API pour les messages interactifs.
 * On crée les templates à la volée et on les envoie.
 */

const twilio = require("twilio");

let twilioClient = null;

function getClient() {
  if (!twilioClient) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return twilioClient;
}

// ─── Message Types ──────────────────────────────────────

/**
 * Crée un message texte simple
 */
function text(body) {
  return { type: "text", body };
}

/**
 * Crée un message avec boutons cliquables (max 3)
 * @param {string} body - Le texte du message
 * @param {Array<{id: string, title: string}>} buttons - Max 3 boutons
 */
function buttons(body, buttonList) {
  return {
    type: "buttons",
    body,
    buttons: buttonList.slice(0, 3).map(b => ({
      id: typeof b === "string" ? b.toLowerCase().replace(/\s/g, "_") : b.id,
      title: typeof b === "string" ? b : b.title,
    })),
  };
}

/**
 * Crée un message avec une liste déroulante (4+ options)
 * @param {string} body - Le texte du message
 * @param {string} buttonText - Le texte du bouton qui ouvre la liste
 * @param {Array<{title: string, items: Array<{id: string, title: string, description?: string}>}>} sections
 */
function list(body, buttonText, sections) {
  return {
    type: "list",
    body,
    buttonText,
    sections,
  };
}

/**
 * Crée un message avec boutons + texte libre possible
 * (envoie des boutons mais accepte aussi du texte libre)
 * @param {string} body - Le texte du message
 * @param {Array} buttonList - Les boutons
 * @param {string} freeTextHint - Indication pour le texte libre
 */
function buttonsWithFreeText(body, buttonList, freeTextHint) {
  const fullBody = body + "\n\n_" + freeTextHint + "_";
  return {
    type: "buttons",
    body: fullBody,
    buttons: buttonList.slice(0, 3).map(b => ({
      id: typeof b === "string" ? b.toLowerCase().replace(/\s/g, "_") : b.id,
      title: typeof b === "string" ? b : b.title,
    })),
  };
}

/**
 * Crée un message liste avec option "Autre"
 */
function listWithOther(body, buttonText, items, otherHint) {
  const fullBody = body + "\n\n_" + otherHint + "_";
  return {
    type: "list",
    body: fullBody,
    buttonText,
    sections: [{
      title: "Options",
      items: [
        ...items.map(item => ({
          id: typeof item === "string" ? item.toLowerCase().replace(/\s/g, "_") : item.id,
          title: typeof item === "string" ? item : item.title,
          description: item.description || "",
        })),
      ],
    }],
  };
}

// ─── Send Functions ─────────────────────────────────────

/**
 * Envoie un message structuré via Twilio
 * Gère automatiquement le type (text, buttons, list)
 */
async function sendMessage(to, message) {
  const client = getClient();
  const from = process.env.TWILIO_WHATSAPP_NUMBER;

  // En sandbox Twilio, le Content API (boutons interactifs) n'est pas supporté.
  // On envoie toujours en texte simple avec numéros en fallback.
  try {
    return await sendAsFallbackText(client, from, to, message);
  } catch (e) {
    console.error("Send message error:", e.message);
  }
}

/**
 * Envoie un message avec boutons via Twilio Content API
 */
async function sendInteractiveButtons(client, from, to, message) {
  // Create content template on the fly
  const contentSid = await getOrCreateButtonTemplate(client, message);

  if (contentSid) {
    return await client.messages.create({
      from, to,
      contentSid,
    });
  }

  // Fallback: envoie en texte avec numéros
  return await sendAsFallbackText(client, from, to, message);
}

/**
 * Envoie une liste interactive via Twilio Content API
 */
async function sendInteractiveList(client, from, to, message) {
  const contentSid = await getOrCreateListTemplate(client, message);

  if (contentSid) {
    return await client.messages.create({
      from, to,
      contentSid,
    });
  }

  // Fallback
  return await sendAsFallbackText(client, from, to, message);
}

/**
 * Fallback: transforme un message interactif en texte simple
 * Si les boutons ne sont pas supportés (sandbox), on affiche des numéros
 */
async function sendAsFallbackText(client, from, to, message) {
  let body = message.body || "";

  if (message.type === "buttons" && message.buttons) {
    body += "\n\n";
    message.buttons.forEach((btn, i) => {
      body += `${i + 1}️⃣ *${btn.title}*\n`;
    });
    body += "\n_Répondez avec le numéro ou tapez votre réponse_";
  }

  if (message.type === "list" && message.sections) {
    body += "\n\n";
    let idx = 1;
    for (const section of message.sections) {
      if (section.title) body += `*${section.title}*\n`;
      for (const item of section.items) {
        body += `${idx}️⃣ *${item.title}*`;
        if (item.description) body += ` — ${item.description}`;
        body += "\n";
        idx++;
      }
      body += "\n";
    }
    body += "_Répondez avec le numéro ou tapez votre réponse_";
  }

  return await client.messages.create({ from, to, body });
}

// ─── Template Cache ─────────────────────────────────────

const templateCache = new Map();

async function getOrCreateButtonTemplate(client, message) {
  const cacheKey = JSON.stringify({ body: message.body, buttons: message.buttons });

  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey);
  }

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `jobbot_btn_${Date.now()}`,
      language: "fr",
      variables: {},
      types: {
        "twilio/quick-reply": {
          body: message.body,
          actions: message.buttons.map(btn => ({
            title: btn.title.substring(0, 20), // WhatsApp limit: 20 chars
            id: btn.id,
          })),
        },
      },
    });

    // Approve the template
    await client.content.v1
      .contents(content.sid)
      .approvalRequests.create({ name: `jobbot_btn_${Date.now()}` })
      .catch(() => {}); // May not need approval for quick replies

    templateCache.set(cacheKey, content.sid);
    return content.sid;
  } catch (e) {
    console.error("Template creation failed:", e.message);
    return null;
  }
}

async function getOrCreateListTemplate(client, message) {
  const cacheKey = JSON.stringify({ body: message.body, sections: message.sections });

  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey);
  }

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `jobbot_list_${Date.now()}`,
      language: "fr",
      variables: {},
      types: {
        "twilio/list-picker": {
          body: message.body,
          button: message.buttonText || "Choisir",
          items: message.sections.flatMap(s =>
            s.items.map(item => ({
              id: item.id,
              item: item.title.substring(0, 24), // WhatsApp limit
              description: (item.description || "").substring(0, 72),
            }))
          ),
        },
      },
    });

    templateCache.set(cacheKey, content.sid);
    return content.sid;
  } catch (e) {
    console.error("List template creation failed:", e.message);
    return null;
  }
}

// ─── Response Parser ────────────────────────────────────

/**
 * Parse la réponse d'un bouton interactif
 * Twilio envoie le ButtonPayload dans req.body.ButtonPayload
 * ou le ListItem dans req.body.ListItem
 * 
 * Retourne l'ID du bouton/item cliqué, ou le texte brut
 */
function parseInteractiveResponse(reqBody) {
  // Button reply
  if (reqBody.ButtonPayload) {
    return {
      type: "button",
      id: reqBody.ButtonPayload,
      text: reqBody.Body || reqBody.ButtonPayload,
    };
  }

  // List reply
  if (reqBody.ListId) {
    return {
      type: "list",
      id: reqBody.ListId,
      text: reqBody.Body || reqBody.ListId,
    };
  }

  // Regular text
  return {
    type: "text",
    id: null,
    text: reqBody.Body || "",
  };
}

// ─── Pre-built Message Builders ─────────────────────────

const Messages = {
  welcome() {
    return buttons(
      "👋 *Salut ! C'est JobBot.* 🤖\n\n" +
      "Marre de passer des heures à scroller des offres et à réécrire 100 fois la même lettre ? Je m'en occupe pour vous.\n\n" +
      "Pendant que vous dormez, je travaille :\n\n" +
      "🔍 *Veille stratégique :* Je scanne le web en continu (LinkedIn, Indeed, France Travail et +) pour vous.\n" +
      "✍️ *Optimisation de profil :* Je réécris votre lettre pour chaque offre et passe les filtres recruteurs.\n" +
      "🌍 *Mobilité internationale :* Je traduis vos documents dans la langue du pays de votre choix.\n" +
      "💰 *Étude de marché :* J'analyse les salaires du secteur pour vous aider à négocier.\n" +
      "🚀 *Gestion des envois :* Je postule à votre place ou prépare votre dossier complet.\n" +
      "🎓 *Succès en entretien :* Je vous prépare aux questions spécifiques de l'entreprise.\n\n" +
      "━━━━━━━━━━━━━━━\n" +
      "🎁 7 jours offerts (Testez-moi sans CB !)\n" +
      `💳 Puis ${process.env.SUBSCRIPTION_PRICE || "4,99"}€/${process.env.SUBSCRIPTION_PERIOD || "semaine"} — Sans engagement.\n` +
      "━━━━━━━━━━━━━━━\n\n" +
      "👇 *Envoyez votre CV (PDF) ici pour commencer.*\n" +
      "Je l'analyse en 10 secondes.",
      [{ id: "send_cv", title: "📄 Envoyer mon CV" }]
    );
  },

  askMobility(city) {
    return buttons(
      `📍 *${city}*, noté !\n\nÊtes-vous mobile ailleurs ?`,
      [
        { id: "only_here", title: `📍 ${city.substring(0, 14)} seul.` },
        { id: "other_cities", title: "🇫🇷 Autres villes" },
        { id: "international", title: "🌍 International" },
      ]
    );
  },

  askMobilityBoth(city) {
    return buttons(
      `📍 *${city}*, noté !\n\nÊtes-vous mobile ailleurs ?`,
      [
        { id: "only_here", title: `📍 ${city.substring(0, 14)} seul.` },
        { id: "france_and_intl", title: "🇫🇷 + 🌍 Les deux" },
      ]
    );
  },

  askContract() {
    return listWithOther(
      "📄 *Quel type de contrat recherchez-vous ?*",
      "Choisir le contrat",
      [
        { id: "cdi", title: "CDI", description: "Contrat à durée indéterminée" },
        { id: "cdd", title: "CDD", description: "Contrat à durée déterminée" },
        { id: "interim", title: "Intérim", description: "Missions temporaires" },
        { id: "freelance", title: "Freelance", description: "Indépendant / Consultant" },
        { id: "alternance", title: "Alternance", description: "Contrat d'apprentissage ou pro" },
        { id: "stage", title: "Stage", description: "Stage conventionné" },
        { id: "etudiant", title: "Job étudiant", description: "Temps partiel / Saisonnier" },
        { id: "vie", title: "VIE", description: "Volontariat International en Entreprise" },
        { id: "via", title: "VIA", description: "Volontariat International en Administration" },
        { id: "all", title: "Peu importe", description: "Tous types de contrats" },
      ],
      "Ou tapez directement votre préférence (ex: portage salarial)"
    );
  },

  askWorkMode() {
    return listWithOther(
      "🏠 *Quel mode de travail préférez-vous ?*",
      "Choisir le mode",
      [
        { id: "onsite", title: "Sur site", description: "100% présentiel" },
        { id: "hybrid", title: "Hybride", description: "Mix bureau / télétravail" },
        { id: "remote", title: "Full remote", description: "100% télétravail" },
        { id: "any", title: "Peu importe", description: "Tous modes de travail" },
      ],
      "Ou tapez votre préférence (ex: 3j bureau 2j remote)"
    );
  },

  confirmRecap(recap) {
    return buttons(
      recap,
      [
        { id: "confirm_yes", title: "✅ C'est bon !" },
        { id: "confirm_modify", title: "✏️ Modifier" },
      ]
    );
  },

  validateLetter(letterPreview) {
    return buttons(
      letterPreview,
      [
        { id: "letter_ok", title: "✅ Envoyer" },
        { id: "letter_modify", title: "✏️ Modifier" },
        { id: "letter_cancel", title: "❌ Annuler" },
      ]
    );
  },

  jobActions(jobId) {
    return buttons(
      "Que voulez-vous faire ?",
      [
        { id: `apply_${jobId}`, title: "📨 Postuler" },
        { id: `skip_${jobId}`, title: "⏭️ Passer" },
        { id: "see_more", title: "📋 Voir plus" },
      ]
    );
  },

  followUpQuestion(jobTitle, company) {
    return buttons(
      `🔔 *Relance — ${jobTitle} chez ${company}*\n\nÇa fait 7 jours. Avez-vous eu une réponse ?`,
      [
        { id: "followup_interview", title: "✅ Entretien prévu" },
        { id: "followup_rejected", title: "❌ Refus" },
        { id: "followup_nothing", title: "⏳ Pas de réponse" },
      ]
    );
  },

  trialExpired() {
    const price  = process.env.SUBSCRIPTION_PRICE  || "4,99";
    const period = process.env.SUBSCRIPTION_PERIOD || "semaine";
    return buttons(
      `⏰ Votre essai gratuit est terminé !\n\nPour continuer à recevoir des offres et des candidatures automatiques :\n\n💳 *${price}€/${period}* — sans engagement`,
      [
        { id: "pay_now", title: "💳 S'abonner" },
        { id: "later", title: "⏳ Plus tard" },
      ]
    );
  },
};

module.exports = {
  text,
  buttons,
  list,
  buttonsWithFreeText,
  listWithOther,
  sendMessage,
  parseInteractiveResponse,
  Messages,
};
