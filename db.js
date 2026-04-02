const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "jobbot.db"));

// Enable WAL mode for better performance
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    cv_text TEXT,
    cv_language TEXT,
    target_cities TEXT,         -- JSON array: ["Paris", "Lyon"]
    target_countries TEXT,      -- JSON array: ["France", "Belgique"]
    international_mobile INTEGER DEFAULT 0,
    target_salary TEXT,
    target_job_title TEXT,
    target_sectors TEXT,        -- JSON array: ["tech", "marketing"]
    contract_type TEXT,         -- "CDI", "CDD", "Freelance", "Tous types", or free text
    work_mode TEXT,             -- "Sur site", "Hybride", "Full remote", "Peu importe", or free text
    weekend_silent INTEGER DEFAULT 1,  -- 1 = pas de notifs le weekend, 0 = notifs 7j/7
    languages TEXT,             -- JSON array: [{"lang":"français","cv_provided":true}]
    conversation_state TEXT DEFAULT 'welcome',
    conversation_data TEXT,     -- JSON temp data during onboarding
    subscription_status TEXT DEFAULT 'trial',  -- trial, active, expired, cancelled
    trial_start TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    applications_sent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT,
    company TEXT,
    location TEXT,
    url TEXT,
    source TEXT,
    salary TEXT,
    description_summary TEXT,
    match_score INTEGER,
    status TEXT DEFAULT 'found',  -- found, sent, applied, rejected, interview
    expires_at TEXT,              -- date d'expiration de l'offre
    expiry_notified INTEGER DEFAULT 0,  -- 1 si notification envoyée
    feedback TEXT,               -- "relevant", "not_relevant", "too_senior", "too_junior", "wrong_location"
    contact_email TEXT,          -- email de candidature directe (France Travail)
    contact_name TEXT,           -- nom du recruteur si disponible
    apply_url TEXT,              -- URL de candidature directe (urlPostulation FT)
    sent_at TEXT,
    applied_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    job_id INTEGER,
    cover_letter TEXT,
    email_sent_to TEXT,
    status TEXT DEFAULT 'sent',  -- sent, interview_asked, interview_yes, interview_no, followed_up
    interview_check_sent INTEGER DEFAULT 0,  -- 1 si on a demandé à l'user
    sent_at TEXT DEFAULT (datetime('now')),
    followup_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    direction TEXT,  -- in, out
    body TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migrations idempotentes — ignorées si la colonne existe déjà
const migrations = [
  "ALTER TABLE users ADD COLUMN paused_until TEXT",
  "ALTER TABLE users ADD COLUMN daily_api_calls INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN daily_api_date TEXT",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* colonne déjà présente */ }
}

// === User helpers ===

function getUser(phone) {
  return db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
}

function createUser(phone) {
  db.prepare("INSERT OR IGNORE INTO users (phone, trial_start) VALUES (?, datetime('now'))").run(phone);
  return getUser(phone);
}

function updateUser(phone, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(", ");
  const values = Object.values(fields);
  db.prepare(`UPDATE users SET ${sets}, updated_at = datetime('now') WHERE phone = ?`).run(...values, phone);
}

// === Job helpers ===

function saveJobs(userId, jobs) {
  const stmt = db.prepare(
    "INSERT INTO jobs (user_id, title, company, location, url, source, salary, description_summary, match_score, expires_at, contact_email, contact_name, apply_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertMany = db.transaction((jobList) => {
    for (const j of jobList) {
      stmt.run(
        userId, j.title, j.company, j.location, j.url, j.source,
        j.salary, j.description_summary, j.match_score, j.expires_at || null,
        j.contact_email || null, j.contact_name || null, j.apply_url || null
      );
    }
  });
  insertMany(jobs);
}

function getUnsentJobs(userId, limit = 5) {
  return db.prepare("SELECT * FROM jobs WHERE user_id = ? AND status = 'found' ORDER BY match_score DESC LIMIT ?").all(userId, limit);
}

function markJobSent(jobId) {
  db.prepare("UPDATE jobs SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(jobId);
}

function markJobApplied(jobId) {
  db.prepare("UPDATE jobs SET status = 'applied', applied_at = datetime('now') WHERE id = ?").run(jobId);
}

function getJob(jobId) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
}

/**
 * Récupère les offres qui expirent dans les X prochains jours
 * et qui n'ont pas encore été notifiées et pas encore postulées
 */
