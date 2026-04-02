require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cron = require("node-cron");
const crypto = require("crypto");
const { handleMessage, triggerJobSearch } = require("./conversation");
const { getAllActiveUsers, updateUser, getUser, getExpiringJobs, markExpiryNotified, getApplicationsToCheckInterview, markInterviewCheckSent, getUsersToAutoResume, getUrgentUnseenJobs, getWeeklyStats } = require("./db");
const UI = require("./whatsapp-ui");

const app = express();
const PORT = process.env.PORT || 3000;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── Middleware ───────────────────────────────────────

app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Twilio WhatsApp Webhook ─────────────────────────

app.post("/webhook/whatsapp", async (req, res) => {
  // Valide que la requête vient bien de Twilio — prévient les appels forgés
  const signature = req.headers["x-twilio-signature"];
  const url = `${process.env.BASE_URL}/webhook/whatsapp`;
  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN, signature, url, req.body
  );
  if (!isValid) {
    console.warn("[SECURITY] Invalid Twilio signature — request rejected");
    return res.status(403).send("Forbidden");
  }

  try {
    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || "0");

    let mediaUrl = null;
    let mediaType = null;

    if (numMedia > 0) {
      mediaUrl = req.body.MediaUrl0;
      mediaType = req.body.MediaContentType0;
    }

    // Parse interactive response (button click or list selection)
    const parsed = UI.parseInteractiveResponse(req.body);
    const body = parsed.id || parsed.text || "";

    console.log(`[MSG] ${from}: ${body} (type: ${parsed.type}) ${mediaUrl ? "(+media)" : ""}`);

    const reply = await handleMessage(from, body, mediaUrl, mediaType);

    // Reply can be a string OR a structured message object
    if (typeof reply === "string") {
      // Simple text → use TwiML
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      res.type("text/xml").send(twiml.toString());
    } else if (reply && reply.type) {
      // Structured message (buttons, list) → send via API, respond empty TwiML
      res.type("text/xml").send("<Response></Response>");
      await UI.sendMessage(from, reply);
    } else {
      res.type("text/xml").send("<Response></Response>");
    }
  } catch (error) {
    console.error("Webhook error:", error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("❌ Une erreur est survenue. Réessayez dans quelques instants.");
    res.type("text/xml").send(twiml.toString());
  }
});

// ─── Stripe Payment Page ─────────────────────────────

app.get("/pay/:phone", async (req, res) => {
  const phone = "whatsapp:+" + req.params.phone;
  const user = getUser(phone);

  if (!user) {
    return res.send("Utilisateur non trouvé. Commencez par envoyer un message au bot.");
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.BASE_URL}/payment-success?phone=${encodeURIComponent(phone)}`,
      cancel_url:  `${process.env.BASE_URL}/payment-cancel`,
      metadata: { phone },
      subscription_data: { metadata: { phone } },
    });
    res.redirect(303, session.url);
  } catch (e) {
    console.error("Stripe error:", e);
    res.send("Erreur de paiement. Réessayez plus tard.");
  }
});

app.get("/payment-success", async (req, res) => {
  const phone = req.query.phone;
  if (phone) {
    // Récupérer l'ID de subscription depuis la session pour pouvoir annuler plus tard
    try {
      const sessions = await stripe.checkout.sessions.list({ limit: 5 });
      const session  = sessions.data.find(s => s.metadata?.phone === phone && s.subscription);
      if (session?.subscription) {
        updateUser(phone, {
          subscription_status: "active",
          stripe_subscription_id: session.subscription,
        });
      } else {
        updateUser(phone, { subscription_status: "active" });
      }
    } catch (_) {
      updateUser(phone, { subscription_status: "active" });
    }
    const price = process.env.SUBSCRIPTION_PRICE || "4,99";
    const period = process.env.SUBSCRIPTION_PERIOD || "semaine";
    sendWhatsApp(phone,
      `✅ *Paiement reçu !* Votre abonnement est actif.\n\n` +
      `💳 ${price}€/${period} — renouvelé automatiquement.\n\n` +
      `Pour annuler avant le prochain renouvellement, tapez */annuler*.\n\n` +
      `🤖 Je cherche des offres pour vous dès demain matin !`
    );
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
      <h1>✅ Paiement réussi !</h1>
      <p>Retournez sur WhatsApp, le bot est maintenant actif.</p>
      <p style="color:#666;font-size:.9rem">Tapez <strong>/annuler</strong> à tout moment pour résilier avant le prochain renouvellement.</p>
    </body></html>
  `);
});

