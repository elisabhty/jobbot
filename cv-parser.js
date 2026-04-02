const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

/**
 * Analyse un CV et retourne un profil structuré
 */
async function parseCV(cvText) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `Analyse ce CV et extrais les informations. Réponds UNIQUEMENT en JSON valide:

CV:
"""
${cvText.substring(0, 5000)}
"""

JSON:
{
  "name": "Prénom Nom",
  "email": "email si visible",
  "phone": "téléphone si visible",
  "language": "fr ou en ou de etc",
  "job_title": "Titre du poste actuel ou recherché",
  "experience_years": nombre,
  "skills": ["compétence 1", "compétence 2"],
  "sectors": ["secteur 1"],
  "education": "Dernier diplôme + établissement",
  "current_location": "Ville si visible",
  "languages_spoken": ["français", "anglais"],
  "experiences": [
    {"title": "titre", "company": "entreprise", "duration": "durée", "highlights": ["réalisation 1", "réalisation 2"]}
  ],
  "summary": "Résumé du profil en 2 phrases"
}`,
      },
    ],
  });

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0].replace(/```json|```/g, "").trim());
  throw new Error("Impossible d'analyser le CV");
}

/**
 * Génère une lettre de motivation DÉTAILLÉE et personnalisée
 */
async function generateCoverLetter(cvText, profile, job, additionalInstructions) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `Rédige une lettre de motivation professionnelle, détaillée et personnalisée. Elle doit être prête à envoyer telle quelle.

=== PROFIL DU CANDIDAT ===
Nom: ${profile.name}
Poste actuel/recherché: ${profile.job_title}
Expérience: ${profile.experience_years} ans
Diplôme: ${profile.education}
Compétences clés: ${profile.skills?.join(", ")}
Expériences:
${(profile.experiences || []).map(e => `- ${e.title} chez ${e.company} (${e.duration}) : ${e.highlights?.join(", ")}`).join("\n")}

=== OFFRE D'EMPLOI ===
Poste: ${job.title}
Entreprise: ${job.company}
Localisation: ${job.location}
Description: ${job.description_summary || "Non disponible"}
${job.salary ? "Salaire: " + job.salary : ""}

${additionalInstructions ? "=== INSTRUCTIONS SUPPLÉMENTAIRES ===\n" + additionalInstructions + "\n" : ""}

=== CONSIGNES DE RÉDACTION ===
- Lettre structurée en 4-5 paragraphes :
  1. Accroche : pourquoi cette entreprise et ce poste spécifiquement
  2. Parcours et expériences pertinentes en lien direct avec le poste
  3. Compétences techniques et réalisations concrètes (chiffres si possible)
  4. Qualités personnelles et soft skills en rapport avec l'équipe/la mission
  5. Conclusion avec disponibilité et ouverture
- Ton professionnel mais naturel (pas de phrases bateau type "je me permets de...")
- Montrer qu'on a compris les enjeux du poste
- Valoriser les expériences en lien avec l'offre
- NE PAS inclure les formules "Madame, Monsieur" ni "Cordialement" (c'est ajouté automatiquement dans le PDF)
- NE PAS inclure la date ni les coordonnées (c'est dans le PDF)

Réponds UNIQUEMENT avec le texte de la lettre (les paragraphes), rien d'autre.`,
      },
    ],
  });

  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

/**
 * Modifie une lettre de motivation existante selon les instructions
 */
async function modifyCoverLetter(currentLetter, instructions) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `Voici une lettre de motivation existante. Modifie-la selon les instructions.

=== LETTRE ACTUELLE ===
${currentLetter}

=== MODIFICATIONS DEMANDÉES ===
${instructions}

=== CONSIGNES ===
- Garde la structure et le ton professionnel
- Intègre les modifications naturellement
- NE PAS ajouter "Madame, Monsieur" ni "Cordialement"
- Réponds UNIQUEMENT avec la lettre modifiée, rien d'autre.`,
      },
    ],
  });

  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

/**
 * Score de matching entre un profil et une offre (usage ponctuel).
 * Pour le scoring en masse, utiliser matchJobsBatch() avec feedbackContext.
 */