function getExpiringJobs(withinDays = 2) {
  return db.prepare(`
    SELECT jobs.*, users.phone 
    FROM jobs 
    JOIN users ON jobs.user_id = users.id
    WHERE jobs.expires_at IS NOT NULL
      AND jobs.expires_at <= datetime('now', '+' || ? || ' days')
      AND jobs.expires_at > datetime('now')
      AND jobs.expiry_notified = 0
      AND jobs.status IN ('found', 'sent')
      AND users.conversation_state = 'active'
    ORDER BY jobs.expires_at ASC
  `).all(withinDays);
}

function markExpiryNotified(jobId) {
  db.prepare("UPDATE jobs SET expiry_notified = 1 WHERE id = ?").run(jobId);
}

/**
 * Offres qui expirent dans moins de 24h ET que l'utilisateur n'a pas encore vues
 * (status = 'found' = trouvées mais pas encore envoyées).
 * Distinctes du CRON 18h qui gère les offres déjà envoyées.
 */
function getUrgentUnseenJobs() {
  return db.prepare(`
    SELECT jobs.*, users.phone, users.weekend_silent
    FROM jobs
    JOIN users ON jobs.user_id = users.id
    WHERE jobs.expires_at IS NOT NULL
      AND jobs.expires_at <= datetime('now', '+24 hours')
      AND jobs.expires_at > datetime('now')
      AND jobs.expiry_notified = 0
      AND jobs.status = 'found'
      AND users.conversation_state = 'active'
    ORDER BY jobs.expires_at ASC
  `).all();
}

/**
 * Statistiques de la semaine écoulée pour le bilan du lundi.
 */
function getWeeklyStats(userId) {
  const jobsFound = db.prepare(`
    SELECT COUNT(*) as n FROM jobs
    WHERE user_id = ? AND created_at >= datetime('now', '-7 days')
  `).get(userId)?.n || 0;

  const appsSent = db.prepare(`
    SELECT COUNT(*) as n FROM applications
    WHERE user_id = ? AND sent_at >= datetime('now', '-7 days')
  `).get(userId)?.n || 0;

  const appsPending = db.prepare(`
    SELECT COUNT(*) as n FROM applications
    WHERE user_id = ? AND status = 'sent'
  `).get(userId)?.n || 0;

  const interviews = db.prepare(`
    SELECT COUNT(*) as n FROM applications
    WHERE user_id = ? AND status = 'interview_yes'
  `).get(userId)?.n || 0;

  return { jobsFound, appsSent, appsPending, interviews };
}

/**
 * Récupère les offres expirées non postulées (pour stats)
 */
function getExpiredJobs(userId) {
  return db.prepare(`
    SELECT * FROM jobs 
    WHERE user_id = ? 
      AND expires_at IS NOT NULL 
      AND expires_at < datetime('now') 
      AND status IN ('found', 'sent')
  `).all(userId);
}

/**
 * Enregistre le feedback utilisateur sur un lot d'offres
 */
function saveFeedback(jobIds, feedbackType) {
  const stmt = db.prepare("UPDATE jobs SET feedback = ? WHERE id = ?");
  const update = db.transaction((ids) => {
    for (const id of ids) {
      stmt.run(feedbackType, id);
    }
  });
  update(jobIds);
}

/**
 * Construit un contexte de feedback structuré pour améliorer le matching.
 * Une seule source de vérité — lu depuis la DB à chaque recherche.
 * Retourne une string prête à injecter dans le prompt, ou "" si pas de feedback.
 */