// Route d'annulation — fin de période en cours, pas de remboursement immédiat
app.get("/cancel-subscription/:token", async (req, res) => {
  const parts = req.params.token.split("-");
  const sig   = parts.pop();
  const raw   = parts.join("-");
  const expected = crypto.createHmac("sha256", DASH_SECRET).update("cancel:" + raw).digest("hex").slice(0, 8);
  if (sig !== expected) return res.status(403).send("Lien invalide.");

  const phone = `whatsapp:+${raw}`;
  const user  = getUser(phone);
  if (!user) return res.status(404).send("Utilisateur non trouvé.");

  try {
    if (user.stripe_subscription_id) {
      // cancel_at_period_end : l'accès reste actif jusqu'à la fin de la semaine payée
      await stripe.subscriptions.update(user.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    }
    updateUser(phone, { subscription_status: "cancelling" });
    sendWhatsApp(phone,
      "✅ *Résiliation confirmée.*\n\n" +
      "Votre accès reste actif jusqu'à la fin de la période en cours.\n" +
      "Aucun prélèvement ne sera effectué ensuite.\n\n" +
      "_Si vous changez d'avis, tapez *reprendre abonnement* avant la fin de période._"
    );
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
        <h1>✅ Résiliation prise en compte</h1>
        <p>Votre accès reste actif jusqu'à la fin de la période payée.</p>
      </body></html>
    `);
  } catch (e) {
    console.error("Cancel error:", e);
    res.send("Erreur lors de la résiliation. Contactez le support.");
  }
});

app.get("/payment-cancel", (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
      <h1>❌ Paiement annulé</h1>
      <p>Retournez sur WhatsApp et envoyez "payer" pour réessayer.</p>
    </body></html>
  `);
});

// ─── Stripe Webhook (subscription events) ─────────────

app.post("/stripe-webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error("Stripe webhook error:", e.message);
    return res.status(400).send("Webhook Error");
  }

  switch (event.type) {
    case "customer.subscription.deleted":
    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const phone = subscription.metadata?.phone;
      if (phone) {
        const status = subscription.status === "active" ? "active" : "expired";
        updateUser(phone, { subscription_status: status });
        if (status === "expired") {
          sendWhatsApp(phone, "⚠️ Votre abonnement a expiré. Envoyez *payer* pour le renouveler.");
        }
      }
      break;
    }

    case "invoice.payment_failed": {
      // Paiement échoué (carte expirée, fonds insuffisants, etc.)
      // Stripe réessaie automatiquement, mais on prévient l'utilisateur pour qu'il régularise
      const invoice = event.data.object;
      const phone = invoice.subscription_details?.metadata?.phone
        || invoice.metadata?.phone;
      if (phone) {
        const user = getUser(phone);
        const payLink = user
          ? `${process.env.BASE_URL}/pay/${phone.replace("whatsapp:", "").replace("+", "")}`
          : null;
        const msg = "❌ *Échec du paiement de votre abonnement JobBot.*\n\n" +
          "Votre carte a été refusée (expirée, fonds insuffisants ou autre).\n\n" +
          (payLink
            ? `👉 Mettez à jour votre moyen de paiement :\n${payLink}\n\n`
            : "") +
          "_Stripe retentera le prélèvement dans 3 jours. Sans régularisation, votre accès sera suspendu._";
        sendWhatsApp(phone, msg);
      }
      break;
    }
  }

  res.json({ received: true });
});