async function matchJobToProfile(profile, job) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `Score de pertinence 0-100. JSON uniquement: {"score": nombre, "reason": "raison courte"}

Profil: ${profile.job_title}, ${profile.experience_years} ans, compétences: ${profile.skills?.join(", ")}
Offre: ${job.title} chez ${job.company} à ${job.location}. ${job.description_summary || ""}`,
      },
    ],
  });

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\{[\s\S]*?\}/);
  if (match) return JSON.parse(match[0]).score || 50;
  return 50;
}

/**
 * Message de bienvenue après analyse du CV
 */
function generateWelcomeAfterCV(profile) {
  const langNames = { fr: "français", en: "anglais", de: "allemand", es: "espagnol", ar: "arabe", it: "italien", pt: "portugais", nl: "néerlandais" };
  const detectedLang = langNames[profile.language] || profile.language;

  let msg = `✅ *CV analysé !*\n\n`;
  msg += `👤 ${profile.name}\n`;
  msg += `💼 ${profile.job_title}\n`;
  msg += `📅 ${profile.experience_years} ans d'expérience\n`;
  msg += `🎓 ${profile.education}\n`;
  if (profile.experiences?.length > 0) {
    msg += `🏢 Dernière exp. : ${profile.experiences[0].title} chez ${profile.experiences[0].company}\n`;
  }
  msg += `\n🌐 Je vois que votre CV est en *${detectedLang}*.\n\n`;
  msg += `📍 *Dans quelle ville êtes-vous ?*\n\n`;
  msg += `_(Vous pourrez ensuite préciser votre mobilité)_`;

  return msg;
}

/**
 * Analyse du marché : salaires médians par ville pour le profil
 * Utilise Claude + web search pour obtenir des données à jour
 */
async function analyzeMarket(profile, cities, countries, contractType) {
  const cityList = cities.join(", ");
  const countryList = countries.join(", ");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [
      {
        role: "user",
        content: `Analyse le marché de l'emploi pour ce profil. Cherche des données de salaire récentes et actualisées.

Profil : ${profile.job_title}
Expérience : ${profile.experience_years} ans
Compétences : ${profile.skills?.join(", ")}
Secteur : ${profile.sectors?.join(", ") || "Non précisé"}
Contrat : ${contractType || "CDI"}
Villes ciblées : ${cityList}
Pays : ${countryList}

Cherche sur Glassdoor, Indeed, LinkedIn Salary, Talent.com, et autres sources les salaires pour ce profil dans chaque ville.

Réponds UNIQUEMENT en JSON :
{
  "job_title_market": "Titre du poste tel qu'il apparaît sur le marché",
  "cities": [
    {
      "city": "Paris",
      "country": "France",
      "salary_min": 35000,
      "salary_median": 42000,
      "salary_max": 55000,
      "currency": "EUR",
      "demand": "Forte / Moyenne / Faible",
      "num_offers_approx": 150,
      "top_employers": ["Capgemini", "Sopra Steria", "Accenture"]
    }
  ],
  "skills_in_demand": ["SAP S/4HANA", "Power BI", "Agile"],
  "skills_missing": ["compétence que le candidat n'a pas mais qui est demandée"],
  "market_insight": "Un conseil personnalisé sur le marché pour ce profil (2 phrases max)",
  "salary_tip": "Conseil de négociation salariale (1 phrase)"
}`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0].replace(/```json|```/g, "").trim());
  }
  return null;
}

/**
 * Formate l'analyse du marché en message WhatsApp
 */
