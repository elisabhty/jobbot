const { getUser, createUser, updateUser, saveMessage, markJobApplied, getJob, markJobSent, isSubscriptionActive, getTrialDaysLeft, saveJobs, getUnsentJobs, saveFeedback, getFeedbackStats, buildMatchingContext, getLastSentJobs, updateApplicationStatus, getApplication, saveApplication, updateApplicationFollowup, checkRateLimit, getRateLimitStats, deleteUser } = require("./db");
const { parseCV, generateWelcomeAfterCV, generateFormalCoverLetter, modifyCoverLetter, matchJobToProfile, matchJobsBatch, analyzeMarket, formatMarketAnalysis, generateInterviewPrep, formatInterviewPrep, analyzeJobPosting, formatApplicationBriefing, detectCVLanguageNeeded, translateCVContent, targetLangName } = require("./cv-parser");
const { searchAllSources } = require("./job-scraper");
const { createCoverLetterPDF, generateLMFilename, generateCVFilename, generateEmailSubject } = require("./pdf-generator");
const { getApplicationType, sendApplicationEmail, generateManualApplicationMessage, sendFollowUpEmail } = require("./auto-apply");
const UI = require("./whatsapp-ui");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const crypto = require("crypto");

// Génère une URL de tableau de bord signée (HMAC 8 chars, pas de token en DB)
function buildDashboardUrl(phone) {
  const raw = phone.replace("whatsapp:+", "");
  const secret = process.env.DASHBOARD_SECRET || "jobbot-dashboard";
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex").slice(0, 8);
  return `${process.env.BASE_URL}/dashboard/${raw}-${sig}`;
}

/**
 * ÉTATS:
 * welcome → waiting_cv → asking_city → asking_mobility →
 * asking_other_cities → asking_countries → asking_other_cv →
 * asking_salary → asking_contract → asking_vie_countries (si VIE) → asking_workmode → asking_weekend → confirm → active →
 * asking_translation (si offre internationale) → active → postuler →
 * collecting_docs (si documents manquants) → reviewing_letter → asking_followup → active
 */

