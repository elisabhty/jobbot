const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();

/**
 * Recherche d'offres via l'API Adzuna (gratuite, couvre 16 pays)
 * Inscription: https://developer.adzuna.com/ — gratuit jusqu'à 250 requêtes/jour
 */
async function searchAdzuna(query, country, city, page = 1) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return [];

  // Mapping pays -> code Adzuna
  const countryMap = {
    france: "fr", belgique: "be", suisse: "ch", luxembourg: "lu",
    canada: "ca", "royaume-uni": "gb", uk: "gb", allemagne: "de",
    espagne: "es", italie: "it", "pays-bas": "nl", usa: "us",
    bresil: "br", inde: "in", australie: "au",
  };

  const cc = countryMap[country.toLowerCase()] || "fr";

  try {
    const res = await axios.get(
      `https://api.adzuna.com/v1/api/jobs/${cc}/search/${page}`,
      {
        params: {
          app_id: appId,
          app_key: appKey,
          what: query,
          where: city,
          results_per_page: 10,
          content_type: "application/json",
        },
      }
    );

    return (res.data.results || []).map((j) => ({
      title: j.title,
      company: j.company?.display_name || "Non précisé",
      location: j.location?.display_name || city,
      url: j.redirect_url,
      source: "Adzuna",
      salary: j.salary_is_predicted === "1"
        ? `~${Math.round(j.salary_min || 0)}€ - ${Math.round(j.salary_max || 0)}€`
        : j.salary_display_value || "",
      description_summary: (j.description || "").substring(0, 300),
      expires_at: j.created ? new Date(new Date(j.created).getTime() + 30 * 24 * 3600000).toISOString() : null,
    }));
  } catch (e) {
    console.error("Adzuna error:", e.message);
    return [];
  }
}

/**
 * Cache du token France Travail — renouvelé automatiquement avant expiration.
 * L'API utilise le flux OAuth2 client_credentials.
 * Durée de vie typique : 1499 secondes (~25 min). On renouvelle à 60s de la fin.
 */
const ftTokenCache = { token: null, expiresAt: 0 };

async function getFranceTravailToken() {
  const now = Date.now();
  // Utiliser le token statique de l'env si pas de client credentials configurés
  const clientId     = process.env.FRANCE_TRAVAIL_CLIENT_ID;
  const clientSecret = process.env.FRANCE_TRAVAIL_CLIENT_SECRET;

  // Si pas de credentials OAuth → fallback sur le token statique (mode legacy)
  if (!clientId || !clientSecret) {
    return process.env.FRANCE_TRAVAIL_TOKEN || null;
  }

  // Token encore valide (marge de 60s)
  if (ftTokenCache.token && now < ftTokenCache.expiresAt - 60000) {
    return ftTokenCache.token;
  }

  try {
    const params = new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         "api_offresdemploiv2 o2dsoffre",
    });
    const res = await axios.post(
      "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire",
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    ftTokenCache.token     = res.data.access_token;
    ftTokenCache.expiresAt = now + res.data.expires_in * 1000;
    console.log("[FT] Token renouvelé, expire dans", res.data.expires_in, "s");
    return ftTokenCache.token;
  } catch (e) {
    console.error("[FT] Échec renouvellement token:", e.message);
    // Fallback sur token statique si disponible
    return process.env.FRANCE_TRAVAIL_TOKEN || null;
  }
}

/**
 * Recherche via l'API France Travail (ex Pôle Emploi)
 * Inscription: https://francetravail.io/ — gratuit
 */
async function searchFranceTravail(query, city) {
  const token = await getFranceTravailToken();
  if (!token) return [];

  try {
    const res = await axios.get(
      "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          motsCles: query,
          commune: city,
          range: "0-9",
        },
      }
    );

    return (res.data.resultats || []).map((j) => {
      // France Travail retourne les coordonnées dans coordonnees1/2/3 (email ou téléphone mélangés)
      const coords = [j.contact?.coordonnees1, j.contact?.coordonnees2, j.contact?.coordonnees3].filter(Boolean);
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const contactEmail = coords.find((c) => emailRegex.test(c.trim())) || null;

      return {
        title: j.intitule,
        company: j.entreprise?.nom || "Non précisé",
        location: j.lieuTravail?.libelle || city,
        url: `https://candidat.francetravail.fr/offres/recherche/detail/${j.id}`,
        source: "France Travail",
        salary: j.salaire?.libelle || "",
        description_summary: (j.description || "").substring(0, 300),
        expires_at: j.dateActualisation || null,
        // Champs de candidature directe — évitent un appel analyzeJobPosting si déjà disponibles
        contact_email: contactEmail,
        contact_name: j.contact?.nom || null,
        apply_url: j.urlPostulation || null,
      };
    });
  } catch (e) {
    console.error("France Travail error:", e.message);
    return [];
  }
}