// ─── Cron Jobs ───────────────────────────────────────

// Every morning at 8am: search jobs for active users (respects weekend preference)
cron.schedule("0 8 * * *", async () => {
  const isWeekend = [0, 6].includes(new Date().getDay()); // 0=dimanche, 6=samedi

  // Ne traiter que les abonnés actifs (trial valide ou abonnement Stripe actif)
  const { isSubscriptionActive } = require("./db");
  const users = getAllActiveUsers().filter((u) => isSubscriptionActive(u));

  console.log(`[CRON] Morning search — ${users.length} users actifs ${isWeekend ? "(weekend)" : "(weekday)"}`);

  let processed = 0;
  for (const user of users) {
    if (isWeekend && user.weekend_silent === 1) {
      console.log(`[CRON] Skip ${user.phone} (weekend silent)`);
      continue;
    }

    try {
      await triggerJobSearch(user.phone);
      processed++;
      // 2 s entre chaque user pour lisser les appels API et éviter les rate limits Anthropic.
      // triggerJobSearch fait désormais 1 seul appel de matching (batch) au lieu de N,
      // donc le risque de burst est concentré ici entre users, pas à l'intérieur.
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[CRON] Error for ${user.phone}:`, e.message);
    }
  }
  console.log(`[CRON] Done — ${processed}/${users.length} users traités`);
});

// Every evening at 6pm (including weekends — expiry is urgent):
cron.schedule("0 18 * * *", async () => {
  console.log("[CRON] Checking expiring job offers...");
  const expiringJobs = getExpiringJobs(2); // Offers expiring within 2 days

  // Group by user phone
  const byUser = {};
  for (const job of expiringJobs) {
    if (!byUser[job.phone]) byUser[job.phone] = [];
    byUser[job.phone].push(job);
  }

  for (const [phone, jobs] of Object.entries(byUser)) {
    let msg = `⏰ *Attention — ${jobs.length} offre${jobs.length > 1 ? "s" : ""} expire${jobs.length > 1 ? "nt" : ""} bientôt !*\n\n`;

    for (const job of jobs) {
      const expiresDate = new Date(job.expires_at);
      const now = new Date();
      const hoursLeft = Math.max(0, Math.round((expiresDate - now) / 3600000));
      const daysLeft = Math.ceil(hoursLeft / 24);

      const urgency = daysLeft <= 1 ? "🔴" : "🟡";

      msg += `${urgency} *${job.title}*\n`;
      msg += `   🏢 ${job.company} — 📍 ${job.location}\n`;
      msg += `   ⏳ Expire dans *${daysLeft <= 1 ? hoursLeft + "h" : daysLeft + " jour(s)"}*\n`;
      msg += `   👉 *postuler ${job.id}*\n\n`;

      markExpiryNotified(job.id);
    }

    msg += `_Ne laissez pas passer ces opportunités !_`;

    try {
      await sendWhatsApp(phone, msg);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[CRON] Expiry notification error for ${phone}:`, e);
    }
  }

  console.log(`[CRON] Expiry check done: ${expiringJobs.length} offers notified`);
});