async function handleMessage(phone, body, mediaUrl, mediaType) {
  let user = getUser(phone);
  if (!user) user = createUser(phone);
  saveMessage(user.id, "in", body);

  const state = user.conversation_state || "welcome";
  const convData = JSON.parse(user.conversation_data || "{}");
  const lower = body.toLowerCase().trim();

  // === Commandes globales ===
  // === Commandes globales ===

  if (lower === "stop" || lower.startsWith("pause")) {
    // /pause [durée] → pause temporaire avec auto-reprise
    let pausedUntil = null;
    let dureeMsg = "indéfinie";
    const match = lower.match(/(\d+)\s*(jour|jours|semaine|semaines)/);
    if (match) {
      const n = parseInt(match[1]);
      const isWeeks = match[2].startsWith("semaine");
      const days = isWeeks ? n * 7 : n;
      pausedUntil = new Date(Date.now() + days * 86400000).toISOString();
      dureeMsg = `${n} ${match[2]}`;
    }
    updateUser(phone, { conversation_state: "paused", paused_until: pausedUntil });
    const reprise = pausedUntil
      ? `\n\n_Reprise automatique dans ${dureeMsg}. Tapez *reprendre* à tout moment._`
      : `\n\n_Tapez *reprendre* pour réactiver._`;
    return `⏸️ Bot en pause${pausedUntil ? ` pour ${dureeMsg}` : ""}.${reprise}`;
  }

  if (lower === "reprendre") {
    updateUser(phone, { conversation_state: "active", paused_until: null });
    return "▶️ C'est reparti ! Je reprends la recherche dès demain matin.";
  }

  if (lower === "/supprimer" || lower === "supprimer mes données" || lower === "supprimer mes donnees") {
    updateUser(phone, { conversation_state: "confirming_delete" });
    return UI.buttons(
      "🗑️ *Suppression de vos données (RGPD)*\n\n" +
      "Cette action est *irréversible* :\n" +
      "• Votre CV et profil\n• Toutes vos candidatures\n• Votre historique de messages\n\n" +
      "Votre abonnement sera annulé automatiquement via Stripe.\n\n" +
      "*Confirmez-vous la suppression définitive ?*",
      [
        { id: "delete_confirm", title: "🗑️ Oui, tout supprimer" },
        { id: "delete_cancel",  title: "↩️ Annuler" },
      ]
    );
  }

  if (lower === "/annuler") {
    if (user.subscription_status !== "active" && user.subscription_status !== "cancelling") {
      return "ℹ️ Vous n'avez pas d'abonnement actif à annuler.";
    }
    if (user.subscription_status === "cancelling") {
      return "⏳ Votre résiliation est déjà en cours — votre accès reste actif jusqu'à la fin de la période payée.";
    }
    const raw = phone.replace("whatsapp:+", "");
    const sig = crypto.createHmac("sha256", process.env.DASHBOARD_SECRET || "jobbot-dashboard-secret")
      .update("cancel:" + raw).digest("hex").slice(0, 8);
    const cancelUrl = `${process.env.BASE_URL}/cancel-subscription/${raw}-${sig}`;
    return UI.buttons(
      "⚠️ *Annuler votre abonnement*\n\n" +
      "Votre accès restera actif jusqu'à la fin de la semaine en cours.\n\n" +
      `👉 Confirmez ici :\n${cancelUrl}`,
      [{ id: "keep_sub", title: "↩️ Garder mon abonnement" }]
    );
  }

  if (lower === "keep_sub") {
    return "👍 Parfait, votre abonnement continue !";
  }

  if (lower === "reprendre abonnement") {
    if (user.stripe_subscription_id && user.subscription_status === "cancelling") {
      try {
        const stripeLib = require("stripe")(process.env.STRIPE_SECRET_KEY);
        await stripeLib.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: false });
        updateUser(phone, { subscription_status: "active" });
        return "✅ *Résiliation annulée !* Votre abonnement continue normalement.";
      } catch (e) {
        console.error("Reactivate error:", e);
        return "❌ Erreur. Tapez *payer* pour souscrire à nouveau.";
      }
    }
    return "ℹ️ Tapez *payer* pour souscrire à un nouvel abonnement.";
  }

  if (lower === "/cv" || lower === "cv") {
    updateUser(phone, { conversation_state: "updating_cv" });
    return "📄 *Mise à jour du CV*\n\nEnvoyez votre nouveau CV en PDF. Je mets à jour votre profil et reprends la recherche avec les nouvelles informations.";
  }

  if (lower === "/tableau" || lower === "tableau" || lower === "dashboard") {
    const { sendWhatsApp } = require("./server");
    const dashUrl = buildDashboardUrl(phone);
    return `📊 *Votre tableau de bord :*\n\n🔗 ${dashUrl}\n\n_Lien valable 30 jours — ne le partagez pas._`;
  }

  if (lower === "aide" || lower === "help") {
    const rl = getRateLimitStats(phone);
    return `🤖 *Commandes disponibles :*\n\n` +
      `📄 */cv* — mettre à jour votre CV\n` +
      `📊 */statut* — candidatures, abonnement, crédits\n` +
      `🌐 */tableau* — tableau de bord web\n` +
      `⚙️ */modifier* — changer ville, contrat ou mode de travail\n` +
      `💰 *salaire* — analyse du marché\n` +
      `🎯 *entretien [numéro]* — guide d'entretien\n` +
      `🔍 *chercher* — lancer une recherche maintenant\n` +
      `📩 *relancer [id]* — relancer une candidature\n` +
      `⏸️ *pause [3 jours]* — pause temporaire\n` +
      `▶️ *reprendre* — réactiver\n` +
      `🗑️ */supprimer* — effacer mes données (RGPD)\n` +
      `💳 *payer* — s'abonner\n\n` +
      `_Crédits IA aujourd'hui : ${rl.calls}/${rl.limit}_`;
  }

  // === STATE MACHINE ===
  switch (state) {

    case "welcome":
      // Déclenché par le lien wa.me?text=Démarrer ou n'importe quel premier message
      updateUser(phone, { conversation_state: "waiting_cv" });
      return UI.Messages.welcome();

    case "waiting_cv":
      if (mediaUrl && mediaType && mediaType.includes("pdf")) {
        try {
          const pdfResponse = await axios.get(mediaUrl, { responseType: "arraybuffer", auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } });
          const pdfData = await pdfParse(Buffer.from(pdfResponse.data));
          if (!pdfData.text || pdfData.text.length < 50) return "❌ CV illisible. Envoyez un PDF avec du texte (pas un scan image).";

          const profile = await parseCV(pdfData.text);
          convData.profile = profile;
          convData.languages = [{ lang: profile.language, cv_provided: true }];

          updateUser(phone, {
            name: profile.name, cv_text: pdfData.text.substring(0, 5000),
            cv_language: profile.language, target_job_title: profile.job_title,
            conversation_state: "asking_city", conversation_data: JSON.stringify(convData),
          });

          return generateWelcomeAfterCV(profile);
        } catch (e) {
          console.error("CV parse error:", e);
          return "❌ Erreur d'analyse. Réessayez avec un autre PDF.";
        }
      }
      return "📄 Envoyez votre CV en *PDF*. Appuyez sur 📎 dans WhatsApp.";

    case "asking_city":
      convData.currentCity = body.trim();
      convData.cities = [body.trim()];
      updateUser(phone, { conversation_state: "asking_mobility", conversation_data: JSON.stringify(convData) });
      return UI.Messages.askMobility(body.trim());

    case "asking_mobility":
      // Handle button clicks AND text responses
      const isOnlyHere = lower === "only_here" || lower === "1" || lower.includes("uniquement");
      const isOtherCities = lower === "other_cities" || lower === "2" || lower.includes("autres villes") || lower.includes("france");
      const isInternational = lower === "international" || lower === "3" || lower.includes("international");
      const isBoth = lower === "france_and_intl" || (lower.includes("2") && lower.includes("3"));

      if (isOnlyHere && !isOtherCities && !isInternational) {
        convData.countries = [guessCountry(convData.currentCity)];
        updateUser(phone, { target_cities: JSON.stringify(convData.cities), target_countries: JSON.stringify(convData.countries), conversation_state: "asking_salary", conversation_data: JSON.stringify(convData) });
        return `👍 Recherche à ${convData.currentCity} uniquement.\n\n💰 *Salaire minimum annuel brut ?*\n_Ex: 35000 ou "pas de minimum"_`;
      }

      if (isOtherCities && !isInternational && !isBoth) {
        updateUser(phone, { conversation_state: "asking_other_cities", conversation_data: JSON.stringify(convData) });
        return "🇫🇷 *Quelles autres villes ?*\n_Séparées par des virgules, ou \"toute la France\"_";
      }

      if (isInternational && !isOtherCities && !isBoth) {
        updateUser(phone, { conversation_state: "asking_countries", conversation_data: JSON.stringify(convData) });
        return "🌍 *Dans quels pays ?*\n_Ex: Canada, Belgique, Suisse_\n\n💡 _Votre CV est en " + langCodeToName(convData.profile?.language) + ". Pour un pays non-francophone, envoyez aussi votre CV dans la langue du pays._";
      }

      if (isBoth || (isOtherCities && isInternational)) {
        updateUser(phone, { conversation_state: "asking_other_cities", conversation_data: JSON.stringify({ ...convData, alsoInternational: true }) });
        return "🇫🇷 D'abord la France — *quelles autres villes ?*\n_Séparées par des virgules, ou \"toute la France\"_";
      }

      return UI.Messages.askMobility(convData.currentCity);

    case "asking_other_cities":
      if (lower.includes("toute la france") || lower.includes("partout")) {
        convData.cities = ["Toute la France"];
      } else {
        const otherCities = body.split(",").map(c => c.trim()).filter(Boolean);
        convData.cities = [convData.currentCity, ...otherCities];
      }
      convData.countries = [guessCountry(convData.currentCity)];

      if (convData.alsoInternational) {
        updateUser(phone, { target_cities: JSON.stringify(convData.cities), conversation_state: "asking_countries", conversation_data: JSON.stringify(convData) });
        return `✅ France : *${convData.cities.join(", ")}*\n\n🌍 Maintenant, *quels pays à l'international ?*\n_Ex: Canada, Belgique_`;
      }

      updateUser(phone, { target_cities: JSON.stringify(convData.cities), target_countries: JSON.stringify(convData.countries), conversation_state: "asking_salary", conversation_data: JSON.stringify(convData) });
      return `✅ Recherche : *${convData.cities.join(", ")}*\n\n💰 *Salaire minimum annuel brut ?*`;

    case "asking_countries":
      const countries = body.split(",").map(c => c.trim()).filter(Boolean);
      convData.countries = [guessCountry(convData.currentCity), ...countries];

      const needsOtherCV = countries.some(c => {
        const lang = countryToLanguage(c);
        return lang && lang !== convData.profile?.language;
      });

      if (needsOtherCV) {
        const neededLangs = [...new Set(countries.map(countryToLanguage).filter(Boolean).filter(l => l !== convData.profile?.language))];
        updateUser(phone, { target_countries: JSON.stringify(convData.countries), international_mobile: 1, conversation_state: "asking_other_cv", conversation_data: JSON.stringify(convData) });
        return `🌍 Pays notés.\n\n📄 Envoyez votre CV en *${neededLangs.map(langCodeToName).join(", ")}* pour maximiser vos chances.\nOu *skip* pour continuer avec votre CV actuel.`;
      }

      updateUser(phone, { target_countries: JSON.stringify(convData.countries), international_mobile: 1, conversation_state: "asking_salary", conversation_data: JSON.stringify(convData) });
      return `🌍 Pays notés : *${convData.countries.join(", ")}*\n\n💰 *Salaire minimum annuel brut ?*`;

    case "asking_other_cv":
      if (lower === "skip" || lower === "passer") {
        updateUser(phone, { conversation_state: "asking_salary", conversation_data: JSON.stringify(convData) });
        return "👍 On continue avec votre CV actuel.\n\n💰 *Salaire minimum annuel brut ?*";
      }
      if (mediaUrl && mediaType?.includes("pdf")) {
        try {
          const res = await axios.get(mediaUrl, { responseType: "arraybuffer", auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } });
          const pdf = await pdfParse(Buffer.from(res.data));
          const profile = await parseCV(pdf.text);
          convData.languages.push({ lang: profile.language, cv_provided: true });
          updateUser(phone, { languages: JSON.stringify(convData.languages), conversation_state: "asking_salary", conversation_data: JSON.stringify(convData) });
          return `✅ CV en *${langCodeToName(profile.language)}* reçu !\n\n💰 *Salaire minimum annuel brut ?*`;
        } catch (e) { return "❌ Erreur. Réessayez ou *skip*."; }
      }
      return "📄 Envoyez le PDF ou *skip*.";

    case "asking_salary":
      convData.salary = lower.includes("pas de") || lower.includes("aucun") || lower === "0" ? "0" : body.replace(/[^0-9]/g, "") || "0";
      updateUser(phone, { target_salary: convData.salary, conversation_state: "asking_contract", conversation_data: JSON.stringify(convData) });
      return UI.Messages.askContract();

    case "asking_contract":
      // Handle button IDs from interactive list
      const contractIdMap = { cdi: "CDI", cdd: "CDD", interim: "Intérim", freelance: "Freelance", alternance: "Alternance", stage: "Stage", etudiant: "Job étudiant", vie: "VIE", via: "VIA", all: "Tous types" };
      // Handle numbered text responses too
      const contractNumMap = { "1": "CDI", "2": "CDD", "3": "Intérim", "4": "Freelance", "5": "Alternance", "6": "Stage", "7": "Job étudiant", "8": "VIE", "9": "VIA", "10": "Tous types" };

      if (contractIdMap[lower]) {
        convData.contractType = contractIdMap[lower];
      } else if (contractNumMap[lower.replace(/\s/g, "").split(",")[0]]) {
        const nums = lower.replace(/\s/g, "").split(",");
        convData.contractType = nums.map(n => contractNumMap[n]).filter(Boolean).join(", ") || body.trim();
      } else {
        convData.contractType = body.trim();
      }

      // VIE/VIA-specific: auto-enable international if not already
      const isVIE = convData.contractType.includes("VIE");
      const isVIA = convData.contractType.includes("VIA");
      const isInternationalContract = isVIE || isVIA;
      if (isInternationalContract && !convData.countries?.some(c => c.toLowerCase() !== "france")) {
        convData.includesVIE = isVIE;
        convData.includesVIA = isVIA;
        const typeLabel = isVIE && isVIA ? "VIE/VIA" : isVIE ? "VIE" : "VIA";
        updateUser(phone, { conversation_state: "asking_vie_countries", conversation_data: JSON.stringify(convData) });
        return `🌍 Le ${typeLabel} est par définition à l'international !\n\n*Dans quels pays souhaitez-vous chercher ?*\n\n_Ex: Allemagne, UK, Singapour, USA_\n_Ou tapez "tous" pour chercher partout_`;
      }

      if (isVIE) convData.includesVIE = true;
      if (isVIA) convData.includesVIA = true;

      updateUser(phone, { conversation_state: "asking_workmode", conversation_data: JSON.stringify(convData) });
      return UI.Messages.askWorkMode();

    case "asking_vie_countries":
      if (lower === "tous" || lower === "tout" || lower.includes("partout")) {
        convData.countries = [...(convData.countries || []), "International"];
      } else {
        const vieCountries = body.split(",").map(c => c.trim()).filter(Boolean);
        convData.countries = [...new Set([...(convData.countries || []), ...vieCountries])];
      }

      updateUser(phone, {
        target_countries: JSON.stringify(convData.countries),
        international_mobile: 1,
        conversation_state: "asking_workmode",
        conversation_data: JSON.stringify(convData),
      });

      const vieViaLabel = convData.includesVIE && convData.includesVIA ? "VIE/VIA" : convData.includesVIE ? "VIE" : "VIA";
      const sourceHint = convData.includesVIA ? "Civiweb + France Diplomatie" : "Civiweb";

      return UI.listWithOther(
        `✅ ${vieViaLabel} dans : *${convData.countries.join(", ")}*\n💡 _Je chercherai aussi sur ${sourceHint}._\n\n🏠 *Quel mode de travail préférez-vous ?*`,
        "Choisir le mode",
        [
          { id: "onsite", title: "Sur site", description: "100% présentiel" },
          { id: "hybrid", title: "Hybride", description: "Mix bureau / télétravail" },
          { id: "remote", title: "Full remote", description: "100% télétravail" },
          { id: "any", title: "Peu importe", description: "Tous modes de travail" },
        ],
        "Ou tapez votre préférence"
      );

    case "asking_workmode":
      // Handle button IDs from interactive list
      const modeIdMap = { onsite: "Sur site", hybrid: "Hybride", remote: "Full remote", any: "Peu importe" };
      // Handle numbered text responses
      const modeNumMap = { "1": "Sur site", "2": "Hybride", "3": "Full remote", "4": "Peu importe" };

      if (modeIdMap[lower]) {
        convData.workMode = modeIdMap[lower];
      } else if (modeNumMap[lower.replace(/\s/g, "").split(",")[0]]) {
        const nums = lower.replace(/\s/g, "").split(",");
        convData.workMode = nums.map(n => modeNumMap[n]).filter(Boolean).join(", ") || body.trim();
      } else {
        // Free text — user typed something custom
        convData.workMode = body.trim();
      }

      updateUser(phone, { conversation_state: "asking_weekend", conversation_data: JSON.stringify(convData) });

      return UI.buttons(
        `✅ Mode : *${convData.workMode}*\n\n🗓️ *Quand souhaitez-vous recevoir les offres ?*`,
        [
          { id: "weekend_silent", title: "📅 Lun-Ven" },
          { id: "weekend_active", title: "📬 7j/7" },
        ]
      );

    case "asking_weekend":
      const wantsSilent = lower === "weekend_silent" || lower === "1" || lower.includes("pas") || lower.includes("non") || lower.includes("silence") || lower.includes("tranquille");
      const wantsActive = lower === "weekend_active" || lower === "2" || lower === "oui" || lower.includes("7j") || lower.includes("tous les jours") || lower.includes("week-end");

      if (wantsSilent || (!wantsActive)) {
        convData.weekendSilent = true;
        updateUser(phone, { weekend_silent: 1, conversation_state: "confirm", conversation_data: JSON.stringify(convData) });
      } else {
        convData.weekendSilent = false;
        updateUser(phone, { weekend_silent: 0, conversation_state: "confirm", conversation_data: JSON.stringify(convData) });
      }

      let recap = "📋 *Récapitulatif :*\n\n";
      recap += `👤 ${convData.profile?.name || user.name}\n`;
      recap += `💼 ${convData.profile?.job_title || user.target_job_title}\n`;
      recap += `📍 ${(convData.cities || []).join(", ")}\n`;
      recap += `🌍 ${(convData.countries || []).join(", ")}\n`;
      recap += `💰 ${convData.salary === "0" ? "Pas de minimum" : convData.salary + "€/an"}\n`;
      recap += `📄 Contrat : ${convData.contractType}\n`;
      recap += `🏠 Mode : ${convData.workMode}\n`;
      recap += `🗓️ Notifications : ${convData.weekendSilent ? "Tous les jours sauf le week-end" : "Tous les jours (7j/7)"}\n`;
      recap += `🌐 CV : ${(convData.languages || []).map(l => langCodeToName(l.lang)).join(", ")}\n\n`;
      recap += "*C'est correct ?*";
      return UI.Messages.confirmRecap(recap);

    case "confirm":
      if (["oui", "ok", "yes", "parfait", "c'est bon", "confirm_yes"].includes(lower)) {
        updateUser(phone, {
          conversation_state: "active",
          contract_type: convData.contractType,
          work_mode: convData.workMode,
          languages: JSON.stringify(convData.languages || []),
        });

        // Launch job search
        setTimeout(() => triggerJobSearch(phone), 2000);

        return UI.buttons(
          "🚀 *C'est parti !*\n\nJe cherche les premières offres...\n\nChaque matin vous recevrez les nouvelles offres.\nRépondez *postuler [numéro]* pour candidater.\n\n_Essai gratuit : 7 jours_\n\n📊 Souhaitez-vous aussi une *analyse du marché* ?\n(Salaires médians par ville, compétences demandées, conseils de négociation)",
          [
            { id: "market_yes", title: "📊 Oui, j'en veux" },
            { id: "market_no", title: "⏭️ Non merci" },
          ]
        );
      }
      if (lower === "modifier" || lower === "confirm_modify") {
        updateUser(phone, { conversation_state: "asking_city" });
        return "📍 *Dans quelle ville êtes-vous ?*";
      }
      return "Répondez *oui* ou *modifier*.";

    // ============================================
    // ÉTAT ACTIF : réception d'offres et candidature
    // ============================================
    case "active":
      if (!isSubscriptionActive(user)) {
        updateUser(phone, { conversation_state: "payment_needed" });
        return UI.Messages.trialExpired();
      }

      // Voir une offre
      if (/^[0-9]+$/.test(lower)) {
        const job = getJob(parseInt(lower));
        if (!job) return `❌ Offre #${lower} non trouvée.`;
        return `📋 *${job.title}*\n🏢 ${job.company}\n📍 ${job.location}\n${job.salary ? "💰 " + job.salary + "\n" : ""}🔗 ${job.url}\n\n👉 Répondez *postuler ${job.id}* pour candidater.`;
      }

      // Relancer une candidature par email (J+7)
      if (lower.startsWith("relancer ")) {
        const appId = parseInt(lower.replace("relancer ", ""));
        const app = getApplication(appId);
        if (!app) return "❌ Candidature #" + appId + " non trouvée.";
        if (!app.email_sent_to) return `❌ Pas d'email de contact pour cette candidature — relance manuelle nécessaire.`;
        try {
          await sendFollowUpEmail({
            to: app.email_sent_to,
            jobTitle: app.job_title,
            company: app.company,
            userName: user.name,
          });
          updateApplicationStatus(appId, "followed_up");
          return `✅ Email de relance envoyé à *${app.email_sent_to}* pour *${app.job_title}* chez *${app.company}*.`;
        } catch (e) {
          console.error("Follow-up email error:", e);
          return "❌ Erreur lors de l'envoi de la relance. Vérifiez la config SMTP.";
        }
      }

      // Postuler
      if (lower.startsWith("postuler ")) {
        if (!checkRateLimit(phone, 3)) return "⚠️ Limite d'appels IA atteinte aujourd'hui (candidature = 3 crédits). Réessayez demain.";
        const jobId = parseInt(lower.replace("postuler ", ""));
        const job = getJob(jobId);
        if (!job) return "❌ Offre non trouvée.";

        try {
          const profile = convData.profile || { name: user.name, job_title: user.target_job_title, skills: [], experience_years: 0, education: "", experiences: [] };

          // 0. Détecter si le CV doit être traduit
          const neededLang = detectCVLanguageNeeded(job.location || "", job.company || "", user.cv_language || "fr");

          if (neededLang && !convData.translationHandled) {
            // Stocker le job en attente et demander à l'utilisateur
            convData.pendingTranslationJobId = jobId;
            convData.pendingTranslationLang = neededLang;
            updateUser(phone, { conversation_state: "asking_translation", conversation_data: JSON.stringify(convData) });

            return UI.buttons(
              `🌍 Cette offre est à *${job.location}*.\n\nVotre CV est en *${langCodeToName(user.cv_language || "fr")}*. Pour maximiser vos chances, je peux le traduire en *${targetLangName(neededLang)}* automatiquement.\n\nLa lettre de motivation sera également rédigée en ${targetLangName(neededLang)}.`,
              [
                { id: "translate_yes", title: "✅ Traduire" },
                { id: "translate_no", title: "📄 Garder en " + langCodeToName(user.cv_language || "fr") },
              ]
            );
          }

          // 1. Analyser l'offre pour extraire les instructions de candidature.
          // Court-circuit si France Travail a déjà fourni l'email ou l'URL de candidature
          // directement dans le scraper — évite un appel Claude web_search inutile (~0,05€).
          let jobAnalysis = null;
          const hasDirectContact = job.contact_email || job.apply_url;
          if (hasDirectContact) {
            jobAnalysis = {
              apply_method: job.contact_email ? "email" : "formulaire",
              apply_email: job.contact_email || null,
              apply_url: job.apply_url || null,
              contact_name: job.contact_name || null,
              required_documents: [
                { type: "CV", format: "PDF" },
                { type: "Lettre de motivation", format: "PDF" },
              ],
            };
          } else if (job.url) {
            try {
              jobAnalysis = await analyzeJobPosting(job.url, job.title, job.company);
            } catch (e) {
              console.error("Job analysis error:", e);
            }
          }

          // 2. Générer la LM formelle (dans la langue cible si traduit)
          const appLang = convData.applicationLang || user.cv_language || "fr";
          const activeProfile = convData.translatedProfile || profile;
          const letterBody = await generateFormalCoverLetter(user.cv_text, activeProfile, job, jobAnalysis);

          // Reset translation flag for next application
          convData.translationHandled = false;

          // 3. Déterminer la méthode de candidature
          let applicationType = "manual";
          let applyEmail = null;
          let emailSubject = null;

          if (jobAnalysis?.apply_email) {
            applicationType = "email";
            applyEmail = jobAnalysis.apply_email;
            // Utiliser l'objet imposé par l'annonce, sinon générer
            emailSubject = jobAnalysis.email_subject
              ? jobAnalysis.email_subject
                  .replace(/Nom/g, user.name.split(" ").pop()?.toUpperCase() || "")
                  .replace(/Prénom/g, user.name.split(" ")[0] || "")
                  .replace(/nom/g, user.name.split(" ").pop()?.toUpperCase() || "")
                  .replace(/prénom/g, user.name.split(" ")[0] || "")
              : generateEmailSubject(job.title, user.name);
          }

          // 4. Stocker toutes les infos en attente de validation
          convData.pendingApplication = {
            jobId: job.id,
            jobTitle: job.title,
            company: job.company,
            location: job.location,
            url: job.url,
            letterBody: letterBody,
            applicationType: applicationType,
            applyEmail: applyEmail,
            emailSubject: emailSubject,
            jobAnalysis: jobAnalysis,
            missingDocs: [],
          };

          // Identifier les documents manquants
          const missingDocs = (jobAnalysis?.required_documents || []).filter(d => {
            const t = d.type.toLowerCase();
            return !t.includes("cv") && !t.includes("lettre") && !t.includes("motivation");
          });
          convData.pendingApplication.missingDocs = missingDocs;

          updateUser(phone, { conversation_state: missingDocs.length > 0 ? "collecting_docs" : "reviewing_letter", conversation_data: JSON.stringify(convData) });

          // 5. Construire le message de briefing
          const langSuffix = appLang !== "fr" ? "_" + appLang.toUpperCase() : "";
          const lmFilename = generateLMFilename(job.title, job.company, user.name) .replace(".pdf", langSuffix + ".pdf");
          const cvFilename = generateCVFilename(job.title, job.company, user.name).replace(".pdf", langSuffix + ".pdf");

          let msg = "";

          // Indication de traduction
          if (appLang !== "fr" && appLang !== (user.cv_language || "fr")) {
            msg += `🌍 *Documents en ${targetLangName(appLang)}* (traduits automatiquement)\n\n`;
          }

          // Briefing de candidature
          if (jobAnalysis) {
            const briefing = formatApplicationBriefing(jobAnalysis, job, user.name);
            if (briefing) msg += briefing;
          }

          // Aperçu des fichiers
          msg += `📎 *Fichiers préparés :*\n`;
          msg += `   ✅ *${cvFilename}*\n`;
          msg += `   ✅ *${lmFilename}*\n\n`;

          // Procédure expliquée à l'utilisateur
          if (jobAnalysis?.process_steps?.length > 0) {
            msg += `ℹ️ *Je vous explique comment ça va se passer :*\n`;
            msg += `Après avoir postulé, ${jobAnalysis.process_steps.slice(1).map(s => s.toLowerCase()).join(", puis ")}.\n\n`;
          }

          // Si documents manquants, demander d'abord
          if (missingDocs.length > 0) {
            msg += `⚠️ *Il me manque des éléments pour compléter votre dossier :*\n`;
            missingDocs.forEach((d, i) => {
              msg += `\n*${i + 1}. ${d.type}*`;
              if (d.note) msg += ` — ${d.note}`;
              msg += `\n_Envoyez le document, un lien LinkedIn, ou tapez les infos._\n`;
            });
            msg += `\nOu tapez *skip* pour postuler sans ces éléments.`;
            return msg;
          }

          // Sinon montrer la LM pour validation
          msg += `📝 *Lettre de motivation :*\n\n---\n\n${letterBody}\n\n---\n\n`;
          msg += `*Cette lettre vous convient ?*\n_(Vous pouvez taper "modifier: vos instructions")_`;

          return UI.Messages.validateLetter(msg);
        } catch (e) {
          console.error("Cover letter error:", e);
          return "❌ Erreur de génération. Réessayez.";
        }
      }

      if (lower === "chercher") {
        // Lancer la recherche et notifier quand c'est terminé (pas de fire-and-forget silencieux)
        sendWhatsApp(phone, "🔍 Recherche lancée... Je vous envoie les offres dans quelques secondes.");
        triggerJobSearch(phone);
        return null; // réponse déjà envoyée via sendWhatsApp
      }

      if (lower === "statut" || lower === "/statut") {
        const { db } = require("./db");
        const trialLeft = getTrialDaysLeft(user);
        const rl = getRateLimitStats(phone);

        const apps = db.prepare(
          "SELECT status, COUNT(*) as n FROM applications WHERE user_id = ? GROUP BY status"
        ).all(user.id);
        const total    = apps.reduce((s, a) => s + a.n, 0);
        const waiting  = apps.find(a => a.status === "sent")?.n || 0;
        const interv   = apps.find(a => a.status === "interview_yes")?.n || 0;
        const relanced = apps.find(a => a.status === "followed_up")?.n || 0;
        const pending  = db.prepare(
          "SELECT COUNT(*) as n FROM jobs WHERE user_id = ? AND status = 'found'"
        ).get(user.id)?.n || 0;

        const price  = process.env.SUBSCRIPTION_PRICE  || "4,99";
        const period = process.env.SUBSCRIPTION_PERIOD || "semaine";

        let subLine = "";
        if (user.subscription_status === "active") {
          subLine = `✅ Abonné — ${price}€/${period}`;
        } else if (user.subscription_status === "cancelling") {
          subLine = `⏳ Résiliation en cours — accès actif jusqu'à fin de période`;
        } else if (user.subscription_status === "trial") {
          subLine = trialLeft > 0
            ? `🎁 Essai gratuit — *${trialLeft} jour${trialLeft > 1 ? "s" : ""} restant${trialLeft > 1 ? "s" : ""}*`
            : "⏰ Essai expiré — tapez *payer* pour continuer";
        } else {
          subLine = "❌ Abonnement expiré — tapez *payer*";
        }

        let msg = `📊 *Tableau de bord*\n\n`;
        msg += `👤 ${user.name}\n`;
        msg += `💼 ${user.target_job_title || "—"}\n`;
        msg += `📍 ${JSON.parse(user.target_cities || "[]").join(", ") || "—"}\n\n`;
        msg += `━━━━━━━━━━━━━━━\n`;
        msg += `💳 ${subLine}\n`;
        msg += `━━━━━━━━━━━━━━━\n\n`;
        msg += `📬 *Candidatures :*\n`;
        msg += `   Total : *${total}*\n`;
        if (waiting)  msg += `   ⏳ En attente : ${waiting}\n`;
        if (interv)   msg += `   🎉 Entretiens : ${interv}\n`;
        if (relanced) msg += `   📩 Relancées : ${relanced}\n`;
        msg += `\n🔍 Offres en attente : *${pending}*\n`;
        msg += `⚡ Crédits IA : *${rl.calls}/${rl.limit}* aujourd'hui\n\n`;
        msg += `_*/tableau* pour le détail complet_`;

        return msg;
      }

      if (lower === "/modifier" || lower === "modifier mes critères" || lower === "modifier mes criteres") {
        return UI.buttons(
          "⚙️ *Que souhaitez-vous modifier ?*",
          [
            { id: "modify_city",     title: "📍 Ville(s)" },
            { id: "modify_contract", title: "📄 Type de contrat" },
            { id: "modify_workmode", title: "🏠 Mode de travail" },
          ]
        );
      }

      if (lower === "modify_city") {
        updateUser(phone, { conversation_state: "modifying_city" });
        const current = JSON.parse(user.target_cities || "[]").join(", ") || "—";
        return `📍 *Villes actuelles :* ${current}\n\nEntrez la ou les nouvelles villes :\n_Ex: Paris, Lyon_`;
      }

      if (lower === "modify_contract") {
        updateUser(phone, { conversation_state: "modifying_contract" });
        return UI.Messages.askContract ? UI.Messages.askContract() :
          `📄 *Contrat actuel :* ${user.contract_type || "—"}\n\nQuel type de contrat maintenant ?\n_CDI, CDD, Freelance, Alternance..._`;
      }

      if (lower === "modify_workmode") {
        updateUser(phone, { conversation_state: "modifying_workmode" });
        return UI.Messages.askWorkMode ? UI.Messages.askWorkMode() :
          `🏠 *Mode actuel :* ${user.work_mode || "—"}\n\nQuel mode de travail ?\n_Sur site, Hybride, Full remote..._`;
      }

      // Market analysis on demand (button or command)
      if (lower === "market_yes" || lower === "salaire" || lower === "salaires" || lower === "marché" || lower === "marche") {
        if (!checkRateLimit(phone, 3)) return "⚠️ Limite d'appels IA atteinte aujourd'hui (analyse marché = 3 crédits). Réessayez demain.";
        const profile = convData.profile || { job_title: user.target_job_title, skills: [], experience_years: 0 };
        const cities = JSON.parse(user.target_cities || "[]");
        const countries = JSON.parse(user.target_countries || '["France"]');

        try {
          const market = await analyzeMarket(profile, cities, countries, convData.contractType);
          const marketMsg = formatMarketAnalysis(market);
          if (marketMsg) return marketMsg;
          return "❌ Impossible d'obtenir les données de marché. Réessayez plus tard.";
        } catch (e) {
          console.error("Market analysis error:", e);
          return "❌ Erreur d'analyse. Réessayez.";
        }
      }

      if (lower === "market_no") {
        return "👍 Pas de souci ! Tapez *salaire* à tout moment si vous changez d'avis.";
      }

      // === Feedback responses ===
      if (lower === "feedback_good" || lower === "👍" || lower.includes("pertinente")) {
        const lastJobs = getLastSentJobs(user.id, 5);
        if (lastJobs.length > 0) {
          saveFeedback(lastJobs.map(j => j.id), "relevant");
        }
        return "👍 Merci ! Je continue sur cette lancée.";
      }

      if (lower === "feedback_ok" || lower === "😐" || lower.includes("moyenne")) {
        const lastJobs = getLastSentJobs(user.id, 5);
        if (lastJobs.length > 0) {
          saveFeedback(lastJobs.map(j => j.id), "partially_relevant");
        }
        return UI.list(
          "😐 Noté. Qu'est-ce qui n'allait pas ?",
          "Préciser",
          [{
            title: "Problème rencontré",
            items: [
              { id: "fb_too_senior", title: "Trop senior", description: "Les postes demandent plus d'expérience" },
              { id: "fb_too_junior", title: "Trop junior", description: "En dessous de mon niveau" },
              { id: "fb_wrong_sector", title: "Mauvais secteur", description: "Pas mon domaine" },
              { id: "fb_wrong_location", title: "Mauvaise localisation", description: "Trop loin ou pas la bonne ville" },
              { id: "fb_wrong_salary", title: "Salaire trop bas", description: "En dessous de mes attentes" },
            ],
          }]
        );
      }

      if (lower === "feedback_bad" || lower === "👎" || lower.includes("pas pertinente")) {
        const lastJobs = getLastSentJobs(user.id, 5);
        if (lastJobs.length > 0) {
          saveFeedback(lastJobs.map(j => j.id), "not_relevant");
          // buildMatchingContext() lit depuis la DB à chaque recherche — pas besoin de stocker dans convData
        }
        return "👎 Désolé ! Dites-moi ce qui n'allait pas pour que j'améliore :\n\n_Ex: \"trop de postes seniors\" ou \"je cherche plutôt dans le marketing\" ou \"les offres à Lyon ne m'intéressent plus\"_";
      }

      // Handle detailed feedback reasons
      if (["fb_too_senior", "fb_too_junior", "fb_wrong_sector", "fb_wrong_location", "fb_wrong_salary"].includes(lower)) {
        const feedbackMap = {
          fb_too_senior: "too_senior",
          fb_too_junior: "too_junior",
          fb_wrong_sector: "wrong_sector",
          fb_wrong_location: "wrong_location",
          fb_wrong_salary: "wrong_salary",
        };
        const lastJobs = getLastSentJobs(user.id, 5);
        if (lastJobs.length > 0) {
          saveFeedback(lastJobs.map(j => j.id), feedbackMap[lower]);
        }

        const responses = {
          fb_too_senior: "📝 Noté — je vais chercher des postes plus adaptés à votre niveau d'expérience.",
          fb_too_junior: "📝 Noté — je vais cibler des postes plus seniors.",
          fb_wrong_sector: "📝 Noté — quel secteur préférez-vous ? (tapez votre réponse)",
          fb_wrong_location: "📝 Noté — je vais mieux cibler vos villes. Envoyez *modifier* pour mettre à jour.",
          fb_wrong_salary: "📝 Noté — je vais filtrer les offres avec un salaire plus élevé.",
        };

        return responses[lower] + "\n\n_Votre feedback est pris en compte pour les prochaines recherches._";
      }

      // === Interview recap responses (from Wednesday recap) ===

      // "entretien 2" — user got an interview for application #2
      if (lower.startsWith("entretien ")) {
        if (!checkRateLimit(phone, 2)) return "⚠️ Limite d'appels IA atteinte aujourd'hui. Réessayez demain.";
        const num = parseInt(lower.replace("entretien ", ""));
        const recapApps = convData.pendingRecapApps || [];
        const match = recapApps.find(a => a.index === num);

        if (!match) {
          // Try direct app ID
          const app = getApplication(num);
          if (!app) return "❌ Numéro non trouvé. Utilisez le numéro de la liste (ex: *entretien 1*).";

          updateApplicationStatus(num, "interview_yes");
          try {
            const profile = convData.profile || { name: user.name, job_title: user.target_job_title, skills: [], experience_years: 0, education: "", experiences: [] };
            const prep = await generateInterviewPrep(user.cv_text, profile, app);
            const prepMsg = formatInterviewPrep(prep, app.job_title, app.company);
            if (prepMsg) return `🎉 *Félicitations pour l'entretien chez ${app.company} !*\n\n${prepMsg}`;
          } catch (e) { console.error("Interview prep error:", e); }
          return `🎉 *Félicitations pour l'entretien chez ${app.company} !*`;
        }

        updateApplicationStatus(match.appId, "interview_yes");
        try {
          const app = getApplication(match.appId);
          const profile = convData.profile || { name: user.name, job_title: user.target_job_title, skills: [], experience_years: 0, education: "", experiences: [] };
          const prep = await generateInterviewPrep(user.cv_text, profile, app);
          const prepMsg = formatInterviewPrep(prep, match.jobTitle, match.company);
          if (prepMsg) return `🎉 *Félicitations pour l'entretien chez ${match.company} !*\n\nVoici votre guide de préparation :\n\n${prepMsg}`;
        } catch (e) {
          console.error("Interview prep error:", e);
        }
        return `🎉 *Félicitations pour l'entretien chez ${match.company} !*\n\n❌ Erreur lors de la génération du guide. Retapez *entretien ${num}* pour réessayer.`;
      }

      // "refus 1" — rejection for application #1
      if (lower.startsWith("refus ")) {
        const num = parseInt(lower.replace("refus ", ""));
        const recapApps = convData.pendingRecapApps || [];
        const match = recapApps.find(a => a.index === num);
        const appId = match ? match.appId : num;
        const company = match ? match.company : "cette entreprise";

        updateApplicationStatus(appId, "rejected");
        return `😔 Refus de *${company}* noté. C'est le jeu — ne vous découragez pas, je continue à chercher chaque jour ! 💪`;
      }

      // "rien" — no news on any application
      if (lower === "rien" || lower === "aucune" || lower === "pas de nouvelles" || lower === "non") {
        return "👍 Pas de souci, c'est normal ! Les recruteurs prennent souvent 1-2 semaines. Je vous refais le point mercredi prochain.";
      }

      return "🤖 Répondez avec un *numéro* pour voir une offre, *postuler [numéro]* pour candidater, ou *chercher*.";

    // ============================================
    // TRADUCTION DU CV POUR OFFRE INTERNATIONALE
    // ============================================
    case "asking_translation":
      const targetLang = convData.pendingTranslationLang;
      const translationJobId = convData.pendingTranslationJobId;

      if (lower === "translate_yes" || lower === "oui" || lower.includes("traduire")) {
        // Traduire le CV
        try {
          const profile = convData.profile || {};
          const translatedProfile = await translateCVContent(profile, targetLang);

          if (translatedProfile) {
            convData.translatedProfile = translatedProfile;
            convData.applicationLang = targetLang;
          }

          convData.translationHandled = true;
          delete convData.pendingTranslationLang;
          delete convData.pendingTranslationJobId;
          updateUser(phone, { conversation_state: "active", conversation_data: JSON.stringify(convData) });

          return `✅ CV traduit en *${targetLangName(targetLang)}* !\n\nLa lettre de motivation sera \'{e}galement r\'{e}dig\'{e}e en ${targetLangName(targetLang)}.\n\n_Tapez *postuler ${translationJobId}* pour continuer._`;
        } catch (e) {
          console.error("Translation error:", e);
          convData.translationHandled = true;
          updateUser(phone, { conversation_state: "active", conversation_data: JSON.stringify(convData) });
          return `❌ Erreur de traduction. Je continue avec votre CV en ${langCodeToName(user.cv_language || "fr")}.\n\n_Tapez *postuler ${translationJobId}* pour continuer._`;
        }
      }

      if (lower === "translate_no" || lower === "non" || lower.includes("garder")) {
        convData.translationHandled = true;
        convData.applicationLang = user.cv_language || "fr";
        delete convData.pendingTranslationLang;
        delete convData.pendingTranslationJobId;
        updateUser(phone, { conversation_state: "active", conversation_data: JSON.stringify(convData) });
        return `👍 CV conserv\'{e} en ${langCodeToName(user.cv_language || "fr")}.\n\n_Tapez *postuler ${translationJobId}* pour continuer._`;
      }

      return UI.buttons(
        `Souhaitez-vous traduire votre CV en *${targetLangName(targetLang)}* ?`,
        [
          { id: "translate_yes", title: "✅ Traduire" },
          { id: "translate_no", title: "📄 Garder l'original" },
        ]
      );

    // ============================================
    // COLLECTE DE DOCUMENTS MANQUANTS
    // ============================================
    case "collecting_docs":
      const pendingDocs = convData.pendingApplication;
      if (!pendingDocs) { updateUser(phone, { conversation_state: "active" }); return "❌ Session expirée."; }

      if (lower === "skip" || lower === "passer") {
        // Passer les docs manquants, montrer la LM
        updateUser(phone, { conversation_state: "reviewing_letter", conversation_data: JSON.stringify(convData) });

        const lmFn = generateLMFilename(pendingDocs.jobTitle, pendingDocs.company, user.name);
        const cvFn = generateCVFilename(pendingDocs.jobTitle, pendingDocs.company, user.name);
        let msg = `👍 On continue sans les documents supplémentaires.\n\n`;
        msg += `📎 *${cvFn}*\n📎 *${lmFn}*\n`;
        if (pendingDocs.emailSubject) msg += `📧 Objet : *${pendingDocs.emailSubject}*\n`;
        msg += `\n📝 *Lettre de motivation :*\n\n---\n\n${pendingDocs.letterBody}\n\n---\n\n`;
        msg += `*Cette lettre vous convient ?*`;
        return UI.Messages.validateLetter(msg);
      }

      if (lower === "annuler") {
        delete convData.pendingApplication;
        updateUser(phone, { conversation_state: "active", conversation_data: JSON.stringify(convData) });
        return "❌ Candidature annulée.";
      }

      // L'utilisateur envoie un document, un lien, ou du texte comme référence
      if (!pendingDocs.additionalInfo) pendingDocs.additionalInfo = [];
      pendingDocs.additionalInfo.push(body.trim());

      // Check if it's a URL (LinkedIn, etc.)
      const isLink = body.includes("http") || body.includes("linkedin.com") || body.includes("www.");
      const docLabel = isLink ? "🔗 Lien" : "📄 Info";

      updateUser(phone, { conversation_data: JSON.stringify(convData) });

      const remainingDocs = (pendingDocs.missingDocs || []).length - pendingDocs.additionalInfo.length;

      if (remainingDocs > 0) {
        return `${docLabel} reçu ✅\n\nIl reste *${remainingDocs} document(s)* à fournir.\nEnvoyez le suivant ou *skip* pour continuer.`;
      }

      // Tous les docs reçus → passer à la validation LM
      updateUser(phone, { conversation_state: "reviewing_letter", conversation_data: JSON.stringify(convData) });

      const lmFn2 = generateLMFilename(pendingDocs.jobTitle, pendingDocs.company, user.name);
      const cvFn2 = generateCVFilename(pendingDocs.jobTitle, pendingDocs.company, user.name);
      let docMsg = `✅ Tous les documents sont prêts !\n\n`;
      docMsg += `📎 *${cvFn2}*\n📎 *${lmFn2}*\n`;
      if (pendingDocs.emailSubject) docMsg += `📧 Objet : *${pendingDocs.emailSubject}*\n`;
      docMsg += `\n📝 *Lettre de motivation :*\n\n---\n\n${pendingDocs.letterBody}\n\n---\n\n`;
      docMsg += `*Cette lettre vous convient ?*`;
      return UI.Messages.validateLetter(docMsg);

    // ============================================
    // VALIDATION DE LA LETTRE DE MOTIVATION
    // ============================================
    case "reviewing_letter":
      const pending = convData.pendingApplication;
      if (!pending) { updateUser(phone, { conversation_state: "active" }); return "❌ Session expirée. Réessayez *postuler [numéro]*."; }

      // Annuler
      if (lower === "annuler" || lower === "cancel" || lower === "letter_cancel") {
        delete convData.pendingApplication;
        updateUser(phone, { conversation_state: "active", conversation_data: JSON.stringify(convData) });
        return "❌ Candidature annulée. Envoyez un autre *postuler [numéro]* quand vous voulez.";
      }

      // Modifier
      if (lower === "letter_modify" || lower.startsWith("modifier:") || lower.startsWith("modifier :") || lower.startsWith("ajouter:") || lower.startsWith("ajouter :")) {
        // If they clicked the "Modifier" button, ask for instructions
        if (lower === "letter_modify") {
          return "✏️ Quelles modifications souhaitez-vous ?\n\n_Ex: \"ajouter que je parle anglais couramment\" ou \"raccourcir le 2ème paragraphe\"_";
        }
        const instructions = body.replace(/^(modifier|ajouter)\s*:\s*/i, "").trim();
        try {
          const newLetter = await modifyCoverLetter(pending.letterBody, instructions);
          pending.letterBody = newLetter;
          updateUser(phone, { conversation_data: JSON.stringify(convData) });

          let msg = `✏️ *Lettre modifiée :*\n\n---\n\n${newLetter}\n\n---\n\n`;
          msg += `*OK maintenant ?*\n✅ *oui* | ✏️ *modifier: ...* | ❌ *annuler*`;
          return msg;
        } catch (e) {
          return "❌ Erreur de modification. Réessayez.";
        }
      }

      // Valider et envoyer
      if (["oui", "ok", "yes", "envoyer", "parfait", "c'est bon", "go", "letter_ok"].includes(lower)) {
        try {
          const job = getJob(pending.jobId);
          const filename = generateLMFilename(pending.jobTitle, pending.company, user.name);

          // Générer le PDF
          const pdfBuffer = await createCoverLetterPDF({
            userName: user.name,
            userEmail: convData.profile?.email,
            userPhone: convData.profile?.phone,
            date: null,
            company: pending.company,
            companyAddress: pending.location,
            jobTitle: pending.jobTitle,
            body: pending.letterBody,
          });

          const lmFilename = generateLMFilename(pending.jobTitle, pending.company, user.name);
          const cvFilename = generateCVFilename(pending.jobTitle, pending.company, user.name);
          const emailTo = pending.applyEmail || job?.contact_email;
          const emailSubjectFinal = pending.emailSubject || generateEmailSubject(pending.jobTitle, user.name);

          if (pending.applicationType === "email" && emailTo) {
            // === CANDIDATURE AUTOMATIQUE PAR EMAIL ===
            await sendApplicationEmail({
              to: emailTo,
              jobTitle: pending.jobTitle,
              company: pending.company,
              userName: user.name,
              coverLetterPDF: pdfBuffer,
              coverLetterFilename: lmFilename,
              cvBuffer: null,
              cvFilename: cvFilename,
              customSubject: emailSubjectFinal,
              additionalInfo: pending.additionalInfo,
            });

            let confirmMsg = `✅ *Candidature envoyée à ${pending.company} !*\n\n`;
            confirmMsg += `📧 Email envoyé à : ${emailTo}\n`;
            confirmMsg += `📎 Pièces jointes :\n   • *${cvFilename}*\n   • *${lmFilename}*\n`;
            if (pending.additionalInfo?.length > 0) {
              confirmMsg += `   • Documents supplémentaires joints\n`;
            }
            confirmMsg += `📧 Objet : *${emailSubjectFinal}*\n\n`;

            // Procédure
            if (pending.jobAnalysis?.process_steps?.length > 1) {
              confirmMsg += `📌 *Prochaines étapes :*\n`;
              pending.jobAnalysis.process_steps.slice(1).forEach((s, i) => {
                confirmMsg += `   ${i + 1}. ${s}\n`;
              });
              confirmMsg += `\n`;
            }

            // Store job info for followup question
            convData.lastAppliedJobId = pending.jobId;
            convData.lastAppliedCompany = pending.company;
            convData.lastAppliedTitle = pending.jobTitle;
            convData.lastAppliedEmail = emailTo;
            convData.lastApplicationId = saveApplication(user.id, pending.jobId, pending.letterBody, emailTo);
            markJobApplied(pending.jobId);
            delete convData.pendingApplication;
            updateUser(phone, { conversation_state: "asking_followup", conversation_data: JSON.stringify(convData) });

            confirmMsg += `🔄 *Souhaitez-vous que je relance automatiquement dans 7 jours si pas de réponse ?*`;

            return UI.buttons(
              confirmMsg,
              [
                { id: "followup_yes", title: "✅ Oui, relancer" },
                { id: "followup_no", title: "❌ Non merci" },
                { id: "followup_later", title: "🔔 Me redemander" },
              ]
            );
          } else {
            // === CANDIDATURE MANUELLE (via le site) ===
            let msg = `✅ *Candidature préparée pour ${pending.company} !*\n\n`;
            msg += `📌 *Poste :* ${pending.jobTitle}\n`;
            msg += `🔗 *Postulez ici :* ${pending.url}\n\n`;
            msg += `📎 *Fichiers à joindre :*\n`;
            msg += `   • *${cvFilename}*\n`;
            msg += `   • *${lmFilename}*\n\n`;
            msg += `📧 *Objet du mail :*\n${emailSubjectFinal}\n\n`;
            msg += `👉 *Étapes :*\n`;
            msg += `1. Ouvrez le lien\n`;
            msg += `2. Cliquez "Postuler"\n`;
            msg += `3. Joignez les fichiers ci-dessus\n`;
            msg += `4. Utilisez l'objet indiqué\n\n`;

            if (pending.jobAnalysis?.process_steps?.length > 1) {
              msg += `📌 *Après votre candidature :*\n`;
              pending.jobAnalysis.process_steps.slice(1).forEach((s, i) => {
                msg += `   ${i + 1}. ${s}\n`;
              });
              msg += `\n`;
            }

            // Store job info for followup question
            convData.lastAppliedJobId = pending.jobId;
            convData.lastAppliedCompany = pending.company;
            convData.lastAppliedTitle = pending.jobTitle;
            convData.lastApplicationId = saveApplication(user.id, pending.jobId, pending.letterBody, null);
            markJobApplied(pending.jobId);
            delete convData.pendingApplication;
            updateUser(phone, { conversation_state: "asking_followup", conversation_data: JSON.stringify(convData) });

            msg += `🔄 *Souhaitez-vous que je vous relance dans 7 jours pour savoir si vous avez eu une réponse ?*`;

            return UI.buttons(
              msg,
              [
                { id: "followup_yes", title: "✅ Oui, relancer" },
                { id: "followup_no", title: "❌ Non merci" },
                { id: "followup_later", title: "🔔 Me redemander" },
              ]
            );
          }
        } catch (e) {
          console.error("Send application error:", e);
          return "❌ Erreur d'envoi. Réessayez avec *oui*.";
        }
      }

      return "Répondez *oui* pour envoyer, *modifier: [instructions]* pour changer, ou *annuler*.";

    // ============================================
    // CHOIX DE RELANCE APRÈS CANDIDATURE
    // ============================================
    case "asking_followup":
      const appliedCompany = convData.lastAppliedCompany || "l'entreprise";
      const appliedTitle = convData.lastAppliedTitle || "le poste";

      if (lower === "followup_yes" || lower === "oui" || lower.includes("relancer")) {
        // Persiste la date de relance en base → le CRON la détecte, pas de setTimeout perdu
        if (convData.lastApplicationId) {
          const followupDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          updateApplicationFollowup(convData.lastApplicationId, followupDate);
        }
        updateUser(phone, { conversation_state: "active", conversation_data: JSON.stringify(convData) });
        return `✅ Noté ! Je vous relancerai dans 7 jours pour savoir si *${appliedCompany}* a répondu.\n\n🤖 En attendant, je continue à chercher des offres pour vous.`;
      }

      if (lower === "followup_no" || lower === "non") {
        updateUser(phone, { conversation_state: "active", conversation_data: JSON.stringify(convData) });
        return `👍 Pas de relance pour *${appliedCompany}*. Vous pouvez toujours taper *statut* pour voir vos candidatures.\n\n🤖 Je continue à chercher des offres.`;
      }

      if (lower === "followup_later" || lower.includes("redemander") || lower.includes("plus tard")) {
        // Mark to ask again in 5 days instead of 7
        updateUser(phone, { conversation_state: "active", conversation_data: JSON.stringify(convData) });
        return `🔔 OK, je vous redemanderai dans quelques jours si vous souhaitez relancer *${appliedCompany}*.\n\n🤖 Je continue à chercher des offres.`;
      }

      return UI.buttons(
        `🔄 Relance pour *${appliedTitle}* chez *${appliedCompany}* ?`,
        [
          { id: "followup_yes", title: "✅ Oui, relancer" },
          { id: "followup_no", title: "❌ Non merci" },
          { id: "followup_later", title: "🔔 Me redemander" },
        ]
      );

    case "updating_cv":
      if (mediaUrl && mediaType && mediaType.includes("pdf")) {
        try {
          if (!checkRateLimit(phone, 2)) {
            updateUser(phone, { conversation_state: "active" });
            return "⚠️ Limite d'appels IA atteinte aujourd'hui. Réessayez demain.";
          }
          const pdfResp = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
          });
          const pdfData = await pdfParse(Buffer.from(pdfResp.data));
          if (!pdfData.text || pdfData.text.length < 50) {
            return "❌ CV illisible. Envoyez un PDF avec du texte (pas un scan image).";
          }
          const newProfile = await parseCV(pdfData.text);
          // Mettre à jour le profil dans convData ET les champs utilisateur
          const convData = JSON.parse(user.conversation_data || "{}");
          convData.profile = newProfile;
          updateUser(phone, {
            name: newProfile.name || user.name,
            cv_text: pdfData.text.substring(0, 5000),
            cv_language: newProfile.language,
            target_job_title: newProfile.job_title,
            conversation_state: "active",
            conversation_data: JSON.stringify(convData),
          });
          return `✅ *CV mis à jour !*\n\n` +
            `👤 ${newProfile.name}\n` +
            `💼 ${newProfile.job_title}\n` +
            `📅 ${newProfile.experience_years} ans d'expérience\n\n` +
            `_La prochaine recherche utilisera votre nouveau profil._`;
        } catch (e) {
          console.error("CV update error:", e);
          updateUser(phone, { conversation_state: "active" });
          return "❌ Erreur lors de la lecture du CV. Réessayez.";
        }
      }
      if (body) {
        // L'utilisateur a tapé du texte au lieu d'envoyer un PDF
        return "📎 Envoyez votre CV en **PDF** (pas de texte). Ou tapez *annuler* pour revenir.";
      }
      if (lower === "annuler") {
        updateUser(phone, { conversation_state: "active" });
        return "↩️ Mise à jour annulée.";
      }
      return "📎 En attente de votre CV en PDF...";

    case "modifying_city":
      if (body.trim()) {
        const cities = body.split(/[,;]+/).map(c => c.trim()).filter(Boolean);
        updateUser(phone, {
          target_cities: JSON.stringify(cities),
          conversation_state: "active",
        });
        return `✅ *Villes mises à jour :* ${cities.join(", ")}\n\n_La prochaine recherche utilisera ces nouvelles villes._`;
      }
      return "Entrez une ou plusieurs villes séparées par des virgules.";

    case "modifying_contract":
      if (body.trim()) {
        updateUser(phone, { contract_type: body.trim(), conversation_state: "active" });
        return `✅ *Type de contrat mis à jour :* ${body.trim()}`;
      }
      return "Entrez le type de contrat (CDI, CDD, Freelance...).";

    case "modifying_workmode":
      if (body.trim()) {
        updateUser(phone, { work_mode: body.trim(), conversation_state: "active" });
        return `✅ *Mode de travail mis à jour :* ${body.trim()}`;
      }
      return "Entrez le mode de travail (Sur site, Hybride, Full remote...).";

    case "confirming_delete":
      if (lower === "delete_confirm" || lower === "oui" || lower.includes("confirme")) {
        const deleted = deleteUser(phone);
        // Ne pas appeler updateUser après — le user n'existe plus en base
        if (deleted) {
          return "✅ *Vos données ont été supprimées.* Merci d'avoir utilisé JobBot.\n\n_Si vous souhaitez revenir, envoyez simplement un message._";
        }
        return "❌ Erreur lors de la suppression. Contactez le support.";
      }
      if (lower === "delete_cancel" || lower === "annuler" || lower.includes("annul")) {
        updateUser(phone, { conversation_state: "active" });
        return "↩️ Suppression annulée. Vos données sont conservées.";
      }
      return UI.buttons(
        "*Confirmez-vous la suppression définitive de vos données ?*",
        [
          { id: "delete_confirm", title: "🗑️ Oui, tout supprimer" },
          { id: "delete_cancel",  title: "↩️ Annuler" },
        ]
      );

    case "payment_needed":
      if (lower === "payer") {
        const link = `${process.env.BASE_URL}/pay/${phone.replace("whatsapp:", "").replace("+", "")}`;
        return `💳 Lien de paiement sécurisé :\n${link}\n\n14,99€/mois — sans engagement.`;
      }
      return "⏰ Envoyez *payer* pour continuer (14,99€/mois).";

    default:
      updateUser(phone, { conversation_state: "welcome" });
      return handleMessage(phone, body, mediaUrl, mediaType);
  }
}

