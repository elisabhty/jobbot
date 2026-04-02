# 🤖 JobBot — Bot WhatsApp de recherche d'emploi automatique

Bot WhatsApp intelligent qui analyse ton CV, cherche des offres chaque jour, génère des lettres de motivation en PDF, et postule à ta place.

## 🚀 Fonctionnalités

### Intelligence
- **Analyse de CV** — Détecte la langue, le profil, les compétences, les expériences
- **Multi-pays** — Détecte la mobilité internationale, propose d'envoyer des CVs dans d'autres langues
- **Filtre contrat** — CDI, CDD, Freelance, Alternance, ou texte libre (ex: "portage salarial")
- **Filtre télétravail** — Sur site, Hybride, Full remote, ou texte libre (ex: "3j bureau 2j remote")
- **Matching IA** — Score de compatibilité calculé par Claude pour chaque offre
- **Recherche multi-sources** — Adzuna (16 pays), France Travail, Claude web search

### Candidature
- **Lettre de motivation PDF** — Générée par l'IA, 4-5 paragraphes détaillés et personnalisés
- **Validation avant envoi** — L'utilisateur peut modifier, ajouter des infos, ou annuler
- **Nommage pro** — CV_Elisa_BLANCHART_AMOA_SAP.pdf / LM_Elisa_BLANCHART_AMOA_SAP.pdf
- **Objet d'email** — "Candidature AMOA SAP Transformation digitale - Elisa BLANCHART"
- **Approche hybride** — Email auto si possible, sinon lien + instructions + PDF prêts
- **Relance automatique** — J+7 si pas de réponse

### UX WhatsApp
- **Boutons cliquables** — Boutons interactifs via Twilio Content API
- **Listes déroulantes** — Pour les choix multiples (contrat, mode de travail)
- **Texte libre** — L'utilisateur peut toujours taper sa réponse au lieu de cliquer
- **Fallback intelligent** — Si les boutons ne marchent pas (sandbox), affichage texte avec numéros

### Business
- **Essai gratuit 7 jours**
- **Abonnement Stripe** — 14,99€/mois, sans engagement
- **CRON quotidien** — Recherche automatique chaque matin à 8h

## 📁 Structure du projet (1964 lignes)

```
jobbot/
├── server.js          (222 lignes) — Express + webhooks Twilio/Stripe + CRON
├── conversation.js    (464 lignes) — Machine à états conversationnelle
├── whatsapp-ui.js     (444 lignes) — Boutons, listes, messages interactifs
├── cv-parser.js       (177 lignes) — Analyse CV + génération LM avec Claude
├── job-scraper.js     (172 lignes) — Recherche multi-sources
├── db.js              (168 lignes) — SQLite (users, jobs, applications)
├── pdf-generator.js   (163 lignes) — Génération PDF lettres de motivation
├── auto-apply.js      (154 lignes) — Envoi candidatures + relances
├── package.json
└── .env.example
```

## 📋 Déploiement en 5 étapes

### Étape 1 — Créer les comptes (10 min)

**A) Twilio** (WhatsApp API) — https://www.twilio.com/try-twilio
1. Crée un compte gratuit
2. Va dans Console > Account Info
3. Note ton `Account SID` et `Auth Token`
4. Va dans Messaging > Try it out > Send a WhatsApp message
5. Suis les instructions pour activer le sandbox WhatsApp
6. Le numéro sandbox est `whatsapp:+14155238886`

**B) Anthropic** (Claude AI) — https://console.anthropic.com
1. Crée un compte
2. Va dans Settings > API Keys > Create Key
3. Note la clé `sk-ant-...`
4. Ajoute des crédits (5€ suffisent pour commencer)

**C) Stripe** (Paiements) — https://dashboard.stripe.com/register
1. Crée un compte
2. Va dans Produits > + Ajouter un produit
3. Nom: "JobBot Abonnement", Prix: 14,99€/mois, récurrent
4. Note le `Price ID` (commence par `price_`)
5. Va dans Développeurs > Clés API > note la `Secret key`