function formatMarketAnalysis(market) {
  if (!market) return null;

  let msg = `📊 *Analyse du marché — ${market.job_title_market}*\n\n`;

  // Salaires par ville
  msg += `💰 *Salaires par ville :*\n`;
  for (const city of (market.cities || [])) {
    const currency = city.currency === "EUR" ? "€" : city.currency === "CAD" ? "CAD" : city.currency;
    msg += `\n📍 *${city.city}* (${city.country})\n`;
    msg += `   Min: ${formatSalary(city.salary_min)}${currency}`;
    msg += ` → Médian: *${formatSalary(city.salary_median)}${currency}*`;
    msg += ` → Max: ${formatSalary(city.salary_max)}${currency}\n`;
    msg += `   📈 Demande : ${city.demand}`;
    if (city.num_offers_approx) msg += ` (~${city.num_offers_approx} offres)`;
    msg += `\n`;
    if (city.top_employers?.length > 0) {
      msg += `   🏢 Recrutent : ${city.top_employers.slice(0, 3).join(", ")}\n`;
    }
  }

  // Compétences demandées
  if (market.skills_in_demand?.length > 0) {
    msg += `\n🔥 *Compétences les plus demandées :*\n`;
    msg += `   ${market.skills_in_demand.join(", ")}\n`;
  }

  // Compétences manquantes
  if (market.skills_missing?.length > 0) {
    msg += `\n⚡ *À développer pour booster votre profil :*\n`;
    msg += `   ${market.skills_missing.join(", ")}\n`;
  }

  // Insight
  if (market.market_insight) {
    msg += `\n💡 *Conseil :* ${market.market_insight}\n`;
  }

  // Salary tip
  if (market.salary_tip) {
    msg += `\n🎯 *Négociation :* ${market.salary_tip}`;
  }

  return msg;
}

function formatSalary(num) {
  if (!num) return "?";
  if (num >= 1000) return Math.round(num / 1000) + "K";
  return String(num);
}

/**
 * Génère un guide d'entretien personnalisé
 * 10 questions probables (techniques + soft skills) basées sur le CV et l'offre
 */
async function generateInterviewPrep(cvText, profile, job) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `Tu es un coach d'entretien d'embauche. Génère les 10 questions les plus probables que le recruteur posera pour ce poste.

=== CANDIDAT ===
Nom: ${profile.name}
Poste actuel: ${profile.job_title}
Expérience: ${profile.experience_years} ans
Compétences: ${profile.skills?.join(", ")}
Formation: ${profile.education}
Expériences:
${(profile.experiences || []).map(e => `- ${e.title} chez ${e.company}: ${e.highlights?.join(", ")}`).join("\n")}

=== OFFRE ===
Poste: ${job.job_title || job.title}
Entreprise: ${job.company}
Lieu: ${job.location}
Description: ${job.description_summary || "Non disponible"}

=== CONSIGNES ===
- 5 questions TECHNIQUES liées aux compétences du poste et du CV
- 5 questions SOFT SKILLS / comportementales / motivation
- Pour chaque question, donne un CONSEIL de réponse personnalisé basé sur le CV du candidat
- Sois spécifique au poste et à l'entreprise, pas de questions génériques

Réponds en JSON:
{
  "company_insight": "Ce qu'il faut savoir sur l'entreprise avant l'entretien (2 phrases)",
  "technical_questions": [
    {"question": "la question", "conseil": "comment répondre en valorisant le profil du candidat", "piege": "le piège à éviter"}
  ],
  "soft_questions": [
    {"question": "la question", "conseil": "comment répondre", "piege": "le piège à éviter"}
  ],
  "golden_tip": "Un conseil en or pour cet entretien spécifique"
}`,
      },
    ],
  });

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0].replace(/```json|```/g, "").trim());
  }
  return null;
}

/**
 * Formate le guide d'entretien en message WhatsApp
 */
function formatInterviewPrep(prep, jobTitle, company) {
  if (!prep) return null;

  let msg = `🎯 *Guide d'entretien — ${jobTitle} chez ${company}*\n\n`;

  if (prep.company_insight) {
    msg += `🏢 *À savoir sur ${company} :*\n${prep.company_insight}\n\n`;
  }

  msg += `💻 *Questions techniques probables :*\n\n`;
  (prep.technical_questions || []).forEach((q, i) => {
    msg += `*${i + 1}.* ${q.question}\n`;
    msg += `   ✅ _${q.conseil}_\n`;
    if (q.piege) msg += `   ⚠️ _Piège : ${q.piege}_\n`;
    msg += `\n`;
  });

  msg += `🤝 *Questions comportementales :*\n\n`;
  (prep.soft_questions || []).forEach((q, i) => {
    msg += `*${i + 6}.* ${q.question}\n`;
    msg += `   ✅ _${q.conseil}_\n`;
    if (q.piege) msg += `   ⚠️ _Piège : ${q.piege}_\n`;
    msg += `\n`;
  });

  if (prep.golden_tip) {
    msg += `💡 *Conseil en or :* ${prep.golden_tip}`;
  }

  return msg;
}