// === Recherche planifiée ===
async function triggerJobSearch(phone) {
  const { sendWhatsApp } = require("./server");
  const user = getUser(phone);
  if (!user || !user.cv_text) return;

  const convData = JSON.parse(user.conversation_data || "{}");
  const profile = convData.profile || { job_title: user.target_job_title, skills: [], experience_years: 0 };

  // Contexte feedback structuré — une seule source de vérité, lu depuis la DB
  const feedbackContext = buildMatchingContext(user.id);

  try {
    const jobs = await searchAllSources(profile, user);
    if (jobs.length === 0) { sendWhatsApp(phone, "🔍 Pas de nouvelles offres aujourd'hui. Je réessaie demain !"); return; }

    // Batch scoring : 1 appel Claude pour N offres, avec contexte feedback injecté
    const scores = await matchJobsBatch(profile, jobs, feedbackContext);
    jobs.forEach((job, i) => { job.match_score = scores[i]; });
    saveJobs(user.id, jobs);

    const topJobs = getUnsentJobs(user.id, 5);
    if (topJobs.length === 0) return;

    let msg = `🔥 *${topJobs.length} offres trouvées !*\n\n`;
    topJobs.forEach(j => {
      msg += `*${j.id}.* ${j.title}\n   🏢 ${j.company} — 📍 ${j.location}\n   ${j.salary ? "💰 " + j.salary + "\n" : ""}   🔗 ${j.url}\n\n`;
      markJobSent(j.id);
    });
    msg += `_*postuler [numéro]* pour candidater_`;

    await sendWhatsApp(phone, msg);

    // Send feedback question after a short delay
    setTimeout(async () => {
      const feedbackMsg = UI.buttons(
        "📝 *Ces offres étaient pertinentes ?*\n\nVotre feedback améliore les prochaines recherches.",
        [
          { id: "feedback_good", title: "👍 Pertinentes" },
          { id: "feedback_ok", title: "😐 Moyennes" },
          { id: "feedback_bad", title: "👎 Pas pertinentes" },
        ]
      );
      await sendWhatsApp(phone, feedbackMsg);
    }, 5000);
  } catch (e) {
    console.error("Search error:", e);
  }
}