function buildMatchingContext(userId) {
  const rows = db.prepare(`
    SELECT feedback, COUNT(*) as count, GROUP_CONCAT(title, '|||') as titles
    FROM jobs
    WHERE user_id = ? AND feedback IS NOT NULL
    GROUP BY feedback
  `).all(userId);

  if (!rows.length) return "";

  const byType = {};
  for (const r of rows) {
    byType[r.feedback] = {
      count: r.count,
      titles: r.titles ? [...new Set(r.titles.split("|||").slice(0, 8))] : [],
    };
  }

  const lines = [];

  if (byType.not_relevant) {
    lines.push(`- L'utilisateur a rejeté ${byType.not_relevant.count} offre(s) comme non pertinentes (ex: ${byType.not_relevant.titles.slice(0, 3).join(", ")}). Pénalise fortement les offres similaires.`);
  }
  if (byType.too_senior) {
    lines.push(`- Les offres jugées "trop seniors" ont été rejetées ${byType.too_senior.count} fois. Privilégie les postes correspondant au niveau d'expérience réel du profil.`);
  }
  if (byType.too_junior) {
    lines.push(`- Les offres jugées "trop junior" ont été rejetées ${byType.too_junior.count} fois. Privilégie les postes seniors ou à responsabilités.`);
  }
  if (byType.wrong_sector) {
    lines.push(`- ${byType.wrong_sector.count} offre(s) rejetées pour mauvais secteur. Reste strictement dans le domaine du profil.`);
  }
  if (byType.wrong_location) {
    lines.push(`- ${byType.wrong_location.count} offre(s) rejetées pour mauvaise localisation. Respecte scrupuleusement les villes cibles.`);
  }
  if (byType.wrong_salary) {
    lines.push(`- ${byType.wrong_salary.count} offre(s) rejetées pour salaire insuffisant. Pénalise les offres sans salaire indiqué ou manifestement sous le marché.`);
  }
  if (byType.relevant) {
    lines.push(`- ${byType.relevant.count} offre(s) jugées pertinentes (positif). Favorise ce type de profil d'offre.`);
  }

  return lines.length
    ? "\n\nCONTEXTE FEEDBACK UTILISATEUR (à intégrer dans le scoring) :\n" + lines.join("\n")
    : "";
}

/**
 * Stats de feedback — conservé pour l'affichage dans /statut
 */
function getFeedbackStats(userId) {
  return db.prepare(`
    SELECT feedback, COUNT(*) as count
    FROM jobs
    WHERE user_id = ? AND feedback IS NOT NULL
    GROUP BY feedback
  `).all(userId);
}

/**
 * Récupère les dernières offres envoyées (pour le feedback)
 */
function getLastSentJobs(userId, limit = 5) {
  return db.prepare(`
    SELECT * FROM jobs 
    WHERE user_id = ? AND status = 'sent' AND feedback IS NULL
    ORDER BY sent_at DESC LIMIT ?
  `).all(userId, limit);
}

// === Application helpers ===

function saveApplication(userId, jobId, coverLetter, email) {
  const result = db.prepare(
    "INSERT INTO applications (user_id, job_id, cover_letter, email_sent_to) VALUES (?, ?, ?, ?)"
  ).run(userId, jobId, coverLetter, email);
  return result.lastInsertRowid; // Nécessaire pour stocker l'ID et planifier la relance
}

/**
 * Enregistre la date de relance souhaitée par l'utilisateur (J+7 après confirmation)
 */
function updateApplicationFollowup(applicationId, followupAt) {
  db.prepare("UPDATE applications SET followup_at = ? WHERE id = ?").run(followupAt, applicationId);
}

/**
 * Candidatures dont la relance est due et pas encore envoyée
 */
function getPendingFollowups() {
  return db.prepare(`
    SELECT applications.*, jobs.title as job_title, jobs.company, jobs.url,
           users.phone, users.name, users.weekend_silent
    FROM applications
    JOIN jobs ON applications.job_id = jobs.id
    JOIN users ON applications.user_id = users.id
    WHERE applications.followup_at IS NOT NULL
      AND applications.followup_at <= datetime('now')
      AND applications.status = 'sent'
      AND applications.interview_check_sent = 0
      AND users.conversation_state = 'active'
    ORDER BY applications.followup_at ASC
  `).all();
}

/**
 * Récupère les candidatures envoyées il y a 5 jours sans réponse
 * pour demander si l'utilisateur a eu un entretien
 */
function getApplicationsToCheckInterview() {
  return db.prepare(`
    SELECT applications.*, jobs.title as job_title, jobs.company, jobs.location,
           jobs.description_summary, users.phone, users.name, users.cv_text
    FROM applications
    JOIN jobs ON applications.job_id = jobs.id
    JOIN users ON applications.user_id = users.id
    WHERE applications.interview_check_sent = 0
      AND applications.sent_at <= datetime('now', '-7 days')
      AND applications.status = 'sent'
      AND users.conversation_state = 'active'
    ORDER BY applications.sent_at ASC
  `).all();
}

function markInterviewCheckSent(applicationId) {
  db.prepare("UPDATE applications SET interview_check_sent = 1, status = 'interview_asked' WHERE id = ?").run(applicationId);
}

function updateApplicationStatus(applicationId, status) {
  db.prepare("UPDATE applications SET status = ? WHERE id = ?").run(status, applicationId);
}