**D) Adzuna** (optionnel, offres d'emploi) — https://developer.adzuna.com/
1. Crée un compte gratuit
2. Crée une application
3. Note l'`App ID` et l'`App Key`

### Étape 2 — Préparer le code (5 min)

```bash
# Décompresse le projet
tar -xzf jobbot-whatsapp-v3.tar.gz
cd jobbot

# Copie le fichier d'environnement
cp .env.example .env

# Remplis le .env avec tes clés :
nano .env
```

Le fichier `.env` à remplir :
```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
ANTHROPIC_API_KEY=sk-ant-...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_ID=price_...
BASE_URL=https://ton-app.railway.app
```

### Étape 3 — Déployer sur Railway (5 min)

1. Va sur https://railway.app et connecte ton GitHub
2. Push le code sur un repo GitHub :
```bash
git init
git add .
git commit -m "JobBot v1"
git remote add origin https://github.com/ton-user/jobbot.git
git push -u origin main
```
3. Sur Railway : New Project > Deploy from GitHub repo
4. Sélectionne ton repo
5. Va dans Variables et ajoute toutes les variables du `.env`
6. Railway te donne une URL (ex: `jobbot-production.up.railway.app`)
7. Mets cette URL dans la variable `BASE_URL`

### Étape 4 — Configurer le webhook Twilio (2 min)

1. Va dans Twilio Console
2. Messaging > Try it out > Send a WhatsApp message > Sandbox Settings
3. Dans "WHEN A MESSAGE COMES IN", mets :
   ```
   https://ton-app.railway.app/webhook/whatsapp
   ```
4. Méthode : **POST**
5. Clique Save

### Étape 5 — Tester ! (2 min)

1. Sur ton téléphone, envoie le message d'activation sandbox au numéro Twilio
   (ex: "join sandbox-code" — Twilio te donne le code)
2. Envoie "Salut"
3. Le bot te répond et te demande ton CV
4. Envoie un PDF
5. Suis l'onboarding !

## 🔄 Flow complet

```
"Salut"
  → [📄 Envoyer mon CV]
  
Envoie un PDF
  → "CV analysé ! Elisa Blanchart, AMOA, CV en français"
  → "Dans quelle ville ?"
  
"Paris"
  → [📍 Paris seul.] [🇫🇷 Autres villes] [🌍 International]

Clique [🇫🇷 Autres villes]
  → "Quelles autres villes ?"
  
"Bordeaux, Lyon"
  → Liste déroulante contrat : CDI / CDD / Freelance / Alternance / Peu importe
  → Ou tape "portage salarial"

Clique [CDI]
  → Liste déroulante mode : Sur site / Hybride / Remote / Peu importe
  → Ou tape "3j bureau 2j maison"

Clique [Hybride]
  → Récapitulatif
  → [✅ C'est bon !] [✏️ Modifier]

Clique [✅ C'est bon !]
  → 🚀 Recherche lancée !
  → 5 offres trouvées

"postuler 3"
  → Lettre de motivation générée
  → CV_Elisa_BLANCHART_Chef_Projet_MOA.pdf
  → LM_Elisa_BLANCHART_Chef_Projet_MOA.pdf
  → [✅ Envoyer] [✏️ Modifier] [❌ Annuler]

"modifier: ajouter que je parle anglais B2"
  → Lettre modifiée
  → [✅ Envoyer] [✏️ Modifier] [❌ Annuler]

Clique [✅ Envoyer]
  → ✅ Candidature envoyée / préparée !
  → Relance automatique dans 7 jours
```

## 💰 Coûts et rentabilité

| Poste | Coût |
|---|---|
| Railway (serveur) | ~5€/mois |
| Twilio sandbox (test) | Gratuit |
| Twilio Business (prod) | ~12€/mois |
| Claude API / utilisateur | ~3€/mois |
| **Seuil de rentabilité** | **3-4 abonnés** |
| **Marge à 100 utilisateurs** | **~75%** |

## ⚡ Pour passer en production

1. **Numéro WhatsApp Business** — Migrer du sandbox vers un vrai numéro (~12€/mois)
2. **Webhook Stripe** — Configurer l'endpoint `/stripe-webhook` dans Stripe Dashboard
3. **Nom de domaine** — Pour le lien de paiement
4. **RGPD** — Ajouter commande `/supprimer` (prévu en V2)
5. **Monitoring** — Sentry pour les erreurs
6. **File d'attente** — Bull/Agenda quand +50 utilisateurs

## 📜 Licence

Propriétaire — Tous droits réservés.