/**
 * Analyse une offre d'emploi en détail pour extraire les instructions de candidature
 * Utilise Claude + web search pour lire la page de l'offre
 */
async function analyzeJobPosting(jobUrl, jobTitle, company) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [
      {
        role: "user",
        content: `Va sur cette offre d'emploi et analyse les instructions de candidature en détail : ${jobUrl}

Poste: ${jobTitle}
Entreprise: ${company}

Extrais TOUTES les informations de candidature. Réponds UNIQUEMENT en JSON:
{
  "apply_method": "email ou formulaire ou plateforme",
  "apply_email": "email de candidature si mentionné, sinon null",
  "apply_url": "URL du formulaire si pas par email, sinon null",
  "email_subject": "objet exact du mail si spécifié (respecter le format donné), sinon null",
  "required_documents": [
    {"type": "CV", "format": "PDF ou non précisé", "note": "détail si spécifié"},
    {"type": "Lettre de motivation", "format": "dans le mail ou en PJ", "note": ""},
    {"type": "Références", "format": "3 références anciens managers", "note": "peut être des liens LinkedIn"}
  ],
  "deadline": "date limite au format YYYY-MM-DD si mentionnée, sinon null",
  "deadline_text": "texte original de la date limite",
  "process_steps": ["Étape 1: Envoi du dossier", "Étape 2: Entretien RH", "Étape 3: Test technique"],
  "salary": "salaire si mentionné",
  "contract_type": "CDI/CDD/Stage etc si mentionné",
  "location": "lieu de travail",
  "start_date": "date de début si mentionnée",
  "company_address": "adresse de l'entreprise si visible",
  "contact_name": "nom du recruteur si mentionné",
  "special_instructions": "toute instruction spéciale (ex: mentionner une référence, format spécifique)",
  "lm_in_body": true ou false (true si la LM doit être dans le corps du mail, false si en PJ),
  "description_summary": "résumé du poste en 3 phrases"
}`,
      },
    ],
  });

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0].replace(/```json|```/g, "").trim());
  }
  return null;
}

/**
 * Génère une LM complète avec mise en forme formelle
 * (coordonnées, date, destinataire, objet, formule de politesse, signature)
 */