function getApplication(applicationId) {
  return db.prepare(`
    SELECT applications.*, jobs.title as job_title, jobs.company, jobs.location,
           jobs.description_summary
    FROM applications
    JOIN jobs ON applications.job_id = jobs.id
    WHERE applications.id = ?
  `).get(applicationId);
}

// === Message helpers ===

function saveMessage(userId, direction, body) {
  db.prepare("INSERT INTO messages (user_id, direction, body) VALUES (?, ?, ?)").run(userId, direction, body);
}

// === Subscription helpers ===

function isSubscriptionActive(user) {
  if (user.subscription_status === "active") return true;
  if (user.subscription_status === "trial" && user.trial_start) {
    const trialDays = parseInt(process.env.TRIAL_DAYS || "7");
    const trialEnd = new Date(user.trial_start);
    trialEnd.setDate(trialEnd.getDate() + trialDays);
    return new Date() < trialEnd;
  }
  return false;
}

function getTrialDaysLeft(user) {
  if (!user.trial_start) return 0;
  const trialDays = parseInt(process.env.TRIAL_DAYS || "7");
  const trialEnd = new Date(user.trial_start);
  trialEnd.setDate(trialEnd.getDate() + trialDays);
  const diff = trialEnd - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function getAllActiveUsers() {
  return db.prepare("SELECT * FROM users WHERE conversation_state = 'active'").all();
}

// === Rate limiting ===

const DAILY_API_LIMIT = 30; // appels Claude max par user par jour

/**
 * Vérifie si l'utilisateur est sous la limite et incrémente le compteur.
 * Retourne true si l'appel est autorisé, false s'il faut bloquer.
 * Le compteur se réinitialise chaque jour automatiquement.
 */
function checkRateLimit(phone, cost = 1) {
  const user = db.prepare("SELECT daily_api_calls, daily_api_date FROM users WHERE phone = ?").get(phone);
  if (!user) return true;

  const today = new Date().toISOString().slice(0, 10);
  const isNewDay = user.daily_api_date !== today;
  const currentCalls = isNewDay ? 0 : (user.daily_api_calls || 0);

  if (currentCalls + cost > DAILY_API_LIMIT) return false;

  db.prepare("UPDATE users SET daily_api_calls = ?, daily_api_date = ? WHERE phone = ?")
    .run(currentCalls + cost, today, phone);
  return true;
}

function getRateLimitStats(phone) {
  const user = db.prepare("SELECT daily_api_calls, daily_api_date FROM users WHERE phone = ?").get(phone);
  if (!user) return { calls: 0, limit: DAILY_API_LIMIT, remaining: DAILY_API_LIMIT };
  const today = new Date().toISOString().slice(0, 10);
  const calls = user.daily_api_date === today ? (user.daily_api_calls || 0) : 0;
  return { calls, limit: DAILY_API_LIMIT, remaining: DAILY_API_LIMIT - calls };
}

// === Auto-resume ===

/**
 * Retourne les users en pause dont la date de fin est passée
 */
function getUsersToAutoResume() {
  return db.prepare(`
    SELECT * FROM users
    WHERE conversation_state = 'paused'
      AND paused_until IS NOT NULL
      AND paused_until <= datetime('now')
  `).all();
}

/**
 * Supprime toutes les données d'un utilisateur (RGPD droit à l'effacement).
 * Supprime en cascade : messages, applications, jobs, puis le user.
 */
function deleteUser(phone) {
  const user = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (!user) return false;
  const del = db.transaction(() => {
    db.prepare("DELETE FROM messages     WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM applications WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM jobs         WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM users        WHERE id = ?").run(user.id);
  });
  del();
  return true;
}

module.exports = {
  db, getUser, createUser, updateUser,
  saveJobs, getUnsentJobs, markJobSent, markJobApplied, getJob,
  getExpiringJobs, markExpiryNotified, getExpiredJobs, getUrgentUnseenJobs, getWeeklyStats,
  saveFeedback, getFeedbackStats, buildMatchingContext, getLastSentJobs,
  saveApplication, updateApplicationFollowup, getPendingFollowups,
  saveMessage,
  getApplicationsToCheckInterview, markInterviewCheckSent, updateApplicationStatus, getApplication,
  isSubscriptionActive, getTrialDaysLeft, getAllActiveUsers,
  checkRateLimit, getRateLimitStats,
  getUsersToAutoResume,
  deleteUser,
};