// Toutes les 2h : notification immédiate pour les offres non vues expirant dans < 24h.
// Complémentaire du CRON 18h (offres déjà envoyées, < 2 jours).
// Cible status='found' : l'utilisateur n'a pas encore vu l'offre → urgence maximale.
cron.schedule("0 */2 * * *", async () => {
  const urgent = getUrgentUnseenJobs();
  if (urgent.length === 0) return;
  console.log(`[CRON] Urgent unseen — ${urgent.length} offre(s)`);

  const byUser = {};
  for (const job of urgent) {
    if (!byUser[job.phone]) byUser[job.phone] = [];
    byUser[job.phone].push(job);
  }

  for (const [phone, jobs] of Object.entries(byUser)) {
    try {
      let msg = `🚨 *${jobs.length === 1 ? "Une offre expire" : `${jobs.length} offres expirent`} dans moins de 24h !*\n\n`;
      for (const job of jobs) {
        const hoursLeft = Math.max(1, Math.round((new Date(job.expires_at) - Date.now()) / 3600000));
        msg += `🔴 *${job.title}*\n`;
        msg += `   🏢 ${job.company} — 📍 ${job.location}\n`;
        msg += `   ⏳ Expire dans *${hoursLeft}h*\n`;
        msg += `   👉 *postuler ${job.id}*\n\n`;
        markExpiryNotified(job.id);
      }
      msg += `_Candidatez maintenant avant qu'il soit trop tard !_`;
      await sendWhatsApp(phone, msg);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[CRON] Urgent alert error for ${phone}:`, e.message);
    }
  }
});

// Chaque lundi à 9h : bilan hebdomadaire personnalisé.
cron.schedule("0 9 * * 1", async () => {
  const { isSubscriptionActive } = require("./db");
  const users = getAllActiveUsers().filter((u) => isSubscriptionActive(u));
  console.log(`[CRON] Weekly summary — ${users.length} users`);

  for (const user of users) {
    try {
      const stats = getWeeklyStats(user.id);
      if (stats.jobsFound === 0 && stats.appsSent === 0) continue;

      let msg = `📊 *Bilan de la semaine — ${user.name?.split(" ")[0] || "Bonjour"} !*\n\n`;
      msg += `🔍 *${stats.jobsFound}* offre${stats.jobsFound > 1 ? "s" : ""} trouvée${stats.jobsFound > 1 ? "s" : ""}\n`;
      msg += `📨 *${stats.appsSent}* candidature${stats.appsSent > 1 ? "s" : ""} envoyée${stats.appsSent > 1 ? "s" : ""}\n`;
      msg += `⏳ *${stats.appsPending}* en attente de réponse\n`;
      if (stats.interviews > 0) {
        msg += `🎉 *${stats.interviews}* entretien${stats.interviews > 1 ? "s" : ""} décroché${stats.interviews > 1 ? "s" : ""} !\n`;
      }
      msg += `\n`;
      if (stats.appsPending > 0) msg += `_Pour relancer : *relancer [id]*_\n`;
      if (stats.jobsFound > 0 && stats.appsSent === 0) msg += `_Des offres vous attendent ! Tapez *chercher* pour les voir._\n`;
      msg += `\n_Bonne semaine ! Je continue à chercher pour vous. 💪_`;

      await sendWhatsApp(user.phone, msg);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[CRON] Weekly summary error for ${user.phone}:`, e.message);
    }
  }
  console.log(`[CRON] Weekly summary done`);
});