async function generateFormalCoverLetter(cvText, profile, job, jobAnalysis) {
  const contactName = jobAnalysis?.contact_name || "Madame, Monsieur";
  const companyAddress = jobAnalysis?.company_address || `${job.company}\n${job.location}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `Rédige une lettre de motivation FORMELLE et COMPLÈTE, prête à envoyer.

=== CANDIDAT ===
Nom: ${profile.name}
Email: ${profile.email || ""}
Téléphone: ${profile.phone || ""}
Poste actuel: ${profile.job_title}
Expérience: ${profile.experience_years} ans
Compétences: ${profile.skills?.join(", ")}
Expériences:
${(profile.experiences || []).map(e => `- ${e.title} chez ${e.company}: ${e.highlights?.join(", ")}`).join("\n")}

=== OFFRE ===
Poste: ${job.title}
Entreprise: ${job.company}
Lieu: ${job.location}
Description: ${jobAnalysis?.description_summary || job.description_summary || ""}
${jobAnalysis?.salary ? "Salaire: " + jobAnalysis.salary : ""}

=== DESTINATAIRE ===
${contactName}
${companyAddress}

=== FORMAT REQUIS ===
La lettre doit suivre ce format EXACT:

[Le contenu commence directement par la formule d'appel]

${contactName.includes(",") ? contactName + "," : "Cher/Chère " + contactName + ","}

[Paragraphe 1: Accroche — pourquoi ce poste et cette entreprise vous intéressent]

[Paragraphe 2: Parcours et expériences en lien direct avec le poste]

[Paragraphe 3: Compétences techniques et réalisations concrètes]

[Paragraphe 4: Qualités personnelles et motivation]

[Paragraphe 5: Disponibilité et ouverture]

Dans l'attente de votre retour, je vous prie d'agréer, ${contactName}, l'expression de mes salutations distinguées.

=== CONSIGNES ===
- Lettre détaillée, 4-5 paragraphes
- Ton professionnel mais naturel
- Montrer la connaissance de l'entreprise
- Valoriser les expériences pertinentes
- NE PAS inclure les coordonnées de l'expéditeur ni la date (géré par le PDF)
- INCLURE la formule d'appel et la formule de politesse finale
- NE PAS signer (la signature est dans le PDF)

Réponds UNIQUEMENT avec le texte de la lettre.`,
      },
    ],
  });

  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

/**
 * Formate le briefing de candidature pour l'utilisateur
 */
function formatApplicationBriefing(jobAnalysis, job, userName) {
  if (!jobAnalysis) return null;

  let msg = `📋 *Dossier de candidature — ${job.title}*\n🏢 ${job.company}\n\n`;

  // Documents requis
  const docs = jobAnalysis.required_documents || [];
  if (docs.length > 0) {
    msg += `📎 *Documents requis par l'entreprise :*\n`;
    docs.forEach((d, i) => {
      const t = d.type.toLowerCase();
      const isAuto = t.includes("cv") || t.includes("lettre") || t.includes("motivation");
      if (isAuto) {
        msg += `✅ ${d.type} — _je m'en occupe_`;
      } else {
        msg += `⚠️ ${d.type} — *à fournir par vous*`;
      }
      if (d.format) msg += ` _(${d.format})_`;
      if (d.note) msg += ` — ${d.note}`;
      msg += `\n`;
    });
    msg += `\n`;
  }

  // Méthode de candidature
  if (jobAnalysis.apply_method === "email" && jobAnalysis.apply_email) {
    msg += `📧 *Candidature par email*\n`;
    msg += `   Envoi à : *${jobAnalysis.apply_email}*\n`;
    if (jobAnalysis.email_subject) {
      const subject = jobAnalysis.email_subject
        .replace(/Nom/g, userName.split(" ").pop()?.toUpperCase() || "NOM")
        .replace(/Prénom/g, userName.split(" ")[0] || "Prénom")
        .replace(/nom/g, userName.split(" ").pop()?.toUpperCase() || "NOM")
        .replace(/prénom/g, userName.split(" ")[0] || "Prénom");
      msg += `   Objet : *${subject}*\n`;
    }
    msg += `\n`;
  } else if (jobAnalysis.apply_url) {
    msg += `🔗 *Candidature en ligne*\n`;
    msg += `   ${jobAnalysis.apply_url}\n\n`;
  }

  // Date limite
  if (jobAnalysis.deadline || jobAnalysis.deadline_text) {
    msg += `⏰ *Date limite :* ${jobAnalysis.deadline_text || jobAnalysis.deadline}\n\n`;
  }

  // Instructions spéciales
  if (jobAnalysis.special_instructions) {
    msg += `💡 *Note importante :* ${jobAnalysis.special_instructions}\n\n`;
  }

  return msg;
}

/**
 * Détecte si le CV doit être traduit pour une offre donnée
 * Retourne la langue cible ou null si pas de traduction nécessaire
 */
function detectCVLanguageNeeded(jobLocation, jobCountry, cvLanguage) {
  const locationLower = (jobLocation + " " + (jobCountry || "")).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Mapping pays/ville → langue requise
  const langMap = {
    // Anglophone
    "toronto": "en", "vancouver": "en", "calgary": "en", "ottawa": "en",
    "london": "en", "londres": "en", "manchester": "en", "birmingham": "en",
    "new york": "en", "san francisco": "en", "los angeles": "en", "chicago": "en",
    "sydney": "en", "melbourne": "en", "dublin": "en", "singapore": "en", "singapour": "en",
    "uk": "en", "royaume-uni": "en", "usa": "en", "etats-unis": "en",
    "australie": "en", "australia": "en", "irlande": "en", "inde": "en",
    // Germanophone
    "berlin": "de", "munich": "de", "francfort": "de", "hambourg": "de",
    "zurich": "de", "berne": "de", "vienne": "de",
    "allemagne": "de", "autriche": "de",
    // Hispanophone
    "madrid": "es", "barcelone": "es", "mexico": "es",
    "espagne": "es", "mexique": "es",
    // Lusophone
    "lisbonne": "pt", "sao paulo": "pt", "portugal": "pt", "bresil": "pt",
    // Arabophone
    "dubai": "en", "abu dhabi": "en", "doha": "en", "riyadh": "en",
    // Francophone → pas de traduction
    "paris": null, "lyon": null, "marseille": null, "bordeaux": null,
    "bruxelles": null, "geneve": null, "lausanne": null, "montreal": null, "quebec": null,
    "dakar": null, "abidjan": null, "casablanca": null, "tunis": null, "alger": null,
    "france": null, "belgique": null, "suisse romande": null, "luxembourg": null,
    "senegal": null, "cote d'ivoire": null, "maroc": null, "tunisie": null,
    "cameroun": null, "gabon": null, "mali": null, "congo": null,
  };

  for (const [key, lang] of Object.entries(langMap)) {
    if (locationLower.includes(key)) {
      // Si la langue du CV est déjà la bonne, pas de traduction
      if (lang === null || lang === cvLanguage) return null;
      return lang;
    }
  }

  return null; // Par défaut, pas de traduction
}