// === Helpers ===
function guessCountry(city) {
  const c = city.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const cityMap = {
    // France
    "paris": "France", "lyon": "France", "marseille": "France", "bordeaux": "France", "toulouse": "France",
    "lille": "France", "nantes": "France", "strasbourg": "France", "montpellier": "France", "nice": "France",
    "rennes": "France", "grenoble": "France", "rouen": "France", "toulon": "France", "dijon": "France",
    // Belgique
    "bruxelles": "Belgique", "anvers": "Belgique", "gand": "Belgique", "liege": "Belgique", "charleroi": "Belgique", "namur": "Belgique",
    // Suisse
    "geneve": "Suisse", "lausanne": "Suisse", "zurich": "Suisse", "berne": "Suisse", "bale": "Suisse",
    // Luxembourg
    "luxembourg": "Luxembourg",
    // Canada
    "montreal": "Canada", "quebec": "Canada", "toronto": "Canada", "vancouver": "Canada", "ottawa": "Canada",
    // Allemagne
    "berlin": "Allemagne", "munich": "Allemagne", "francfort": "Allemagne", "hambourg": "Allemagne",
    // UK
    "londres": "Royaume-Uni", "london": "Royaume-Uni", "manchester": "Royaume-Uni", "birmingham": "Royaume-Uni",
    // Espagne
    "madrid": "Espagne", "barcelone": "Espagne", "valence": "Espagne",
    // Italie
    "rome": "Italie", "milan": "Italie", "turin": "Italie",
    // Maroc
    "casablanca": "Maroc", "rabat": "Maroc", "marrakech": "Maroc", "tanger": "Maroc", "fes": "Maroc",
    // Tunisie
    "tunis": "Tunisie", "sfax": "Tunisie", "sousse": "Tunisie",
    // Algérie
    "alger": "Algérie", "oran": "Algérie", "constantine": "Algérie",
    // Sénégal
    "dakar": "Sénégal", "thies": "Sénégal",
    // Côte d'Ivoire
    "abidjan": "Côte d'Ivoire", "yamoussoukro": "Côte d'Ivoire",
    // Cameroun
    "douala": "Cameroun", "yaounde": "Cameroun",
    // Gabon
    "libreville": "Gabon",
    // Congo
    "brazzaville": "Congo", "pointe-noire": "Congo",
    // RDC
    "kinshasa": "RDC", "lubumbashi": "RDC",
    // Mali
    "bamako": "Mali",
    // Burkina Faso
    "ouagadougou": "Burkina Faso",
    // Guinée
    "conakry": "Guinée",
    // Togo
    "lome": "Togo",
    // Bénin
    "cotonou": "Bénin", "porto-novo": "Bénin",
    // Niger
    "niamey": "Niger",
    // Tchad
    "ndjamena": "Tchad",
    // Madagascar
    "antananarivo": "Madagascar", "tananarive": "Madagascar",
    // Maurice
    "port-louis": "Maurice",
    // Liban
    "beyrouth": "Liban", "beirut": "Liban",
    // EAU
    "dubai": "Émirats Arabes Unis", "abu dhabi": "Émirats Arabes Unis",
    // USA
    "new york": "USA", "san francisco": "USA", "los angeles": "USA", "chicago": "USA",
    // Singapour
    "singapour": "Singapour", "singapore": "Singapour",
    // Japon
    "tokyo": "Japon", "osaka": "Japon",
    // Australie
    "sydney": "Australie", "melbourne": "Australie",
  };

  for (const [ville, pays] of Object.entries(cityMap)) {
    if (c.includes(ville)) return pays;
  }
  return "France";
}