/**
 * Sources par type de contrat
 */
const SOURCE_MAP = {
  CDI: { default: ["Indeed", "LinkedIn", "Glassdoor"] },
  CDD: { default: ["Indeed", "LinkedIn", "Glassdoor"] },
  Freelance: { default: ["Malt", "Upwork", "LinkedIn", "Toptal"] },
  Alternance: { default: ["LinkedIn Apprenticeship", "Indeed Apprenticeship"] },
  Stage: { default: ["LinkedIn Internship", "Indeed Internship", "Glassdoor Internship"] },
  VIE: { default: ["Civiweb", "mon-vie-via.businessfrance.fr", "LinkedIn VIE"] },
  VIA: { default: ["Civiweb", "France Diplomatie", "mon-vie-via.businessfrance.fr"] },
  "Intérim": { default: ["Adecco", "Manpower", "Randstad", "Indeed Temporary"] },
  "Job étudiant": { default: ["StudentJob", "Indeed Part-time", "LinkedIn Part-time"] },
};

/**
 * Sources LOCALES par pays
 * Le bot ajoute ces sources aux sources génériques (LinkedIn, Indeed) 
 * pour chercher sur les plateformes que les recruteurs LOCAUX utilisent vraiment
 */
const COUNTRY_SOURCES = {
  // ─── Europe francophone ─────────────────────────
  france: {
    general: ["Indeed", "LinkedIn", "Welcome to the Jungle", "Glassdoor", "France Travail"],
    alternance: ["Walt Alternance", "L'Étudiant", "Indeed Alternance"],
    stage: ["JobTeaser", "Stage.fr", "StudyramaEmploi"],
    interim: ["Adecco", "Manpower", "Randstad", "Jobijoba"],
    freelance: ["Malt", "Crème de la Crème", "Comet"],
    etudiant: ["StudentJob", "Jobaviz", "JobTeaser"],
  },
  belgique: {
    general: ["Indeed Belgique", "LinkedIn", "StepStone", "Références.be", "Le Forem", "Actiris"],
    interim: ["Adecco Belgique", "Randstad Belgique", "Manpower Belgique"],
  },
  suisse: {
    general: ["Indeed Suisse", "LinkedIn", "Jobs.ch", "Jobup.ch", "Jobscout24"],
    interim: ["Adecco Suisse", "Manpower Suisse", "Randstad Suisse"],
  },
  luxembourg: {
    general: ["Indeed Luxembourg", "LinkedIn", "Jobs.lu", "Moovijob", "ADEM.lu"],
  },

  // ─── Europe non-francophone ─────────────────────
  allemagne: {
    general: ["Indeed Deutschland", "LinkedIn", "StepStone.de", "Xing", "Arbeitsagentur"],
  },
  "royaume-uni": {
    general: ["Indeed UK", "LinkedIn", "Reed.co.uk", "TotalJobs", "Guardian Jobs"],
    interim: ["Reed", "Hays", "Adecco UK"],
  },
  uk: {
    general: ["Indeed UK", "LinkedIn", "Reed.co.uk", "TotalJobs", "Guardian Jobs"],
  },
  espagne: {
    general: ["Indeed España", "LinkedIn", "InfoJobs", "Glassdoor España"],
  },
  italie: {
    general: ["Indeed Italia", "LinkedIn", "InfoJobs Italia", "Monster Italia"],
  },
  "pays-bas": {
    general: ["Indeed Nederland", "LinkedIn", "Nationale Vacaturebank", "Glassdoor NL"],
  },
  portugal: {
    general: ["Indeed Portugal", "LinkedIn", "Net-Empregos", "Glassdoor Portugal"],
  },
  irlande: {
    general: ["Indeed Ireland", "LinkedIn", "IrishJobs.ie", "Jobs.ie"],
  },
  autriche: {
    general: ["Indeed Österreich", "LinkedIn", "StepStone.at", "Karriere.at"],
  },
  pologne: {
    general: ["Indeed Polska", "LinkedIn", "Pracuj.pl", "OLX Praca"],
  },

  // ─── Amérique du Nord ──────────────────────────
  canada: {
    general: ["Indeed Canada", "LinkedIn", "Glassdoor Canada", "Job Bank Canada", "Jobboom"],
    // Jobboom = principal site d'emploi québécois
  },
  usa: {
    general: ["Indeed", "LinkedIn", "Glassdoor", "ZipRecruiter", "Monster"],
  },
  "états-unis": {
    general: ["Indeed", "LinkedIn", "Glassdoor", "ZipRecruiter", "Monster"],
  },

  // ─── Afrique du Nord ───────────────────────────
  maroc: {
    general: ["Rekrute.com", "Emploi.ma", "MarocAnnonces", "Bayt", "LinkedIn", "Indeed Maroc", "Menarajob"],
    stage: ["StageMaroc.com", "Rekrute Stage"],
  },
  tunisie: {
    general: ["Tanitjobs", "Emploi.tn", "Tunisie Travail", "LinkedIn", "Indeed Tunisie", "Keejob"],
    stage: ["StagesTunisie.com"],
  },
  algerie: {
    general: ["Emploitic", "Ouedkniss Emploi", "LinkedIn", "Indeed Algérie", "Bayt Algérie"],
  },

  // ─── Afrique de l'Ouest ────────────────────────
  senegal: {
    general: ["EmploiDakar", "Novojob Sénégal", "Expat-Dakar", "LinkedIn", "Go Africa Online", "Talent2Africa"],
    stage: ["StageDakar.com", "EmploiDakar Stage"],
  },
  "cote d'ivoire": {
    general: ["EmploiAbidjan", "Novojob Côte d'Ivoire", "Educarriere", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  mali: {
    general: ["Novojob Mali", "MaliEmploi", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  "burkina faso": {
    general: ["Novojob Burkina", "Emploi Burkina", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  guinee: {
    general: ["Novojob Guinée", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  togo: {
    general: ["Novojob Togo", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  benin: {
    general: ["Novojob Bénin", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  niger: {
    general: ["Novojob Niger", "LinkedIn", "Go Africa Online", "Africawork", "NigerEmploi"],
  },

  // ─── Afrique Centrale ─────────────────────────
  cameroun: {
    general: ["Kerawa", "MinaJobs", "Novojob Cameroun", "LinkedIn", "Go Africa Online", "Africawork"],
    stage: ["Kerawa Stage"],
  },
  gabon: {
    general: ["Novojob Gabon", "Offre-Emploi-Afrique", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  congo: {
    general: ["Novojob Congo", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  rdc: {
    general: ["Novojob RDC", "LinkedIn", "Go Africa Online", "Africawork", "CD-Emploi"],
  },
  "république démocratique du congo": {
    general: ["Novojob RDC", "LinkedIn", "Go Africa Online", "Africawork", "CD-Emploi"],
  },
  tchad: {
    general: ["LinkedIn", "Go Africa Online", "Africawork", "Emploi Tchad"],
  },
  centrafrique: {
    general: ["LinkedIn", "Go Africa Online", "Africawork"],
  },

  // ─── Océan Indien ──────────────────────────────
  madagascar: {
    general: ["Emploi.mg", "Moov.mg", "LinkedIn", "Go Africa Online", "Africawork"],
  },
  maurice: {
    general: ["MyJob.mu", "LinkedIn", "Glassdoor Maurice"],
  },
  comores: {
    general: ["LinkedIn", "Go Africa Online"],
  },

  // ─── Moyen-Orient ─────────────────────────────
  liban: {
    general: ["Bayt", "LinkedIn", "Indeed Liban", "Daleel Madani"],
  },
  "emirats arabes unis": {
    general: ["Bayt", "LinkedIn", "GulfTalent", "Indeed UAE", "Naukrigulf"],
  },
  qatar: {
    general: ["Bayt", "LinkedIn", "GulfTalent", "Indeed Qatar"],
  },
  "arabie saoudite": {
    general: ["Bayt", "LinkedIn", "GulfTalent", "Indeed Saudi Arabia"],
  },

  // ─── Asie ─────────────────────────────────────
  japon: {
    general: ["Indeed Japan", "LinkedIn", "GaijinPot", "Glassdoor Japan"],
  },
  singapour: {
    general: ["Indeed Singapore", "LinkedIn", "JobStreet", "Glassdoor Singapore"],
  },
  chine: {
    general: ["LinkedIn China", "Indeed China", "51job.com", "Zhaopin"],
  },
  inde: {
    general: ["Indeed India", "LinkedIn", "Naukri.com", "Glassdoor India"],
  },

  // ─── Amérique Latine ──────────────────────────
  bresil: {
    general: ["Indeed Brasil", "LinkedIn", "Glassdoor Brasil", "Catho"],
  },
  mexique: {
    general: ["Indeed México", "LinkedIn", "OCC Mundial", "Glassdoor México"],
  },

  // ─── Océanie ──────────────────────────────────
  australie: {
    general: ["Indeed Australia", "LinkedIn", "Seek.com.au", "Glassdoor Australia"],
  },
  "nouvelle-zelande": {
    general: ["Indeed NZ", "LinkedIn", "Seek.co.nz", "TradeMe Jobs"],
  },
};

/**
 * Détermine les sources à chercher selon le contrat ET le pays
 */
function getSourcesForContract(contractType, country) {
  const c = country.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const countrySources = COUNTRY_SOURCES[c] || COUNTRY_SOURCES[country.toLowerCase()] || null;

  const allSources = new Set();

  // 1. Ajouter les sources locales du pays
  if (countrySources) {
    // Sources générales du pays
    (countrySources.general || []).forEach(s => allSources.add(s));

    // Sources spécifiques au type de contrat dans ce pays
    const contractLower = contractType.toLowerCase();
    if (contractLower.includes("alternance") && countrySources.alternance) {
      countrySources.alternance.forEach(s => allSources.add(s));
    }
    if (contractLower.includes("stage") && countrySources.stage) {
      countrySources.stage.forEach(s => allSources.add(s));
    }
    if ((contractLower.includes("intérim") || contractLower.includes("interim")) && countrySources.interim) {
      countrySources.interim.forEach(s => allSources.add(s));
    }
    if (contractLower.includes("freelance") && countrySources.freelance) {
      countrySources.freelance.forEach(s => allSources.add(s));
    }
    if ((contractLower.includes("étudiant") || contractLower.includes("etudiant")) && countrySources.etudiant) {
      countrySources.etudiant.forEach(s => allSources.add(s));
    }
  }

  // 2. Ajouter les sources génériques par type de contrat
  for (const [type, sources] of Object.entries(SOURCE_MAP)) {
    if (contractType.toLowerCase().includes(type.toLowerCase())) {
      (sources.default || []).forEach(s => allSources.add(s));
    }
  }

  // 3. Fallback : LinkedIn + Indeed (universels)
  if (allSources.size === 0) {
    allSources.add("LinkedIn");
    allSources.add("Indeed");
    if (countrySources?.general) {
      countrySources.general.forEach(s => allSources.add(s));
    }
  }

  return [...allSources];
}

/**
 * Recherche via Claude + web search — intelligente selon le type de contrat
 */
async function searchWithAI(query, city, country, contractType) {
  const sources = getSourcesForContract(contractType || "Tous types", country || "France");
  const sourceList = sources.join(", ");

  try {
    const locationStr = city ? `à ${city}, ${country}` : `en ${country}`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [
        {
          role: "user",
          content: `Cherche 5-10 offres d'emploi récentes pour "${query}" ${locationStr}.

Type de contrat recherché : ${contractType || "tous"}

Cherche PRIORITAIREMENT sur ces sites : ${sourceList}

Réponds UNIQUEMENT en JSON:
[{"title":"titre","company":"entreprise","location":"lieu","url":"lien direct vers l'offre","salary":"salaire/indemnité si dispo","description_summary":"résumé court","source":"nom du site où tu as trouvé l'offre","contract_type":"CDI/CDD/Intérim/Stage/VIE/Freelance"}]`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const jobs = JSON.parse(match[0].replace(/```json|```/g, "").trim());
      return jobs.map((j) => ({
        ...j,
        source: j.source || "AI Search",
        expires_at: null,
      }));
    }
    return [];
  } catch (e) {
    console.error("AI search error:", e.message);
    return [];
  }
}

/**
 * Recherche de VIE/VIA via Claude + web search
 * Civiweb.com = plateforme officielle (Business France) pour VIE et VIA
 * VIE = Volontariat International en Entreprise (secteur privé)
 * VIA = Volontariat International en Administration (secteur public, ambassades, consulats)
 */
async function searchVIEVIA(query, countries, type) {
  try {
    const countryList = countries.filter(c => c.toLowerCase() !== "france" && c !== "International").join(", ");
    const isVIE = type.includes("VIE");
    const isVIA = type.includes("VIA");
    const typeLabel = isVIE && isVIA ? "VIE et VIA" : isVIE ? "VIE" : "VIA";

    let searchSites = "civiweb.com, mon-vie-via.businessfrance.fr";
    if (isVIA) searchSites += ", france-diplomatie.gouv.fr, diplomatie.gouv.fr";
    if (isVIE) searchSites += ", Indeed, LinkedIn";

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [
        {
          role: "user",
          content: `Cherche des offres de ${typeLabel} récentes pour le profil "${query}" dans ces pays : ${countryList || "tous pays"}.

${isVIE ? "VIE = Volontariat International en Entreprise (missions en entreprise à l'étranger)" : ""}
${isVIA ? "VIA = Volontariat International en Administration (missions en ambassades, consulats, institutions françaises à l'étranger)" : ""}

Cherche sur ${searchSites}.

Réponds UNIQUEMENT en JSON:
[{"title":"titre du poste","company":"entreprise ou institution","location":"ville, pays","url":"lien direct","salary":"indemnité si disponible","description_summary":"résumé court","duration":"durée si précisée","type":"VIE ou VIA"}]`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const jobs = JSON.parse(match[0].replace(/```json|```/g, "").trim());
      return jobs.map((j) => ({
        ...j,
        source: `Civiweb ${j.type || typeLabel}`,
        expires_at: null,
      }));
    }
    return [];
  } catch (e) {
    console.error("VIE/VIA search error:", e.message);
    return [];
  }
}

/**
 * Recherche combinée sur toutes les sources
 */
async function searchAllSources(profile, user) {
  const query = profile.job_title || user.target_job_title;
  const cities = JSON.parse(user.target_cities || "[]");
  const countries = JSON.parse(user.target_countries || '["France"]');
  const contractType = user.contract_type || "";
  const includesVIE = contractType.includes("VIE");
  const includesVIA = contractType.includes("VIA");
  const hasInternationalContract = includesVIE || includesVIA;

  let allJobs = [];

  // Source VIE/VIA: Civiweb
  if (hasInternationalContract) {
    const type = [includesVIE ? "VIE" : "", includesVIA ? "VIA" : ""].filter(Boolean).join("/");
    const vieJobs = await searchVIEVIA(query, countries, type);
    allJobs = allJobs.concat(vieJobs);
  }

  for (const city of cities) {
    for (const country of countries) {
      if (country === "International") continue; // handled by AI search

      // Source 1: Adzuna (16 pays supportés)
      const adzunaJobs = await searchAdzuna(query, country, city);
      allJobs = allJobs.concat(adzunaJobs);

      // Source 2: France Travail (France uniquement)
      if (country.toLowerCase() === "france") {
        const ftJobs = await searchFranceTravail(query, city);
        allJobs = allJobs.concat(ftJobs);
      }

      // Source 3: AI-powered search (smart source routing by contract type)
      const vieViaPrefix = includesVIE ? "VIE" : includesVIA ? "VIA" : "";
      const searchQuery = vieViaPrefix ? `${query} ${vieViaPrefix}` : query;
      const aiJobs = await searchWithAI(searchQuery, city, country, contractType);
      allJobs = allJobs.concat(aiJobs);
    }
  }

  // If "International" is in countries, do a broad AI search
  if (countries.includes("International")) {
    const vieViaPrefix2 = includesVIE ? "VIE" : includesVIA ? "VIA" : "";
    const aiJobs = await searchWithAI(vieViaPrefix2 ? `${query} ${vieViaPrefix2}` : query, "", "international", contractType);
    allJobs = allJobs.concat(aiJobs);
  }

  // Dédupliquer par titre + entreprise
  const seen = new Set();
  const unique = allJobs.filter((j) => {
    const key = `${j.title?.toLowerCase()}-${j.company?.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique;
}

module.exports = { searchAllSources, searchAdzuna, searchFranceTravail, searchWithAI, searchVIEVIA, getSourcesForContract };