/**
 * Traduit le contenu structuré du CV dans une autre langue
 */
async function translateCVContent(cvData, targetLang) {
  const langNames = {
    en: "English", de: "Deutsch", es: "Español",
    pt: "Português", it: "Italiano", nl: "Nederlands",
    ar: "العربية", ja: "日本語", zh: "中文",
  };
  const langName = langNames[targetLang] || targetLang;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `Translate this CV content to ${langName}. Keep it professional and natural (not word-for-word). Adapt job titles and diploma names to local conventions.

CV DATA (JSON):
${JSON.stringify(cvData, null, 2)}

RULES:
- Translate ALL text fields: name stays the same, but translate job titles, descriptions, skills, education, interests
- For education: use local equivalents when possible (ex: "Master" stays "Master" in English, "Diplom" in German)
- For job titles: use the standard title in the target language (ex: "Consultante BI" → "BI Consultant")
- Keep technical terms as-is (SQL, Power BI, SAP, Python, etc.)
- Translate soft skills to natural equivalents
- Translate the profile/presentation paragraph naturally

Respond ONLY with the translated JSON, same structure, no backticks.`,
      },
    ],
  });

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0].replace(/```json|```/g, "").trim());
  }
  return null;
}

/**
 * Retourne le nom de la langue pour l'affichage
 */
function targetLangName(code) {
  return {
    en: "anglais", de: "allemand", es: "espagnol",
    pt: "portugais", it: "italien", nl: "néerlandais",
    ar: "arabe", ja: "japonais", zh: "chinois",
  }[code] || code;
}

/**
 * Score toutes les offres en UN SEUL appel Claude (au lieu de N appels séparés).
 * 10 offres = 1 appel au lieu de 10 → division par ~10 du coût de matching.
 * Retourne un tableau de scores dans le même ordre que `jobs`.
 */
async function matchJobsBatch(profile, jobs, feedbackContext = "") {
  if (!jobs || jobs.length === 0) return [];

  const jobsText = jobs
    .map((j, i) =>
      `${i + 1}. "${j.title}" chez ${j.company} à ${j.location}${j.description_summary ? ". " + j.description_summary.slice(0, 150) : ""}`
    )
    .join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: `Score de pertinence 0-100 pour chaque offre. Réponds UNIQUEMENT en JSON : [{"index":1,"score":nombre,"reason":"raison courte"}, ...]

Profil : ${profile.job_title}, ${profile.experience_years} ans d'expérience, compétences : ${profile.skills?.join(", ")}${feedbackContext}

Offres :
${jobsText}`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const match = text.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const results = JSON.parse(match[0]);
      // Remap par index pour garder l'ordre d'entrée
      return jobs.map((_, i) => {
        const r = results.find((r) => r.index === i + 1);
        return typeof r?.score === "number" ? r.score : 50;
      });
    } catch {
      console.error("[matchJobsBatch] JSON parse error, fallback to 50");
    }
  }

  // Fallback : score neutre si Claude ne répond pas en JSON valide
  return jobs.map(() => 50);
}

module.exports = {
  parseCV, generateCoverLetter, generateFormalCoverLetter, modifyCoverLetter,
  matchJobToProfile, matchJobsBatch, generateWelcomeAfterCV,
  analyzeMarket, formatMarketAnalysis,
  generateInterviewPrep, formatInterviewPrep,
  analyzeJobPosting, formatApplicationBriefing,
  detectCVLanguageNeeded, translateCVContent, targetLangName,
};