function countryToLanguage(country) {
  const map = {
    // Francophone
    france: "fr", belgique: "fr", suisse: "fr", canada: "fr", luxembourg: "fr",
    maroc: "fr", tunisie: "fr", algerie: "fr",
    senegal: "fr", "cote d'ivoire": "fr", cameroun: "fr", mali: "fr",
    "burkina faso": "fr", guinee: "fr", togo: "fr", benin: "fr", niger: "fr",
    gabon: "fr", congo: "fr", rdc: "fr", tchad: "fr", centrafrique: "fr",
    madagascar: "fr", comores: "fr", maurice: "fr", liban: "fr",
    // Anglophone
    "royaume-uni": "en", uk: "en", usa: "en", "etats-unis": "en",
    irlande: "en", australie: "en", "nouvelle-zelande": "en",
    singapour: "en", inde: "en",
    // Germanophone
    allemagne: "de", autriche: "de",
    // Autres
    espagne: "es", mexique: "es",
    italie: "it",
    "pays-bas": "nl",
    portugal: "pt", bresil: "pt",
    japon: "ja", chine: "zh",
    // Arabe
    "emirats arabes unis": "ar", qatar: "ar", "arabie saoudite": "ar",
  };
  const key = country.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return map[key] || null;
}

function langCodeToName(code) {
  return {
    fr: "français", en: "anglais", de: "allemand", es: "espagnol",
    it: "italien", nl: "néerlandais", pt: "portugais", ar: "arabe",
    ja: "japonais", zh: "chinois",
  }[code] || code;
}

module.exports = { handleMessage, triggerJobSearch };