// Every morning at 9am: send follow-up messages for applications where user confirmed J+7 relance.
// Ces relances sont persistées en base (followup_at) — aucun risque de perte au redémarrage.
cron.schedule("0 9 * * *", async () => {
  const { getPendingFollowups } = require("./db");
  const isWeekend = [0, 6].includes(new Date().getDay());
  const pending = getPendingFollowups();
  console.log(`[CRON] Followup check — ${pending.length} relance(s) dues`);

  for (const app of pending) {
    if (isWeekend && app.weekend_silent === 1) {
      console.log(`[CRON] Skip followup for ${app.phone} (weekend silent)`);
      continue;
    }
    try {
      const msg =
        `🔔 *Relance — ${app.job_title} chez ${app.company}*\n\n` +
        `Ça fait 7 jours que vous avez postulé. Des nouvelles ?\n\n` +
        `✅ *entretien ${app.id}* — entretien décroché\n` +
        `❌ *refus ${app.id}* — refus reçu\n` +
        `⏭️ *rien* — pas encore de réponse\n\n` +
        `_Pas de réponse ? Répondez *relancer ${app.id}* pour envoyer un email de relance._`;
      await sendWhatsApp(app.phone, msg);
      markInterviewCheckSent(app.id);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[CRON] Followup error for ${app.phone}:`, e.message);
    }
  }
});

// Every day at 10am: check if any applications are 5+ days old, grouped per user
// Respects weekend preference — if silent, shifts to Monday
cron.schedule("0 10 * * *", async () => {
  const isWeekend = [0, 6].includes(new Date().getDay());
  console.log(`[CRON] Application follow-up check ${isWeekend ? "(weekend)" : ""}`);

  const applications = getApplicationsToCheckInterview();
  if (applications.length === 0) return;

  // Group by user phone
  const byUser = {};
  for (const app of applications) {
    if (!byUser[app.phone]) byUser[app.phone] = { apps: [], weekendSilent: false };
    byUser[app.phone].apps.push(app);
  }

  // Get weekend preference for each user
  for (const phone of Object.keys(byUser)) {
    const u = getUser(phone);
    if (u) byUser[phone].weekendSilent = u.weekend_silent === 1;
  }

  for (const [phone, { apps, weekendSilent }] of Object.entries(byUser)) {
    // Skip weekend users — they'll get it Monday
    if (isWeekend && weekendSilent) {
      console.log(`[CRON] Skipping recap for ${phone} (weekend silent — will send Monday)`);
      continue;
    }

    try {
      const daysAgo = (sentAt) => Math.round((Date.now() - new Date(sentAt).getTime()) / 86400000);

      let msg = `📋 *Point sur vos candidatures (${apps.length} en cours)*\n\n`;

      apps.forEach((app, i) => {
        const days = daysAgo(app.sent_at);
        msg += `*${i + 1}.* ${app.job_title} — ${app.company} _(il y a ${days} jours)_\n`;
      });

      msg += `\nDes nouvelles sur l'une d'entre elles ?\n\n`;
      msg += `✅ *entretien [numéro]* — entretien décroché\n`;
      msg += `❌ *refus [numéro]* — refus reçu\n`;
      msg += `⏭️ *rien* — aucune nouvelle\n`;

      // Store app IDs in convData for reference
      const user = getUser(phone);
      if (user) {
        const convData = JSON.parse(user.conversation_data || "{}");
        convData.pendingRecapApps = apps.map((a, i) => ({ index: i + 1, appId: a.id, jobTitle: a.job_title, company: a.company }));
        updateUser(phone, { conversation_data: JSON.stringify(convData) });
      }

      // Mark all as checked
      for (const app of apps) {
        markInterviewCheckSent(app.id);
      }

      await sendWhatsApp(phone, msg);
      await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      console.error(`[CRON] Recap error for ${phone}:`, e);
    }
  }

  console.log(`[CRON] Follow-up check done`);
});

// CRON auto-resume : 6h30 — avant le CRON de recherche de 8h
// Réactive les users dont la pause temporaire (/pause 3 jours) est terminée
cron.schedule("30 6 * * *", async () => {
  const users = getUsersToAutoResume();
  if (users.length === 0) return;
  console.log(`[CRON] Auto-resume — ${users.length} user(s)`);
  for (const u of users) {
    updateUser(u.phone, { conversation_state: "active", paused_until: null });
    await sendWhatsApp(u.phone, "▶️ *Pause terminée !* Je reprends la recherche d'offres pour vous dès ce matin.");
    console.log(`[CRON] Auto-resumed: ${u.phone}`);
  }
});

// ─── Send WhatsApp message (used by CRONs and async processes) ──

async function sendWhatsApp(to, body) {
  try {
    if (typeof body === "string") {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to,
        body,
      });
    } else if (body && body.type) {
      await UI.sendMessage(to, body);
    }
    console.log(`[SENT] ${to}: ${typeof body === "string" ? body.substring(0, 60) : body.type}...`);
  } catch (e) {
    console.error("sendWhatsApp error:", e.message);
  }
}

module.exports = { sendWhatsApp };

// ─── Dashboard ───────────────────────────────────────

const DASH_SECRET = process.env.DASHBOARD_SECRET || "jobbot-dashboard-secret";

function renderDashboard(user, apps) {
  const statusLabel = {
    sent: "⏳ En attente",
    interview_asked: "❓ Réponse demandée",
    interview_yes: "🎉 Entretien",
    followed_up: "📩 Relancé",
    rejected: "❌ Refus",
  };
  const interviews = apps.filter((a) => a.status === "interview_yes").length;
  const pending = apps.filter((a) => ["sent", "followed_up"].includes(a.status)).length;

  const rows = apps.map((a) => `
    <tr>
      <td>${a.job_title || "—"}</td>
      <td>${a.company || "—"}</td>
      <td>${(a.sent_at || "").slice(0, 10)}</td>
      <td>${statusLabel[a.status] || a.status}</td>
      <td>${a.url ? `<a href="${a.url}" target="_blank" rel="noopener">🔗</a>` : "—"}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>JobBot — ${user.name || "Mon compte"}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f5f5f5;color:#222;padding:24px 16px}
    h1{font-size:1.4rem;margin-bottom:4px}
    .sub{color:#666;font-size:.9rem;margin-bottom:20px}
    .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
    .stat{background:#fff;border-radius:10px;padding:16px 20px;flex:1;min-width:100px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}
    .stat strong{display:block;font-size:2rem;font-weight:700}
    .stat span{font-size:.8rem;color:#666}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    th{background:#f0f0f0;padding:12px;text-align:left;font-size:.85rem;color:#555}
    td{padding:12px;border-top:1px solid #eee;font-size:.9rem}
    tr:hover td{background:#fafafa}
    a{color:#4f6ef2;text-decoration:none}
    .empty{text-align:center;color:#999;padding:32px}
  </style>
</head>
<body>
  <h1>📊 ${user.name || "Mon compte"}</h1>
  <p class="sub">💼 ${user.target_job_title || "—"} · ${user.subscription_status === "active" ? "✅ Abonné" : "🔄 Essai gratuit"}</p>
  <div class="stats">
    <div class="stat"><strong>${apps.length}</strong><span>Candidatures</span></div>
    <div class="stat"><strong>${interviews}</strong><span>Entretiens</span></div>
    <div class="stat"><strong>${pending}</strong><span>En attente</span></div>
  </div>
  <table>
    <thead><tr><th>Poste</th><th>Entreprise</th><th>Date</th><th>Statut</th><th>Lien</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="empty">Aucune candidature pour l'instant</td></tr>`}</tbody>
  </table>
</body>
</html>`;
}

app.get("/dashboard/:token", (req, res) => {
  const parts = req.params.token.split("-");
  const sig = parts.pop();
  const raw = parts.join("-"); // préserve les tirets dans le numéro
  const expected = crypto.createHmac("sha256", DASH_SECRET).update(raw).digest("hex").slice(0, 8);
  if (sig !== expected) return res.status(403).send("Lien invalide ou expiré.");

  const phone = `whatsapp:+${raw}`;
  const user = getUser(phone);
  if (!user) return res.status(404).send("Utilisateur non trouvé.");

  const { db } = require("./db");
  const apps = db.prepare(`
    SELECT a.*, j.title as job_title, j.company, j.url
    FROM applications a
    JOIN jobs j ON a.job_id = j.id
    WHERE a.user_id = ?
    ORDER BY a.sent_at DESC
    LIMIT 100
  `).all(user.id);

  res.send(renderDashboard(user, apps));
});

// ─── Health check ────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "JobBot WhatsApp",
    version: "1.0.0",
    uptime: process.uptime(),
  });
});

// ─── Start server ────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🤖 JobBot running on port ${PORT}`);
  console.log(`📱 WhatsApp webhook: ${process.env.BASE_URL}/webhook/whatsapp`);
});
