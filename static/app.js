"use strict";

let STORE = {chantiers: [], contacts: []};
let TODAY = "2025-01-01";
let CUR = null;            // id du chantier ouvert en page detaillee (sinon null)
let SETTINGS = {capacite_jour: 3, wip_max: 3, jours_ouvres: true, relance_jours: 7, jour_debut: "07:00", jour_fin: "17:51", pause_debut: "12:00", pause_fin: "13:00", vendredi_fin: "13:30"};

const COLS = [
  {key: "todo",    label: "À faire"},
  {key: "doing",   label: "En cours"},
  {key: "block",   label: "Bloqué"},
  {key: "recette", label: "Recette"},
  {key: "done",    label: "Terminé"},
];
const PRIO = {h: "haute", m: "moyenne", b: "basse"};
const LIV  = {attente: "En attente", recu: "Reçu", partiel: "Reçu partiel", annule: "Annulé"};

// ---- Recette : une liste de points à vérifier -----------------------------
// Trois états, pas un de plus. Un point qui coince porte son constat, qui
// corrige et pour quand — il n'y a rien d'autre à tenir à jour.
const PT = {
  a_verifier: {lbl: "À vérifier", cls: "p-todo"},
  ok:         {lbl: "Vérifié",    cls: "p-ok"},
  probleme:   {lbl: "Problème",   cls: "p-ko"},
};
const recPoints = c => ((c.recette || {}).points) || [];
const recProblemes = c => recPoints(c).filter(p => p.statut === "probleme").map(p => ({...p, _c: c}));
const recProbLate = c => recProblemes(c).filter(p => isLate(p.echeance));
const recChantiers = () => LIVE().filter(c => c.recette);
function recStats(c){
  const pts = recPoints(c);
  const ok = pts.filter(p => p.statut === "ok").length;
  const pb = pts.filter(p => p.statut === "probleme").length;
  return {total: pts.length, ok, probleme: pb, a_verifier: pts.length - ok - pb,
          pct: pts.length ? Math.round(ok / pts.length * 100) : 0,
          fini: pts.length > 0 && ok === pts.length};
}
// Chrono de recette : rattaché à UN point, comme un chrono de tâche l'est à une tâche.
const recChrono = cid => { const a = activeSession(); return (a && a.kind === "recette" && a.chantier_id === cid) ? a : null; };
const activeForPoint = pid => { const a = activeSession(); return (a && a.point_id === pid) ? a : null; };
const pointMin = pid => TIMELOG().filter(s => s.point_id === pid).reduce((a, s) => a + sessMin(s), 0);

// ---- risques (cotation 5×5 : criticité = proba × gravité, 1..25) ----------
const RISK = {ouvert: "Ouvert", maitrise: "Maîtrisé", avere: "Avéré", clos: "Clos"};
// Échelles 1-5 explicites (cotation type PMBOK / PRINCE2)
const PROBA_LBL = {1: "Très improbable", 2: "Peu probable", 3: "Possible", 4: "Probable", 5: "Quasi certain"};
const GRAV_LBL  = {1: "Négligeable", 2: "Mineur", 3: "Modéré", 4: "Majeur", 5: "Critique"};
const proba5 = v => [1, 2, 3, 4, 5].map(x => `<option value="${x}" ${+x === +v ? "selected" : ""}>${x} · ${PROBA_LBL[x]}</option>`).join("");
const grav5  = v => [1, 2, 3, 4, 5].map(x => `<option value="${x}" ${+x === +v ? "selected" : ""}>${x} · ${GRAV_LBL[x]}</option>`).join("");
// Catalogue standard de risques projet (RBS PMBOK + PRINCE2) — ~90% des cas. {l: libellé, p: proba, g: gravité, m: parade}
const RISK_CATALOG = {
  "Délais & planning": [
    {l: "Estimations de durée trop optimistes", p: 4, g: 3, m: "Estimer en 3 points (optimiste/probable/pessimiste) et garder une marge."},
    {l: "Jalon clé non tenu", p: 3, g: 4, m: "Suivi rapproché du chemin critique, alerte précoce."},
    {l: "Dépendances entre tâches sous-estimées", p: 3, g: 3, m: "Cartographier les liens et les valider avec l'équipe."},
    {l: "Livraison externe bloquante en retard", p: 3, g: 4, m: "Engagement de date écrit + plan B / relances planifiées."},
    {l: "Chemin critique sans aucune marge", p: 3, g: 4, m: "Ajouter des tampons sur les tâches critiques."},
    {l: "Élargissement progressif du périmètre (effet tunnel)", p: 3, g: 3, m: "Gel du périmètre + procédure de changement."},
    {l: "Indisponibilité d'une ressource au moment voulu", p: 3, g: 3, m: "Réserver les ressources à l'avance, prévoir un back-up."},
    {l: "Absences / congés non anticipés", p: 2, g: 2, m: "Planifier autour des congés connus, lisser la charge."},
  ],
  "Périmètre & exigences": [
    {l: "Exigences floues ou incomplètes", p: 4, g: 4, m: "Atelier de cadrage + critères d'acceptation écrits."},
    {l: "Changements de périmètre fréquents (scope creep)", p: 4, g: 3, m: "Comité de changement, chaque demande tracée et arbitrée."},
    {l: "Besoin mal compris / mauvaise interprétation", p: 3, g: 4, m: "Reformuler et faire valider par le métier (maquettes)."},
    {l: "Absence de critères d'acceptation clairs", p: 3, g: 3, m: "Définir la définition de « terminé » par livrable."},
    {l: "Exigences contradictoires entre parties prenantes", p: 3, g: 3, m: "Arbitrage formel par le sponsor."},
    {l: "Fonctionnalités non priorisées", p: 3, g: 2, m: "Prioriser (MoSCoW) avant de lancer la réalisation."},
  ],
  "Technique & solution": [
    {l: "Complexité technique sous-estimée", p: 3, g: 4, m: "Spike / preuve de concept en amont."},
    {l: "Technologie nouvelle ou non maîtrisée", p: 3, g: 4, m: "Montée en compétence + appui d'un expert."},
    {l: "Intégration entre systèmes plus difficile que prévu", p: 3, g: 3, m: "Tester les interfaces tôt, contrats d'API clairs."},
    {l: "Problèmes de performance / montée en charge", p: 2, g: 4, m: "Tests de charge avant la mise en production."},
    {l: "Dette technique / qualité de code insuffisante", p: 3, g: 3, m: "Revues de code, refactoring planifié."},
    {l: "Architecture inadaptée à l'évolution", p: 2, g: 4, m: "Revue d'architecture, choix justifiés et documentés."},
    {l: "Bugs critiques découverts tardivement", p: 3, g: 4, m: "Tests automatisés + recette continue."},
    {l: "Environnements (dev/test/prod) instables", p: 2, g: 3, m: "Industrialiser les environnements (IaC)."},
  ],
  "Dépendances & IT": [
    {l: "Accès / habilitations non fournis à temps", p: 3, g: 4, m: "Demander les accès dès le démarrage, escalade si retard."},
    {l: "Données sources indisponibles ou incomplètes", p: 3, g: 4, m: "Valider la disponibilité et la qualité en amont."},
    {l: "Dépendance à une autre équipe interne", p: 3, g: 3, m: "Engagement de service (SLA) et points réguliers."},
    {l: "Indisponibilité d'un environnement / serveur", p: 2, g: 3, m: "Redondance + fenêtre de maintenance planifiée."},
    {l: "Composant tiers / API qui change", p: 2, g: 3, m: "Figer les versions, veille sur les changements."},
    {l: "Panne d'infrastructure", p: 2, g: 4, m: "Sauvegardes + plan de reprise testé."},
  ],
  "Fournisseurs & externe": [
    {l: "Retard de livraison fournisseur", p: 3, g: 4, m: "Jalons contractuels + pénalités + relances."},
    {l: "Prestataire défaillant / qualité insuffisante", p: 2, g: 4, m: "Critères de qualité, recette à chaque livraison."},
    {l: "Dépendance à un fournisseur unique", p: 2, g: 4, m: "Identifier une alternative / clause de réversibilité."},
    {l: "Conditions contractuelles défavorables", p: 2, g: 3, m: "Relecture juridique avant signature."},
    {l: "Sous-traitant indisponible", p: 2, g: 3, m: "Carnet de prestataires de secours."},
  ],
  "Ressources & équipe": [
    {l: "Départ / turnover d'une personne clé", p: 2, g: 4, m: "Documentation + binômage pour éviter le point unique."},
    {l: "Compétence manquante dans l'équipe", p: 3, g: 3, m: "Formation, recrutement ou renfort externe."},
    {l: "Équipe partagée sur plusieurs projets", p: 4, g: 3, m: "Engagement de capacité, arbitrage des priorités."},
    {l: "Surcharge / sur-allocation", p: 3, g: 3, m: "Lisser la charge, limiter le WIP."},
    {l: "Manque de disponibilité du sponsor", p: 2, g: 3, m: "Comité de pilotage régulier, décisions cadrées."},
    {l: "Montée en compétence plus longue que prévu", p: 2, g: 2, m: "Prévoir une phase d'apprentissage dans le planning."},
  ],
  "Budget & coûts": [
    {l: "Budget initial sous-évalué", p: 3, g: 4, m: "Chiffrage détaillé + provision pour aléas."},
    {l: "Dérive / dépassement de coûts", p: 3, g: 3, m: "Suivi budgétaire régulier (réel vs prévu)."},
    {l: "Coûts cachés (licences, infra, run)", p: 3, g: 3, m: "Inclure le coût complet (TCO) dès le départ."},
    {l: "Financement non sécurisé ou gelé", p: 2, g: 4, m: "Sécuriser l'engagement budgétaire par écrit."},
    {l: "Variation de prix / change", p: 2, g: 2, m: "Clause de révision, achats anticipés."},
  ],
  "Qualité & conformité": [
    {l: "Tests insuffisants", p: 3, g: 4, m: "Plan de tests + couverture minimale exigée."},
    {l: "Recette / validation tardive", p: 3, g: 3, m: "Impliquer le métier tôt, recette par incréments."},
    {l: "Régression non détectée", p: 2, g: 3, m: "Tests de non-régression automatisés."},
    {l: "Non-conformité aux standards / normes", p: 2, g: 3, m: "Checklist de conformité, revue qualité."},
    {l: "Documentation incomplète", p: 3, g: 2, m: "Documentation au fil de l'eau, critère de « terminé »."},
  ],
  "Données & sécurité": [
    {l: "Fuite ou perte de données", p: 2, g: 5, m: "Chiffrement, contrôle d'accès, sauvegardes testées."},
    {l: "Faille de sécurité / vulnérabilité", p: 2, g: 5, m: "Revue de sécurité, tests d'intrusion."},
    {l: "Mauvaise qualité des données", p: 3, g: 4, m: "Contrôles de qualité, règles de validation."},
    {l: "Non-conformité RGPD / données personnelles", p: 2, g: 4, m: "Analyse d'impact (DPIA), minimisation des données."},
    {l: "Sauvegarde / reprise non testée", p: 2, g: 4, m: "Exercice de restauration planifié."},
  ],
  "Parties prenantes & adhésion": [
    {l: "Manque d'adhésion des utilisateurs", p: 3, g: 4, m: "Conduite du changement, implication précoce."},
    {l: "Décisions tardives / circuit de validation lent", p: 3, g: 3, m: "Instances de décision cadencées, délégations."},
    {l: "Priorités de la direction qui changent", p: 3, g: 4, m: "Réaligner via le comité de pilotage."},
    {l: "Conflit entre parties prenantes", p: 2, g: 3, m: "Médiation, rôles et responsabilités clarifiés (RACI)."},
    {l: "Communication insuffisante", p: 3, g: 2, m: "Plan de communication, points réguliers."},
  ],
  "Juridique & réglementaire": [
    {l: "Évolution réglementaire impactante", p: 2, g: 4, m: "Veille réglementaire, marge d'adaptation."},
    {l: "Problème de propriété intellectuelle / licence", p: 2, g: 3, m: "Vérifier les licences et droits d'usage."},
    {l: "Clause contractuelle non respectée", p: 2, g: 3, m: "Suivi des obligations contractuelles."},
    {l: "Contrainte légale découverte tardivement", p: 2, g: 4, m: "Revue juridique en amont du cadrage."},
  ],
};
const RISK_CATS = [...Object.keys(RISK_CATALOG), "Autre"];

// ---- Catalogues standard (PMBOK / PRINCE2) : livrables, parties prenantes, WBS, modèles de chantier ----
// Livrables types (PRINCE2 management products + classiques) — {l: libellé, role, impact}
const LIVRABLE_CATALOG = {
  "Cadrage": [
    {l: "Note de cadrage / Project Brief", role: "Chef de projet", impact: "Cadre le besoin et le périmètre"},
    {l: "Business case (justification)", role: "Sponsor", impact: "Valide l'opportunité / la rentabilité"},
    {l: "Plan projet (PID)", role: "Chef de projet", impact: "Référence de pilotage"},
    {l: "Cahier des charges", role: "MOA", impact: "Exigences à satisfaire"},
  ],
  "Conception": [
    {l: "Spécifications fonctionnelles", role: "MOA", impact: "Base de la réalisation"},
    {l: "Spécifications techniques", role: "MOE", impact: "Architecture de la solution"},
    {l: "Maquettes / prototypes", role: "MOE", impact: "Validation de l'IHM"},
  ],
  "Réalisation & tests": [
    {l: "Solution développée / livrée", role: "MOE", impact: "Le produit"},
    {l: "Plan de tests", role: "Recette", impact: "Couverture de la validation"},
    {l: "Jeu de données de test", role: "MOA", impact: "Conditions de recette"},
    {l: "PV de recette", role: "MOA", impact: "Acceptation formelle"},
  ],
  "Déploiement & clôture": [
    {l: "Plan de déploiement / bascule", role: "MOE", impact: "Mise en production maîtrisée"},
    {l: "Documentation utilisateur", role: "MOE", impact: "Autonomie des utilisateurs"},
    {l: "Plan de conduite du changement", role: "Chef de projet", impact: "Adhésion des utilisateurs"},
    {l: "Bilan de fin de projet / REX", role: "Chef de projet", impact: "Capitalisation"},
  ],
};
// Parties prenantes / rôles standard (PMBOK + rôles PRINCE2) — {nom, role}
const PARTIE_CATALOG = [
  {nom: "Sponsor / Commanditaire", role: "Décideur (Executive)"},
  {nom: "Comité de pilotage", role: "Pilotage / arbitrage"},
  {nom: "MOA / Métier", role: "Exprime le besoin (Senior User)"},
  {nom: "MOE / Équipe technique", role: "Réalise (Senior Supplier)"},
  {nom: "Chef de projet", role: "Coordination (Project Manager)"},
  {nom: "Utilisateurs finaux", role: "Recette / usage"},
  {nom: "Référent technique / Architecte", role: "Conseil technique"},
  {nom: "DSI / IT", role: "Infra & accès"},
  {nom: "Achats", role: "Contractualisation fournisseurs"},
  {nom: "Direction", role: "Validation stratégique"},
  {nom: "Fournisseur / Prestataire", role: "Livraison externe"},
  {nom: "Contrôle de gestion", role: "Suivi budgétaire"},
];
// Modèles de tâches (WBS) — preds par INDICE dans le lot ; is_milestone pour les jalons
const WBS_TEMPLATES = {
  "Cycle PMBOK (générique)": [
    {label: "Initialisation / cadrage", duree: 3},
    {label: "Planification", duree: 3, preds: [0]},
    {label: "Exécution / réalisation", duree: 10, preds: [1]},
    {label: "Suivi & maîtrise", duree: 10, preds: [1]},
    {label: "Recette", duree: 3, preds: [2]},
    {label: "Clôture", is_milestone: true, preds: [4]},
  ],
  "Projet data / BI": [
    {label: "Cadrage du besoin", duree: 3},
    {label: "Modélisation des données", duree: 4, preds: [0]},
    {label: "Développement des rapports", duree: 6, preds: [1]},
    {label: "Recette métier", duree: 3, preds: [2]},
    {label: "Documentation & formation", duree: 2, preds: [3]},
    {label: "Mise en production", is_milestone: true, preds: [3]},
  ],
  "Déploiement logiciel": [
    {label: "Analyse des besoins", duree: 3},
    {label: "Conception", duree: 4, preds: [0]},
    {label: "Développement", duree: 10, preds: [1]},
    {label: "Tests & recette", duree: 4, preds: [2]},
    {label: "Déploiement", duree: 2, preds: [3]},
    {label: "Go-live", is_milestone: true, preds: [4]},
  ],
};
// Modèles de chantier complets : WBS + livrables + parties + risques (short-list)
const CHANTIER_TEMPLATES = {
  "Projet générique (PMBOK)": {
    taches: WBS_TEMPLATES["Cycle PMBOK (générique)"],
    livrables: [{quoi: "Note de cadrage / Project Brief", role: "Chef de projet"}, {quoi: "Plan projet (PID)", role: "Chef de projet"},
                {quoi: "PV de recette", role: "MOA"}, {quoi: "Bilan de fin de projet / REX", role: "Chef de projet"}],
    parties: [{nom: "Sponsor / Commanditaire", role: "Décideur"}, {nom: "Chef de projet", role: "Coordination"},
              {nom: "MOA / Métier", role: "Exprime le besoin"}, {nom: "Comité de pilotage", role: "Arbitrage"}],
    risques: [{libelle: "Exigences floues ou incomplètes", categorie: "Périmètre & exigences", probabilite: 4, gravite: 4, parade: "Atelier de cadrage + critères d'acceptation"},
              {libelle: "Décisions tardives / circuit de validation lent", categorie: "Parties prenantes & adhésion", probabilite: 3, gravite: 3, parade: "Instances de décision cadencées"}],
  },
  "Projet data / BI": {
    taches: WBS_TEMPLATES["Projet data / BI"],
    livrables: [{quoi: "Cahier des charges", role: "MOA"}, {quoi: "Spécifications techniques", role: "MOE"},
                {quoi: "PV de recette", role: "MOA"}, {quoi: "Documentation utilisateur", role: "MOE"}],
    parties: [{nom: "MOA / Métier", role: "Exprime le besoin"}, {nom: "DSI / IT", role: "Infra & accès"},
              {nom: "Référent technique / Architecte", role: "Conseil technique"}, {nom: "Utilisateurs finaux", role: "Recette"}],
    risques: [{libelle: "Données sources indisponibles ou incomplètes", categorie: "Dépendances & IT", probabilite: 3, gravite: 4, parade: "Valider disponibilité & qualité en amont"},
              {libelle: "Accès / habilitations non fournis à temps", categorie: "Dépendances & IT", probabilite: 3, gravite: 4, parade: "Demander les accès dès le démarrage"}],
  },
  "Déploiement logiciel": {
    taches: WBS_TEMPLATES["Déploiement logiciel"],
    livrables: [{quoi: "Spécifications fonctionnelles", role: "MOA"}, {quoi: "Plan de tests", role: "Recette"},
                {quoi: "Plan de déploiement / bascule", role: "MOE"}, {quoi: "Documentation utilisateur", role: "MOE"}],
    parties: [{nom: "Sponsor / Commanditaire", role: "Décideur"}, {nom: "MOE / Équipe technique", role: "Réalise"},
              {nom: "Utilisateurs finaux", role: "Recette / usage"}, {nom: "DSI / IT", role: "Infra & accès"}],
    risques: [{libelle: "Complexité technique sous-estimée", categorie: "Technique & solution", probabilite: 3, gravite: 4, parade: "Preuve de concept en amont"},
              {libelle: "Manque d'adhésion des utilisateurs", categorie: "Parties prenantes & adhésion", probabilite: 3, gravite: 4, parade: "Conduite du changement, implication précoce"}],
  },
};
const crit = r => (r.probabilite || 0) * (r.gravite || 0);
const riskActive = r => r.statut === "ouvert" || r.statut === "avere";   // pèse encore
function critLevel(n){   // 5×5 → 4 niveaux + couleur
  if(n >= 15) return {k: "critique", lbl: "Critique", col: "#dc2626", bg: "#fee2e2"};
  if(n >= 10) return {k: "eleve",    lbl: "Élevé",    col: "#ea580c", bg: "#ffedd5"};
  if(n >= 5)  return {k: "moyen",    lbl: "Moyen",    col: "#ca8a04", bg: "#fef9c3"};
  return             {k: "faible",   lbl: "Faible",   col: "#16a34a", bg: "#dcfce7"};
}
const risquesOf = c => c.risques || [];
const openRisques = c => risquesOf(c).filter(riskActive);
const topCrit = c => openRisques(c).reduce((m, r) => Math.max(m, crit(r)), 0);
const allRisques = () => LIVE().flatMap(c => risquesOf(c).map(r => ({...r, _c: c})));

// ---- utils ---------------------------------------------------------------
const $ = id => document.getElementById(id);
const esc = s => (s == null ? "" : String(s)).replace(/[&<>"]/g, c =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const jqs = s => esc(s).replace(/'/g, "\\'");   // chaîne sûre pour un attribut onX='...'
const isLate = d => d && d < TODAY;
const livPending = x => x.statut === "attente" || x.statut === "partiel";   // livrable encore dû
const pct = c => c.taches.length ? Math.round(100 * c.taches.filter(t => t.done).length / c.taches.length) : 0;
const openAtt = c => c.livrables.filter(l => livPending(l));
const lateAtt = c => c.livrables.filter(l => (livPending(l)) && isLate(l.date));
const chById = id => STORE.chantiers.find(c => c.id === id);
// Chantiers "vivants" (hors pause) — un chantier en pause disparaît de TOUTES les vues
// (board, planning, tableau de bord, charge, personnes, risques, activité, cahiers).
const LIVE = () => STORE.chantiers.filter(c => !c.hold);

// ---- Thèmes : maille transverse, liste FERMÉE (10 max) --------------------
// Un thème classe tout ce qui n'est pas un chantier (actions, notes, temps libre).
// Le choix se fait dans une liste : pas de saisie libre, donc pas de doublons.
const THEMES = () => (STORE.themes || []);
const THEMES_ON = () => THEMES().filter(t => !t.archive);
const thById = id => THEMES().find(t => t.id === id) || null;
const THEMES_MAX = 10;
const SANS_THEME = {id: "", nom: "Sans thème", icone: "○", couleur: "var(--gray)"};
function themeOf(x){ return (x && x.theme_id) ? thById(x.theme_id) : null; }
// Le thème d'une plage de chrono : le sien, sinon celui de son chantier, sinon celui de son action.
function themeOfSession(s){
  if(s.theme_id) return thById(s.theme_id);
  const c = s.chantier_id ? chById(s.chantier_id) : null;
  if(c && c.theme_id) return thById(c.theme_id);
  const a = s.action_id ? acById(s.action_id) : null;
  return (a && a.theme_id) ? thById(a.theme_id) : null;
}
function themeChip(id, opts){
  const t = thById(id);
  if(!t) return (opts && opts.vide) ? `<span class="th-chip none">○ sans thème</span>` : "";
  return `<span class="th-chip" style="--th:${t.couleur}"${opts && opts.click ? ` onclick="${opts.click}"` : ""}>` +
         `${t.icone} ${esc(t.nom)}</span>`;
}
function themeDot(id){
  const t = thById(id);
  return `<span class="th-dot" style="background:${t ? t.couleur : "var(--line)"}" title="${t ? esc(t.nom) : "sans thème"}"></span>`;
}
// <select> de thèmes — le seul moyen d'en affecter un (aucune saisie libre nulle part).
function themeSelect(cur, onchange, cls){
  return `<select class="th-sel ${cls || ""}" onchange="${onchange}" title="Thème (liste fermée)">` +
    `<option value="">— sans thème —</option>` +
    THEMES_ON().map(t => `<option value="${t.id}" ${cur === t.id ? "selected" : ""}>${t.icone} ${esc(t.nom)}</option>`).join("") +
    `</select>`;
}
// "Bloqué" est calculé : point bloquant rempli, OU un livrable non reçu dont
// l'ÉCHÉANCE EST DÉPASSÉE. Tant que la date attendue n'est pas passée, un livrable
// ne bloque pas — même rattaché à une tâche : on laisse le délai courir.
const gatedLivrable = c => (c.livrables || []).find(l => l.tache_id
  && (livPending(l))
  && isLate(l.date)
  && (c.taches || []).some(t => t.id === l.tache_id && !t.done));
function isBlocked(c){
  if(c.statut === "done" || c.hold) return false;   // un chantier en pause n'est pas "bloqué"
  if(c.blocage && c.blocage.trim()) return true;
  return lateAtt(c).length > 0;   // livrable non reçu et en retard (échéance dépassée)
}
const colOf = c => (c.statut !== "done" && isBlocked(c)) ? "block" : c.statut;
const blockReason = c => {
  if(c.blocage && c.blocage.trim()) return c.blocage.trim();
  const g = gatedLivrable(c);
  if(g) return `tâche en attente de « ${g.quoi} » (${g.personne})`;
  const l = lateAtt(c)[0];
  return l ? `livrable en retard : « ${l.quoi} » (${l.personne}, attendu le ${fmt(l.date)})` : "";
};

const dparse = s => { const a = s.split("-").map(Number); return new Date(Date.UTC(a[0], a[1] - 1, a[2])); };
const dstr = dt => dt.toISOString().slice(0, 10);
function addDays(s, n){ const dt = dparse(s); dt.setUTCDate(dt.getUTCDate() + n); return dstr(dt); }
function daysBetween(a, b){ return Math.round((dparse(b) - dparse(a)) / 86400000); }
function fmt(d){ if(!d) return "—"; const p = d.split("-"); return `${p[2]}/${p[1]}/${p[0]}`; }
function fmtShort(d){ if(!d) return "—"; const p = d.split("-"); return `${p[2]}/${p[1]}`; }
function fmtDT(iso){ if(!iso) return ""; const [d, tm] = iso.split("T"); return fmtShort(d) + (tm ? " à " + tm.slice(0, 5) : ""); }   // "15/06 à 14:30"
const isWeekend = dt => { const d = dt.getUTCDay(); return d === 0 || d === 6; };

// ---- Jours non travaillés (congés / RTT / fériés) -------------------------
// OFF = toutes les dates couvertes par une absence qui pèse sur MON planning :
// une absence sans contact (= moi) ou un jour férié (vaut pour tout le monde).
// Une absence rattachée à un autre contact reste informative : sans affectation
// des tâches aux personnes, on ne saurait pas quelles dates décaler.
let OFF = new Set();
function absBlocksPlan(a, moi){ return a.type === "ferie" || !a.contact_id || a.contact_id === moi; }
function rebuildOff(){
  OFF = new Set();
  const moi = (STORE.contacts || []).find(c => c.moi)?.id || null;
  (STORE.absences || []).forEach(a => {
    if(!a.debut || !a.fin || !absBlocksPlan(a, moi)) return;
    let d = a.debut, guard = 0;
    while(d <= a.fin && guard++ < 400){ OFF.add(d); d = addDays(d, 1); }
  });
}
// Jour non travaillé : week-end (si planning en jours ouvrés) ou absence posée (toujours).
const isOff = dt => (SETTINGS.jours_ouvres && isWeekend(dt)) || OFF.has(dstr(dt));
const isOffISO = d => (SETTINGS.jours_ouvres && isWeekend(dparse(d))) || OFF.has(d);

// Unités de planning : jours ouvrés (si réglé) ou calendaires. Les échéances/compteurs réels restent en daysBetween.
function addUnits(s, n){
  if(!SETTINGS.jours_ouvres && !OFF.size) return addDays(s, n);
  const dt = dparse(s), step = n >= 0 ? 1 : -1; let rem = Math.abs(Math.round(n));
  let guard = 0;                                  // garde-fou : une année entière posée en congés bouclerait
  while(rem > 0 && guard++ < 4000){ dt.setUTCDate(dt.getUTCDate() + step); if(!isOff(dt)) rem--; }
  return dstr(dt);
}
function workOffset(start, date){
  if(!SETTINGS.jours_ouvres && !OFF.size) return daysBetween(start, date);
  const dt = dparse(start), tgt = dparse(date); let k = 0;
  if(tgt >= dt){ while(dt < tgt){ dt.setUTCDate(dt.getUTCDate() + 1); if(!isOff(dt)) k++; } }
  else { while(dt > tgt){ dt.setUTCDate(dt.getUTCDate() - 1); if(!isOff(dt)) k--; } }
  return k;
}

// ---- API -----------------------------------------------------------------
function connError(show){   // bandeau si le serveur ne répond plus (relancé / fermé)
  let el = document.getElementById("connerr");
  if(show){
    if(!el){
      el = document.createElement("div"); el.id = "connerr"; el.className = "conn-err";
      el.innerHTML = `⚠ Connexion au serveur perdue — relance le serveur (Suivi.bat), puis <a onclick="location.reload()">recharge la page</a>.`;
      document.body.appendChild(el);
    }
    el.style.display = "block";
  } else if(el){ el.remove(); }
}
async function api(method, path, body){
  let r;
  try{
    r = await fetch(path, {method, headers: {"Content-Type": "application/json"},
                           body: body ? JSON.stringify(body) : undefined});
  }catch(e){ connError(true); throw e; }                 // serveur injoignable
  if(!r.ok){ connError(true); throw new Error("HTTP " + r.status); }
  connError(false);
  return r.json();
}
async function loadStore(){
  let d;
  try{ d = await api("GET", "/api/store"); }
  catch(e){ return; }                                    // bandeau déjà affiché ; on garde l'écran courant
  STORE = d.store; TODAY = d.today;
  if(STORE.settings) SETTINGS = {...SETTINGS, ...STORE.settings};
  rebuildOff();                                          // après SETTINGS : isOff dépend de jours_ouvres
  if(CUR && chById(CUR)) renderPage(); else { CUR = null; showView("board"); }
  renderNotif(); checkDesktopNotifs();
}
// Renvoie true si le serveur a bien enregistré, false sinon. Les appelants qui
// tiennent une saisie en cours (bloc-notes) s'en servent pour ne surtout PAS
// effacer le brouillon quand l'enregistrement a échoué.
async function mutate(op){
  let d;
  try{ d = await api("POST", "/api/mutate", op); }
  catch(e){ return false; }                              // échec réseau : bandeau affiché, on n'altère rien
  if(d.error){ alert(d.error); return false; }
  STORE = d.store; TODAY = d.today;
  if(STORE.settings) SETTINGS = {...SETTINGS, ...STORE.settings};
  rebuildOff();                                          // après SETTINGS : isOff dépend de jours_ouvres
  if($("cdc").style.display !== "none" && CUR_CDC && chById(CUR_CDC)) renderCdc();
  else if(CUR && chById(CUR)) renderPage();
  else { CUR = null; showView(VIEW); }
  renderNotif();
  return true;
}

// ---- vues ----------------------------------------------------------------
let VIEW = "board";
let SHOW_ALL_DONE = false;   // colonne « Terminé » : repliée (3 derniers) ou dépliée (tout)
const DONE_PREVIEW = 3;      // nb de chantiers terminés montrés quand la colonne est repliée
// Récence d'un chantier terminé : dernière date de complétion d'une de ses tâches ("" si aucune).
function lastDoneDate(c){
  let d = "";
  (c.taches || []).forEach(t => { if(t.done && t.done_date && t.done_date > d) d = t.done_date; });
  return d;
}
// Plafond WIP (même règle que le serveur) : nb de chantiers « En cours » (statut doing, hors pause).
function doingCount(){ return STORE.chantiers.filter(c => c.statut === "doing" && !c.hold).length; }
// Limite WIP : nb max de chantiers « En cours ». 0 (ou absent) => aucune limite, on ne bloque jamais.
function wipLimit(){ return +SETTINGS.wip_max || 0; }
// Démarrer une tâche d'un chantier « à faire » est bloqué si la limite est déjà atteinte.
function startBlocked(c){ const lim = wipLimit(); return lim > 0 && c.statut === "todo" && !c.hold && doingCount() >= lim; }
function wipFullMsg(){ return `Limite de ${wipLimit()} chantiers « En cours » atteinte.\\nTerminez ou mettez en pause un chantier avant de démarrer un nouveau.`; }
// Colonne « À faire » : inclut les chantiers en pause, rangés par échéance ou avancement,
// repliée aux TODO_PREVIEW premiers. « En cours » partage le même tri (état indépendant).
let TODO_SORT = "echeance";    // "echeance" | "avancement"
let DOING_SORT = "echeance";   // idem pour la colonne « En cours »
let TODO_COLLAPSED = true;
const TODO_PREVIEW = 5;
function sortColumn(list, mode){
  return list.slice().sort((a, c) => {
    const ha = a.hold ? 1 : 0, hc = c.hold ? 1 : 0;
    if(ha !== hc) return ha - hc;                                                // actifs toujours avant les pausés
    if(mode === "avancement"){ const d = pct(c) - pct(a); if(d) return d; }    // plus avancé d'abord
    const ea = a.echeance || "9999-99-99", eb = c.echeance || "9999-99-99";      // sans échéance en dernier
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });
}
function sortTodo(list){ return sortColumn(list, TODO_SORT); }
function showView(v){
  if(["board", "charge", "people", "dash", "contacts", "absences", "risques", "planning", "activite",
      "cahiers", "recettes", "rapport", "actions", "notes", "themes"].includes(v)) VIEW = v;
  $("board").style.display = v === "board" ? "flex" : "none";
  $("actions").style.display = v === "actions" ? "block" : "none";
  $("notes").style.display = v === "notes" ? "block" : "none";
  $("themes").style.display = v === "themes" ? "block" : "none";
  $("planning").style.display = v === "planning" ? "block" : "none";
  $("dash").style.display = v === "dash" ? "block" : "none";
  $("activite").style.display = v === "activite" ? "block" : "none";
  $("rapport").style.display = v === "rapport" ? "block" : "none";
  $("charge").style.display = v === "charge" ? "block" : "none";
  $("risques").style.display = v === "risques" ? "block" : "none";
  $("people").style.display = v === "people" ? "grid" : "none";
  $("contacts").style.display = v === "contacts" ? "block" : "none";
  $("absences").style.display = v === "absences" ? "block" : "none";
  $("cahiers").style.display = v === "cahiers" ? "block" : "none";
  $("cdc").style.display = v === "cdc" ? "block" : "none";
  $("recettes").style.display = v === "recettes" ? "block" : "none";
  $("page").style.display = v === "page" ? "block" : "none";
  document.querySelectorAll(".nav button").forEach(b => {
    const grp = b.dataset.group ? b.dataset.group.split(",") : (b.dataset.v ? [b.dataset.v] : []);
    b.classList.toggle("on", grp.includes(v));
  });
  renderAlert();
  if(v === "board") renderBoard();
  if(v === "actions") renderActions();
  if(v === "notes") renderNotes();
  if(v === "themes") renderThemes();
  if(v === "planning") renderPlanning();
  if(v === "dash") renderDashboard();
  if(v === "activite") renderActivite();
  if(v === "rapport") renderRapport();
  if(v === "charge") renderCharge();
  if(v === "risques") renderRisques();
  if(v === "people") renderPeople();
  if(v === "contacts") renderContacts();
  if(v === "absences") renderAbsences();
  if(v === "cahiers") renderCahiers();
  if(v === "cdc") renderCdc();
  if(v === "recettes") renderRecettes();
}
function setView(v){ CUR = null; showView(v); }

// menu déroulant (Excel : import / modèle / export)
function toggleMenu(e, id){
  e.stopPropagation();
  const m = $(id), willOpen = !m.classList.contains("open");
  document.querySelectorAll(".menu.open").forEach(x => x.classList.remove("open"));
  if(willOpen) m.classList.add("open");
}
document.addEventListener("click", () => document.querySelectorAll(".menu.open").forEach(m => m.classList.remove("open")));
// Au scroll : un popup en position:fixed SUIT son ancre (sinon il se détacherait) ; on ne le
// ferme que si l'ancre quitte l'écran, et jamais si on scrolle DANS la liste. Les menus ancrés
// (nav du header) se ferment, eux, au scroll comme avant.
document.addEventListener("scroll", e => {
  document.querySelectorAll(".menu.open").forEach(wrap => {
    const list = wrap.querySelector(".menu-list");
    if(list && list.style.position === "fixed"){
      if(e.target && e.target.nodeType && list.contains(e.target)) return;   // scroll interne à la liste
      const btn = wrap.querySelector("button"); if(!btn) return;
      const r = btn.getBoundingClientRect();
      if(r.bottom < 8 || r.top > window.innerHeight - 8){ wrap.classList.remove("open"); return; }
      list.style.top = (r.bottom + 4) + "px";
      list.style.left = r.left + "px";
    } else {
      wrap.classList.remove("open");
    }
  });
}, true);
// Menu en position:fixed (échappe au overflow:hidden des cartes) — pour le statut de risque
function fixedMenu(e, id){
  e.stopPropagation();
  const m = $(id); if(!m) return;
  const list = m.querySelector(".menu-list"), willOpen = !m.classList.contains("open");
  document.querySelectorAll(".menu.open").forEach(x => x.classList.remove("open"));
  if(willOpen && list){
    m.classList.add("open");
    const r = m.getBoundingClientRect();
    list.style.position = "fixed";
    list.style.top = (r.bottom + 4) + "px";
    list.style.left = r.left + "px";
    list.style.right = "auto";
  }
}

// ---- Listes déroulantes stylées : remplace l'apparence native de TOUS les <select> ----
// On garde le <select> (masqué) pour la valeur + l'onchange existant ; un bouton + menu
// stylé le pilotent. Popup en position:fixed → jamais rogné par une carte.
function enhanceSelects(){
  document.querySelectorAll("select:not([data-cse])").forEach(sel => {
    sel.setAttribute("data-cse", "1");
    const wrap = document.createElement("span");
    wrap.className = "cse menu";
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "cse-btn";
    btn.innerHTML = `<span class="cse-val"></span><span class="cse-car">▾</span>`;
    const valEl = btn.firstChild;
    const list = document.createElement("div");
    list.className = "menu-list cse-list";
    const rebuild = () => {
      const cur = sel.options[sel.selectedIndex];
      valEl.textContent = cur ? cur.text : "";
      list.textContent = "";
      [...sel.options].forEach((o, i) => {
        const a = document.createElement("a");
        a.className = "cse-opt" + (i === sel.selectedIndex ? " on" : "") + (o.disabled ? " dis" : "");
        a.textContent = o.text;
        a.addEventListener("click", ev => {
          ev.stopPropagation();
          if(o.disabled) return;
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event("change", {bubbles: true}));
          wrap.classList.remove("open");
          if(wrap.isConnected) rebuild();   // si pas de re-render (ex. aperçu), maj du libellé
        });
        list.appendChild(a);
      });
    };
    rebuild();
    sel.addEventListener("change", rebuild);   // valeur changée (clic option OU code) → maj du libellé
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const willOpen = !wrap.classList.contains("open");
      document.querySelectorAll(".menu.open").forEach(x => x.classList.remove("open"));
      if(willOpen){
        rebuild();
        wrap.classList.add("open");
        const r = btn.getBoundingClientRect();
        list.style.position = "fixed";
        list.style.top = (r.bottom + 4) + "px";
        list.style.left = r.left + "px";
        list.style.minWidth = r.width + "px";
        list.style.right = "auto";
      }
    });
    wrap.appendChild(btn);
    wrap.appendChild(list);
  });
}
let _cseQueued = false;
new MutationObserver(() => {
  if(_cseQueued) return; _cseQueued = true;
  requestAnimationFrame(() => { _cseQueued = false; enhanceSelects(); });
}).observe(document.body, {childList: true, subtree: true});

// ---- bandeau + board + personnes ----------------------------------------
// ---- règles globales -----------------------------------------------------
// Une tâche est "en retard" si sa PRÉVISION de fin dépasse une cible RÉELLE :
//  - référence figée présente → la fin de référence de cette tâche ;
//  - sinon → l'échéance du chantier ;
//  - sans référence ni échéance → jamais en retard (on n'a rien sur quoi se baser).
// On ne compare PAS au plan auto ancré sur la date de début (sinon un chantier démarré
// dans le passé paraît tout en retard alors que rien n'est figé).
function taskLate(c, S, id){
  const t = S.byId ? S.byId[id] : null;
  if(!t || t.done || c.hold) return false;
  const f = S.fc[id]; if(!f) return false;
  if(S.baseline){
    const b = (S.baseline.tasks || []).find(x => x.id === id);
    return b ? f.ffDate > b.end : false;
  }
  return c.echeance ? f.ffDate > c.echeance : false;
}
function lateTasks(c){   // tâches/jalons non finis en retard (prévision vs référence/échéance)
  if(c.hold) return [];
  const S = computeSchedule(c);
  return c.taches.filter(t => taskLate(c, S, t.id));
}
// Tâches en retard réellement ACTIONNABLES : celles dont TOUS les prédécesseurs sont
// terminés. Une tâche en retard dont un prédécesseur n'est pas fini est bloquée par lui
// (on ne peut pas la démarrer de toute façon) : inutile de la répéter dans les rappels,
// seul le prédécesseur — la vraie racine du retard — est signalé. Ce filtre écrase donc
// toute chaîne de dépendance sur sa seule tâche de tête, mais laisse s'afficher plusieurs
// tâches en retard sans lien entre elles (elles peuvent avancer en parallèle).
function actionableLateTasks(c){
  if(c.hold) return [];
  const S = computeSchedule(c);
  const done = id => { const t = S.byId[id]; return !t || t.done; };   // pred inconnu = ignoré
  return c.taches.filter(t => taskLate(c, S, t.id) && (S.preds[t.id] || []).every(done));
}
function relancesDues(c){
  // Pas de relance tant que l'échéance est respectée : on n'alerte qu'une fois la
  // date attendue passée, puis on re-suggère tous les SETTINGS.relance_jours jours.
  return c.livrables.filter(l => (livPending(l)) && isLate(l.date)
    && (!l.derniere || daysBetween(l.derniere, TODAY) >= SETTINGS.relance_jours));
}
function chargeData(){
  const items = [];
  STORE.chantiers.forEach(c => {
    if(c.hold) return;   // chantier en pause : hors plan de charge
    const S = computeSchedule(c);
    const tIdx = workOffset(S.start, TODAY);   // aujourd'hui dans le repère du chantier
    // « Mobile » = tâche qui a une barre dans le plan de charge (non finie, pas un jalon).
    // Un prédécesseur fini ou un jalon ne bougera jamais : sa fin est une constante.
    const mobile = id => { const x = S.byId[id]; return !!x && !x.done && !x.is_milestone; };
    c.taches.forEach(t => {
      if(t.done || t.is_milestone) return;
      const f = S.fc[t.id]; if(!f) return;
      const sl = S.sched[t.id] ? S.sched[t.id].slack : 0;
      // Deux bornes distinctes — c'est ce qui permet de rejouer la cascade des
      // dépendances pendant le glissement, sans appeler le serveur :
      //   base  = ce qui ne bougera pas (aujourd'hui, livrable attendu, preds figés)
      //   floor = base + les preds mobiles à leur place actuelle = butée gauche affichée.
      // floor reprend exactement les bornes du prévisionnel (fc) MAIS sans le début
      // imposé : déposer une barre sur la butée revient donc à effacer start_fix.
      let base = Math.max(tIdx, (S.gateF && (t.id in S.gateF)) ? S.gateF[t.id] : -1);
      const predsIn = [];
      (S.preds[t.id] || []).forEach(p => {
        if(mobile(p)) predsIn.push(p);
        else if(S.fc[p]) base = Math.max(base, S.fc[p].ffIdx);
      });
      let floor = base;
      predsIn.forEach(p => { if(S.fc[p]) floor = Math.max(floor, S.fc[p].ffIdx); });
      // Début imposé RAMENÉ AU JOUR OUVRÉ que le serveur utilise réellement : posé un
      // samedi ou pendant des congés, start_fix vaut pour le dernier jour travaillé
      // qui le précède (workOffset ne compte que les jours ouvrés). Sans cet
      // aller-retour, l'aperçu placerait la barre après les congés — pas le serveur.
      const sfx = t.start_fix ? addUnits(S.start, Math.max(0, workOffset(S.start, t.start_fix))) : null;
      items.push({chantier_id: c.id, tache_id: t.id, chantier: c.titre, label: t.label,
                  start: f.fsDate, end: f.ffDate, slack: sl, fixed: !!t.start_fix,
                  started: !!t.start_date, fige: !!c.baseline, preds: predsIn,
                  depth: S.sched[t.id] ? S.sched[t.id].depth : 0,
                  fix: sfx, base: addUnits(S.start, Math.max(0, base)),
                  minStart: addUnits(S.start, Math.max(0, floor))});
    });
  });
  if(!items.length) return {days: [], overload: 0, cap: SETTINGS.capacite_jour, items};
  let mx = items.reduce((a, i) => i.end > a ? i.end : a, items[0].end);
  const horizon = addDays(TODAY, 120); if(mx > horizon) mx = horizon;
  const days = []; let d = TODAY, guard = 0;
  while(d < mx && guard++ < 400){
    if(!isOffISO(d)){                            // congés/fériés : hors plan de charge, comme le week-end
      const active = items.filter(i => i.start <= d && d < i.end);
      days.push({date: d, count: active.length, tasks: active});
    }
    d = addDays(d, 1);
  }
  return {days, overload: days.filter(x => x.count > SETTINGS.capacite_jour).length,
          cap: SETTINGS.capacite_jour, items};
}

// Lissage assisté : pour chaque jour en surcharge, proposer de décaler UNE tâche
// qui a de la marge (slack) juste après ce jour, sans repousser la fin du projet.
const PR_RANK = {b: 0, m: 1, h: 2};   // priorité basse déplacée en premier
function levelingSuggestions(){
  const cd = chargeData();
  if(!cd.overload) return [];
  const overDays = cd.days.filter(x => x.count > cd.cap).sort((a, b) => b.count - a.count);
  const sugg = [], used = new Set();
  for(const day of overDays){
    if(sugg.length >= 8) break;
    let cand = cd.items
      .filter(i => i.slack > 0 && i.start <= day.date && day.date < i.end && !used.has(i.chantier_id + i.tache_id))
      .map(i => ({...i, ch: chById(i.chantier_id)}))
      .filter(x => x.ch && !x.ch.baseline);   // PROTÉGER les chantiers figés : on ne déplace pas leurs tâches
    cand.sort((a, b) => {
      const pr = PR_RANK[a.ch.prio] - PR_RANK[b.ch.prio];          // priorité basse d'abord
      if(pr) return pr;
      const ea = a.ch.echeance || "9999-99-99", eb = b.ch.echeance || "9999-99-99";
      if(ea !== eb) return eb > ea ? 1 : -1;                        // échéance la plus lointaine d'abord
      return b.slack - a.slack;
    });
    for(const it of cand){
      let ns = addDays(day.date, 1), g = 0;
      while(isOffISO(ns) && g++ < 400) ns = addDays(ns, 1);   // ne jamais reporter sur un jour non travaillé
      const shift = workOffset(it.start, ns);
      if(shift > 0 && shift <= it.slack){
        sugg.push({...it, newStart: ns, shift, day: day.date});
        used.add(it.chantier_id + it.tache_id);
        break;
      }
    }
  }
  return sugg;
}
function applyLeveling(cid, tid, date){
  mutate({op: "update_tache", chantier_id: cid, tache_id: tid, start_fix: date});
}
async function applyAllLeveling(){
  for(let i = 0; i < 40; i++){
    const sg = levelingSuggestions();
    if(!sg.length) break;
    const s = sg[0];
    const d = await api("POST", "/api/mutate",
      {op: "update_tache", chantier_id: s.chantier_id, tache_id: s.tache_id, start_fix: s.newStart});
    if(d.error) break;
    STORE = d.store; TODAY = d.today; if(STORE.settings) SETTINGS = {...SETTINGS, ...STORE.settings};
  }
  showView("charge");
}

function renderAlert(){
  let openL = 0, lateL = 0, lateT = 0, relances = 0, recPb = 0, recPbLate = 0;
  STORE.chantiers.forEach(c => {
    if(c.hold) return;   // chantier en pause : exclu des compteurs d'alerte
    openL += openAtt(c).length; lateL += lateAtt(c).length; lateT += lateTasks(c).length;
    relances += relancesDues(c).length;
    recPb += recProblemes(c).length; recPbLate += recProbLate(c).length;
  });
  const wip = STORE.chantiers.filter(c => colOf(c) === "doing" && !c.hold).length;
  const onhold = STORE.chantiers.filter(c => c.hold && c.statut !== "done").length;
  const over = chargeData().overload;
  const critRisk = LIVE().reduce((a, c) => a + openRisques(c).filter(r => crit(r) >= 15).length, 0);
  $("subtitle").textContent = `${LIVE().length} chantiers` + (onhold ? ` · ${onhold} en pause` : "");
  // chips lisibles : couleur = sévérité (rouge = à traiter, neutre = contexte), icône pour le scan
  const chip = (txt, o = {}) =>
    `<span class="seg ${o.cls || ""}"${o.view ? ` onclick="setView('${o.view}')"` : ""}${o.title ? ` title="${esc(o.title)}"` : ""}>` +
      (o.icon ? `<i class="seg-i">${o.icon}</i>` : "") + txt + `</span>`;
  // 1) alertes (rouge), regroupées en tête → on voit d'un coup ce qui ne va pas
  const alerts = [];
  if(lateL) alerts.push(chip(`<b>${lateL}</b> livraison(s) en retard`, {icon: "✉", cls: "bad", view: "people"}));
  if(lateT) alerts.push(chip(`<b>${lateT}</b> tâche(s) en retard`, {icon: "⏰", cls: "bad"}));
  if(relances) alerts.push(chip(`<b>${relances}</b> relance(s) à faire`, {icon: "📞", cls: "bad", view: "people"}));
  if(recPb) alerts.push(chip(`<b>${recPb}</b> point(s) de recette en problème`,
                             {icon: "🧪", cls: "bad", view: "recettes",
                              title: recPbLate ? recPbLate + " dont l'échéance est passée" : "Points à lever avant de livrer"}));
  if(over) alerts.push(chip(`<b>${over}</b> jour(s) en surcharge`, {icon: "⚡", cls: "bad", view: "charge"}));
  if(critRisk) alerts.push(chip(`<b>${critRisk}</b> risque(s) critique(s)`, {icon: "⚠", cls: "bad", view: "risques"}));
  if(wipLimit() && wip > wipLimit()) alerts.push(chip(`WIP <b>${wip}</b>/${wipLimit()}`, {cls: "bad", title: "Plus de chantiers en cours que la limite WIP"}));
  // 2) contexte (neutre)
  const status = [];
  if(openL) status.push(chip(`<b>${openL}</b> livraison(s) attendue(s)`, {icon: "⌛", view: "people"}));
  if(!wipLimit()) status.push(chip(`<b>${wip}</b> en cours`));
  else if(wip <= wipLimit()) status.push(chip(`WIP <b>${wip}</b>/${wipLimit()} en cours`));
  if(onhold) status.push(chip(`<b>${onhold}</b> en pause`, {icon: "⏸", cls: "soft"}));
  // 3) chrono actif (action, distinct) en tête, puis alertes, puis contexte
  let html = "";
  const act = activeSession();
  if(act){ const lab = act.label.length > 36 ? act.label.slice(0, 35) + "…" : act.label;
    html += `<a class="seg run" onclick="mutate({op:'clock_stop'})" title="Chrono en cours : ${esc(act.label)} (depuis ${act.debut}) — cliquer pour arrêter">⏱ ${esc(lab)} · ${act.debut} · stop</a>`; }
  else { const last = lastEndedSession();   // rien en cours : proposer de reprendre le dernier chrono
    if(last){ const lab = last.label.length > 32 ? last.label.slice(0, 31) + "…" : last.label;
      html += `<a class="seg resume" onclick="resumeLast()" title="Reprendre le chronométrage : ${esc(last.label)}">▶ Reprendre · ${esc(lab)}</a>`; } }
  if(!alerts.length) html += chip("Rien d'urgent", {icon: "✓", cls: "ok"});
  $("alert").innerHTML = html + alerts.join("") + status.join("");
  renderNotif();
}

// ======================================================================== //
//  Centre de rappels (cloche) : agrège tout ce qui est "à faire" + notif bureau
// ======================================================================== //
function lastActivity(c){   // dernière trace d'activité enregistrée sur le chantier
  const dates = [];
  notesOf(c.id).forEach(n => n.date && dates.push(n.date));
  (c.taches || []).forEach(t => { if(t.done_date) dates.push(t.done_date); if(t.start_date) dates.push(t.start_date); });
  (STORE.journal || []).forEach(j => { if(j.chantier_id === c.id && j.date) dates.push(j.date); });
  const past = dates.filter(d => d <= TODAY).sort();
  return past.length ? past[past.length - 1] : null;
}
function buildReminders(){
  const out = [];
  // actions et routines dues aujourd'hui, non faites
  acDuJour().forEach(a => {
    const late = acRetard(a);
    out.push({type: "action", icon: late ? "⏰" : a.recurrence ? "🔁" : "◻", label: a.label,
              sub: acMeta(a), late, key: "ac:" + a.id, go: () => setView("actions"),
              act: {lbl: "✓ Fait", title: "Marquer comme fait aujourd'hui",
                    run: () => mutate({op: "action_done", id: a.id, date: TODAY})}});
  });
  // occurrences de routine passées et jamais actées : la dette que l'ancien système effaçait
  const dette = acRoutines().reduce((n, a) => n + occEnSouffrance(a, TODAY).length, 0);
  if(dette) out.push({type: "dette", icon: "⏰", label: `${dette} occurrence${dette > 1 ? "s" : ""} de routine non actée${dette > 1 ? "s" : ""}`,
                      sub: "rattraper, sauter ou acter le raté", late: true, key: "dette:" + dette,
                      go: () => setView("actions")});
  // tâches en retard (fin prévue déjà passée) — seulement celles qu'on peut démarrer
  // maintenant : les tâches en retard bloquées par un prédécesseur non fini sont masquées
  // (on ne peut pas les faire tant que l'amont n'est pas terminé).
  STORE.chantiers.forEach(c => actionableLateTasks(c).forEach(t =>
    out.push({type: "tache", icon: "⏰", label: t.label, sub: "tâche en retard · " + c.titre,
              late: true, key: "lt:" + t.id, go: () => openChantier(c.id),
              // déjà démarrée -> reprendre le chrono (ne pas réécrire start_date via start_tache) ;
              // sinon la démarrer (start_tache ouvre le chrono et passe le chantier « En cours »).
              act: t.start_date
                ? {lbl: "▶ Reprendre", title: "Reprendre le chrono sur cette tâche",
                   run: () => mutate({op: "clock_start", kind: "tache", chantier_id: c.id, tache_id: t.id})}
                : {lbl: "▶ Démarrer", title: "Démarrer cette tâche (lance le chrono)",
                   run: () => mutate({op: "start_tache", chantier_id: c.id, tache_id: t.id})}})));
  // relances à faire (hors chantiers en pause)
  STORE.chantiers.forEach(c => { if(c.hold) return; relancesDues(c).forEach(l =>
    out.push({type: "relance", icon: "📞", label: "Relancer " + l.personne, sub: l.quoi + " · " + c.titre,
              key: "rl:" + l.id, go: () => setView("people"),
              act: {lbl: "📞 Relancé", title: "Marquer comme relancé aujourd'hui",
                    run: () => mutate({op: "update_livrable", chantier_id: c.id, livrable_id: l.id, relance: true})}})); });
  // points de recette en problème (hors chantiers en pause)
  STORE.chantiers.forEach(c => { if(c.hold) return; recProblemes(c).forEach(p =>
    out.push({type: "recette", icon: "🧪", label: p.titre,
              sub: "recette · " + c.titre + (p.qui ? " · " + p.qui : ""),
              late: isLate(p.echeance), key: "pt:" + p.id, go: () => openChantier(c.id),
              act: {lbl: "✓ Vérifié", title: "Le point est corrigé et re-vérifié",
                    run: () => mutate({op: "point_set", chantier_id: c.id, point_id: p.id, statut: "ok"})}})); });
  // chantiers en pause dont la date de reprise est arrivée → "à reprendre"
  STORE.chantiers.forEach(c => {
    if(c.hold && c.hold_until && c.hold_until <= TODAY)
      out.push({type: "resume", icon: "⏯️", label: "À reprendre : " + c.titre,
                sub: "reprise prévue le " + fmt(c.hold_until), late: true, key: "hr:" + c.id, go: () => openChantier(c.id),
                act: {lbl: "⏯️ Reprendre", title: "Reprendre ce chantier (le remet dans la charge)",
                      run: () => mutate({op: "set_hold", chantier_id: c.id, hold: false})}});
  });
  // revues de risque échues
  allRisques().forEach(r => {
    if(riskActive(r) && r.echeance_revue && isLate(r.echeance_revue))
      out.push({type: "risque", icon: "⚠️", label: "Revoir le risque : " + r.libelle, sub: r._c.titre,
                late: true, key: "rk:" + r.id, go: () => setView("risques")});
  });
  // cahiers des charges en attente de validation (un CdC 0..1 par chantier)
  LIVE().forEach(c => {
    const cdc = c.cdc;
    if(cdc && cdc.statut === "en_validation")
      out.push({type: "cdc", icon: "📋", label: "CdC à valider : " + (cdc.titre || c.titre),
                sub: "cahier des charges en validation · " + c.titre, key: "cdc:" + c.id,
                go: () => openCdc(c.id)});
  });
  // risques avérés non clos — traiter en priorité
  allRisques().forEach(r => {
    if(r.statut === "avere")
      out.push({type: "risque", icon: "🔥", label: "Risque avéré : " + r.libelle, sub: r._c.titre,
                late: true, key: "ra:" + r.id, go: () => setView("risques")});
  });
  // chantiers "en cours" sans avancement enregistré depuis N jours (action dans l'appli)
  const stale = SETTINGS.rappel_stale_jours || 3;
  STORE.chantiers.forEach(c => {
    if(colOf(c) !== "doing" || c.hold) return;
    const last = lastActivity(c);
    const n = last ? daysBetween(last, TODAY) : null;
    if(last && n >= stale)
      out.push({type: "stale", icon: "📝", label: "Enregistrer l'avancement : " + c.titre,
                sub: "rien enregistré depuis " + n + " j", key: "st:" + c.id, go: () => openChantier(c.id)});
    else if(!last)
      out.push({type: "stale", icon: "📝", label: "Enregistrer l'avancement : " + c.titre,
                sub: "aucune activité enregistrée", key: "st:" + c.id, go: () => openChantier(c.id)});
  });
  return out;
}
function renderNotif(){
  const items = buildReminders();
  window._reminders = items;
  const badge = $("notifBadge");
  if(badge){
    badge.style.display = items.length ? "inline-flex" : "none";
    badge.textContent = items.length > 99 ? "99+" : items.length;
  }
  const list = $("notifList"); if(!list) return;
  const perm = ("Notification" in window) ? Notification.permission : "unsupported";
  let h = `<div class="notif-head"><b>Rappels</b> <span class="muted small">${items.length} élément(s)</span>` +
    (perm === "granted" ? `<span class="muted small okperm">notifs bureau ✓</span>`
     : perm === "unsupported" ? ``
     : `<a class="lnk" onclick="event.stopPropagation();enableDesktopNotifs()">Activer les notifs bureau</a>`) + `</div>`;
  if(!items.length){
    h += `<div class="notif-empty">Rien à signaler — tout est à jour 👍</div>`;
  } else {
    h += items.map((it, i) => `<div class="notif-item${it.late ? " late" : ""}" onclick="notifGo(${i})" title="Ouvrir">` +
      `<span class="ni-ic">${it.icon}</span><span class="ni-tx">` +
      `<span class="ni-lib">${esc(it.label)}</span><span class="ni-sub">${esc(it.sub || "")}</span>` +
      `</span>` +
      (it.act ? `<button class="ni-act" title="${esc(it.act.title || it.act.lbl)}" onclick="event.stopPropagation();notifAct(${i})">${esc(it.act.lbl)}</button>` : "") +
      `</div>`).join("");
  }
  list.innerHTML = h;
}
// ---- Recherche globale (overlay header) : filtre EN DIRECT les tableaux STORE chargés.
function openSearch(e){
  if(e) e.stopPropagation();
  const m = $("searchMenu"); if(!m) return;
  document.querySelectorAll(".menu.open").forEach(x => x.classList.remove("open"));
  m.classList.add("open");
  const list = $("searchList");
  if(list){ const r = m.getBoundingClientRect(); list.style.position = "fixed"; list.style.top = (r.bottom + 6) + "px"; list.style.right = "18px"; list.style.left = "auto"; }
  const inp = $("searchInput"); if(inp){ inp.value = ""; inp.focus(); }
  renderSearch();
}
function closeSearch(){ const m = $("searchMenu"); if(m) m.classList.remove("open"); }
function buildSearch(q){
  const out = [], hit = s => s && String(s).toLowerCase().includes(q);
  STORE.chantiers.forEach(c => {
    const th = themeOf(c);
    if(hit(c.titre) || hit(c.objectif) || (th && hit(th.nom)))
      out.push({icon: "🗂", label: c.titre, sub: "chantier" + (th ? " · " + th.nom : ""), go: () => openChantier(c.id)});
    (c.livrables || []).forEach(l => { if(hit(l.quoi)) out.push({icon: "📦", label: l.quoi, sub: "livrable · " + c.titre, go: () => openChantier(c.id)}); });
    (c.risques || []).forEach(r => { if(hit(r.libelle)) out.push({icon: "⚠️", label: r.libelle, sub: "risque · " + c.titre, go: () => openChantier(c.id)}); });
    const cd = c.cdc; if(cd && (hit(cd.reference) || hit(cd.titre))) out.push({icon: "📄", label: cd.titre || cd.reference || "Cahier des charges", sub: "cahier des charges · " + c.titre, go: () => openCdc(c.id)});
    recPoints(c).forEach(p => { if(hit(p.titre) || hit(p.constat))
      out.push({icon: "🧪", label: p.titre, sub: `recette (${PT[p.statut].lbl.toLowerCase()}) · ` + c.titre,
                go: () => openChantier(c.id)}); });
  });
  (STORE.contacts || []).forEach(ct => { if(hit(ct.nom) || hit(ct.role)) out.push({icon: "👤", label: ct.nom, sub: "personne" + (ct.role ? " · " + ct.role : ""), go: () => setView("contacts")}); });
  // Actions et notes : le bloc-notes n'a d'intérêt que si on retrouve ce qu'on y a écrit.
  ACTIONS().forEach(a => { if(hit(a.label) || hit(a.desc))
    out.push({icon: a.recurrence ? "🔁" : "◻", label: a.label,
              sub: (a.recurrence ? "routine" : "action") + " · " + acMeta(a), go: () => setView("actions")}); });
  NOTES().forEach(n => { if(hit(n.titre) || hit(n.corps)){
    const ex = (n.corps || "").replace(/\s+/g, " ").slice(0, 70);
    out.push({icon: (NT_TYPE[n.type] || NT_TYPE.note).ic, label: n.titre || ex || "note",
              sub: "note · " + fmt(n.date) + (n.heure ? " " + n.heure : ""), go: () => setView("notes")});
  }});
  return out;
}
function renderSearch(){
  const box = $("searchResults"); if(!box) return;
  const q = (($("searchInput") || {}).value || "").trim().toLowerCase();
  if(!q){ window._search = []; box.innerHTML = `<div class="notif-empty">Tapez pour chercher un chantier, une personne, un livrable, un risque, un point de recette…</div>`; return; }
  const items = buildSearch(q).slice(0, 40); window._search = items;
  if(!items.length){ box.innerHTML = `<div class="notif-empty">Aucun résultat pour « ${esc(q)} ».</div>`; return; }
  box.innerHTML = items.map((it, i) => `<div class="notif-item" onclick="searchGo(${i})" title="Ouvrir">` +
    `<span class="ni-ic">${it.icon}</span><span class="ni-tx">` +
    `<span class="ni-lib">${esc(it.label)}</span><span class="ni-sub">${esc(it.sub || "")}</span></span></div>`).join("");
}
function searchGo(i){ const it = (window._search || [])[i]; if(!it) return; closeSearch(); if(it.go) it.go(); }
function notifGo(i){
  const it = (window._reminders || [])[i]; if(!it) return;
  $("notifMenu").classList.remove("open");
  if(it.go) it.go();
}
// Traite un rappel sans quitter la cloche : l'op existante s'exécute, mutate() relit le
// store et rappelle renderNotif → l'élément traité disparaît, le menu reste ouvert.
function notifAct(i){
  const it = (window._reminders || [])[i]; if(!it || !it.act) return;
  it.act.run();
}
function enableDesktopNotifs(){
  if(!("Notification" in window)){ alert("Notifications bureau non supportées par ce navigateur."); return; }
  Notification.requestPermission().then(() => { renderNotif(); checkDesktopNotifs(); });
}
function checkDesktopNotifs(){
  if(todayISO() !== TODAY){ loadStore(); return; }   // changement de jour (app laissée ouverte) : resync TODAY/rappels d'abord
  if(!("Notification" in window) || Notification.permission !== "granted") return;
  const items = buildReminders();
  const k = "notif_sent_" + TODAY;
  let sent = {}; try { sent = JSON.parse(localStorage.getItem(k) || "{}"); } catch(e){ sent = {}; }
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  items.forEach(it => {
    if(sent[it.key]) return;
    if(it.type === "action"){   // action avec heure : attendre l'heure prévue
      const a = ACTIONS().find(x => "ac:" + x.id === it.key);
      if(a && a.heure && hhmm < a.heure) return;
    }
    try { new Notification("Suivi des chantiers", {body: it.label + (it.sub ? " — " + it.sub : ""), tag: it.key}); } catch(e){}
    sent[it.key] = 1;
  });
  // purge les marqueurs des autres jours pour ne pas saturer localStorage
  Object.keys(localStorage).forEach(key => { if(key.startsWith("notif_sent_") && key !== k) localStorage.removeItem(key); });
  localStorage.setItem(k, JSON.stringify(sent));
}

function saveSetting(k, v){ mutate({op: "set_settings", settings: {[k]: v}}); }

// ---- Tableau de bord -----------------------------------------------------
function dkpi(label, val, sub, cls, onclick, help){
  return `<div class="kpi ${cls || ""}"${help ? ` title="${esc(help)}"` : ""}${onclick ? ` onclick="${onclick}" style="cursor:pointer"` : ""}>` +
    `<div class="lab">${label}${help ? ` <span class="khint">ⓘ</span>` : ""}</div><div class="num">${esc(String(val))}</div>` +
    (sub ? `<div class="sub">${esc(sub)}</div>` : "") + `</div>`;
}
function dsection(t){ return `<div class="ch-h">${t}</div>`; }
function topPersAll(m){ return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8); }
function chartBox(title, svg){ return `<div class="cardx"><div class="cardx-h">${title}</div><div class="cardx-b">${svg}</div></div>`; }
const STATUT_COLOR = {todo: "var(--gray)", doing: "var(--blue)", block: "var(--red)", recette: "#8b5cf6", done: "var(--green)"};

// Bandes repliables du tableau de bord — l'état de repli est mémorisé entre deux rendus.
const DASH_OPEN = {perf: true, livr: true, evm: false, vis: true};
function dband(key, title, inner, extra){
  const open = DASH_OPEN[key] !== false;
  return `<details class="dband" ${open ? "open" : ""} ontoggle="DASH_OPEN['${key}']=this.open">` +
    `<summary class="dband-sum"><span class="dband-t">${title}</span>${extra ? `<span class="dband-x">${extra}</span>` : ""}</summary>` +
    `<div class="dband-b">${inner}</div></details>`;
}

function hbar(rows, opts){   // barres horizontales [{label,value,color,disp}]
  opts = opts || {};
  if(!rows.length) return `<div class="empty">—</div>`;
  const max = Math.max(1, ...rows.map(r => r.value));
  const labelW = opts.labelW || 150, barW = opts.barW || 210, rowH = 24, padT = 5;
  // Gouttière de droite dimensionnée sur la valeur la plus longue (montants € inclus)
  // pour que le libellé ne se fasse jamais rogner hors du SVG.
  const gutter = Math.max(52, 13 + Math.max(0, ...rows.map(r => String(r.disp != null ? r.disp : r.value).length)) * 6);
  const W = labelW + barW + gutter, H = padT + rows.length * rowH + 6;
  let g = `<svg width="${W}" height="${H}" class="hbar">`;
  rows.forEach((r, i) => {
    const y = padT + i * rowH, w = Math.max(0, Math.round((r.value / max) * barW));
    const disp = r.disp != null ? String(r.disp) : String(r.value);
    const clk = r.onclick ? ` onclick="event.stopPropagation();${r.onclick}" style="cursor:pointer"` : "";   // barre cliquable optionnelle (filtre)
    g += `<g${clk}>`;
    g += `<text x="${labelW - 8}" y="${y + 15}" font-size="11" text-anchor="end" fill="var(--ink)" font-weight="${r.active ? 700 : 400}">${esc(String(r.label).slice(0, 24))}</text>`;
    g += `<rect x="${labelW}" y="${y + 5}" width="${barW}" height="13" rx="6.5" fill="var(--line-soft)"/>`;   // piste (fond)
    g += `<rect x="${labelW}" y="${y + 5}" width="${Math.max(4, w)}" height="13" rx="6.5" fill="${r.color || "var(--blue)"}" stroke="${r.active ? "var(--ink)" : "none"}" stroke-width="1.5"><title>${esc(String(r.label))} — ${esc(disp)}</title></rect>`;
    g += `<text x="${labelW + w + 7}" y="${y + 15}" font-size="10.5" fill="var(--muted)">${esc(disp)}</text>`;
    g += `</g>`;
  });
  return `<div class="scrollx">${g}</svg></div>`;
}
function divbar(rows){   // barres divergentes [{label,days}] : days>0 retard (rouge), <0 marge (vert)
  if(!rows.length) return `<div class="empty">Aucun chantier avec échéance.</div>`;
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.days)));
  const labelW = 160, half = 120, mid = labelW + half, rowH = 22, padT = 4;
  const W = labelW + half * 2 + 12, H = padT + rows.length * rowH + 6;
  let g = `<svg width="${W}" height="${H}" class="hbar">`;
  g += `<line x1="${mid}" y1="${padT}" x2="${mid}" y2="${H - 4}" stroke="var(--line)"/>`;
  rows.forEach((r, i) => {
    const y = padT + i * rowH, w = Math.round((Math.abs(r.days) / maxAbs) * half);
    g += `<text x="${labelW - 6}" y="${y + 14}" font-size="11" text-anchor="end" fill="var(--ink)">${esc(r.label.slice(0, 24))}</text>`;
    if(r.days > 0) g += `<rect x="${mid}" y="${y + 4}" width="${Math.max(2, w)}" height="13" rx="3" fill="var(--red)"><title>${esc(r.label)} — retard ${r.days} j</title></rect>`;
    else g += `<rect x="${mid - w}" y="${y + 4}" width="${Math.max(2, w)}" height="13" rx="3" fill="var(--green)"><title>${esc(r.label)} — marge ${-r.days} j</title></rect>`;
    g += `<text x="${r.days > 0 ? mid + w + 4 : mid - w - 4}" y="${y + 14}" font-size="10.5" fill="var(--muted)" text-anchor="${r.days > 0 ? "start" : "end"}">${r.days > 0 ? "+" + r.days + "j" : r.days + "j"}</text>`;
  });
  return `<div class="scrollx">${g}</svg></div><div class="legend"><span><i class="sq green"></i>marge (avance)</span><span><i class="sq red"></i>retard sur échéance</span></div>`;
}
function barTop(x, y, w, h, r){   // rect à coins SUPÉRIEURS arrondis (base plate sur l'axe)
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${(y + h).toFixed(1)} V${(y + r).toFixed(1)} Q${x},${y} ${x + r},${y} H${(x + w - r).toFixed(1)} Q${x + w},${y} ${x + w},${(y + r).toFixed(1)} V${(y + h).toFixed(1)} Z`;
}
function vbar(rows, opts){   // barres verticales [{label,value,disp,color}]
  opts = opts || {};
  if(!rows.length) return `<div class="empty">—</div>`;
  const max = Math.max(1, ...rows.map(r => r.value));
  const barW = opts.barW || 30, gap = opts.gap != null ? opts.gap : 10, H = 140, padB = 26, padT = 14, padL = 18;
  const col = opts.color || "var(--green)";
  const W = padL + rows.length * (barW + gap) + 8, plotH = H - padB - padT;
  const y = v => padT + plotH - (v / max) * plotH;
  let g = `<svg width="${W}" height="${H}" class="chart">`;
  rows.forEach((r, i) => {
    const bx = padL + i * (barW + gap), disp = r.disp != null ? String(r.disp) : String(r.value || "");
    if(r.value > 0) g += `<path d="${barTop(bx, y(r.value), barW, y(0) - y(r.value), 4)}" fill="${r.color || col}"><title>${esc(String(r.label))} — ${esc(disp)}</title></path>`;
    g += `<text x="${bx + barW / 2}" y="${y(r.value) - 4}" font-size="9" fill="var(--muted)" text-anchor="middle">${esc(r.value ? disp : "")}</text>`;
    g += `<text x="${bx + barW / 2}" y="${H - 8}" font-size="8" fill="var(--faint)" text-anchor="middle">${esc(String(r.label))}</text>`;
  });
  return `<div class="scrollx">${g}</svg></div>`;
}

function donutChart(rows, opts){   // [{label,value,color}] · opts.fmt(v)->str, opts.center{big,small}
  opts = opts || {};
  const total = rows.reduce((a, x) => a + x.value, 0);
  if(!total) return `<div class="empty">—</div>`;
  const fmtv = opts.fmt || (v => String(v));
  const single = rows.filter(x => x.value > 0).length === 1;   // une seule part = anneau plein
  const cx = 70, cy = 70, R = 56, Ri = 34;
  let ang = -Math.PI / 2, seg = "";
  rows.forEach(x => {
    if(x.value <= 0) return;
    if(single){   // 100 % : un arc SVG à 360° a ses extrémités confondues (ignoré par le navigateur) → anneau via <circle>
      seg += `<circle cx="${cx}" cy="${cy}" r="${(R + Ri) / 2}" fill="none" stroke="${x.color}" stroke-width="${R - Ri}">` +
        `<title>${esc(x.label)} : ${esc(fmtv(x.value))} (100%)</title></circle>`;
      return;
    }
    const a0 = ang, a1 = ang + (x.value / total) * 2 * Math.PI; ang = a1;
    const lrg = (a1 - a0) > Math.PI ? 1 : 0, pctv = Math.round(x.value / total * 100);
    const p = (rr, a) => `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
    seg += `<path d="M${p(R, a0)} A${R},${R} 0 ${lrg} 1 ${p(R, a1)} L${p(Ri, a1)} A${Ri},${Ri} 0 ${lrg} 0 ${p(Ri, a0)} Z" fill="${x.color}" ` +
      `${single ? "" : `stroke="var(--canvas)" stroke-width="2" stroke-linejoin="round"`}><title>${esc(x.label)} : ${esc(fmtv(x.value))} (${pctv}%)</title></path>`;
  });
  const big = String(opts.center ? opts.center.big : total), small = opts.center ? opts.center.small : "total";
  const lg = rows.filter(x => x.value > 0).map(x => `<span class="lg"><i style="background:${x.color}"></i>${esc(x.label)} <b>${esc(fmtv(x.value))}</b></span>`).join("");
  return `<div class="donutwrap"><svg width="140" height="140" viewBox="0 0 140 140">${seg}` +
    `<text x="70" y="68" text-anchor="middle" font-size="${big.length > 5 ? 15 : 21}" font-weight="700" fill="var(--ink)">${esc(big)}</text>` +
    `<text x="70" y="84" text-anchor="middle" font-size="9" fill="var(--muted)">${esc(small)}</text></svg><div class="dlegend">${lg}</div></div>`;
}

function thresholdBar(value, limit, max, unit, over){   // jauge linéaire avec repère de limite
  unit = unit || ""; if(over === undefined) over = limit > 0 && value > limit;
  const W = 250, padL = 6, barW = W - 12, bh = 18, y = 26;
  max = Math.max(max, value, limit, 1);
  const fill = Math.min(value, max) / max, lm = limit / max;
  let g = `<svg width="${W}" height="58">`;
  g += `<text x="${padL}" y="18" font-size="20" font-weight="700" fill="${over ? "var(--red)" : "var(--ink)"}">${value}${unit}</text>`;
  g += `<rect x="${padL}" y="${y}" width="${barW}" height="${bh}" fill="#f3f4f6" stroke="var(--line-soft)"/>`;
  g += `<rect x="${padL}" y="${y}" width="${(barW * fill).toFixed(1)}" height="${bh}" fill="${over ? "var(--red)" : "var(--blue)"}"/>`;
  if(limit > 0){
    const lx = padL + barW * lm;
    g += `<line x1="${lx}" y1="${y - 4}" x2="${lx}" y2="${y + bh + 4}" stroke="var(--ink)" stroke-width="2"/>`;
    g += `<text x="${lx}" y="${y + bh + 14}" font-size="8.5" fill="var(--muted)" text-anchor="middle">limite ${limit}${unit}</text>`;
  }
  return `<div class="scrollx">${g}</svg></div>`;
}

function wipDots(value, limit){   // une pastille par chantier en cours ; au-delà de la limite = rouge
  const n = Math.max(value, limit, 1); let dots = "";
  for(let i = 0; i < n; i++){
    const filled = i < value, over = i >= limit;
    dots += `<span class="wdot ${filled ? (over ? "over" : "on") : "off"}"></span>`;
  }
  return `<div class="wipdots">${dots}</div><div class="wlbl ${value > limit ? "bad-t" : ""}">${value} / ${limit}</div>`;
}

function heatColor(cnt, cap){
  if(cnt <= 0) return "#f3f4f6";
  if(cnt > cap) return "var(--red)";
  const t = cnt / Math.max(1, cap);
  return t <= 0.34 ? "#dbeafe" : t <= 0.67 ? "#93c5fd" : "var(--blue)";
}
function heatmapCalendar(cd){   // calendrier façon GitHub de la charge quotidienne
  if(!cd.days.length) return `<div class="empty">—</div>`;
  const cmap = {}; cd.days.forEach(d => cmap[d.date] = d.count);
  const start = cd.days[0].date, end = cd.days[cd.days.length - 1].date;
  const rowsN = SETTINGS.jours_ouvres ? 5 : 7, cell = 15, gap = 3, padL = 22, padT = 14;
  const startWd = (dparse(start).getUTCDay() + 6) % 7;
  let cells = "", maxCol = 0, d = start, guard = 0;
  while(d <= end && guard++ < 400){
    const wd = (dparse(d).getUTCDay() + 6) % 7;
    if(!(SETTINGS.jours_ouvres && wd >= 5)){
      const col = Math.floor((daysBetween(start, d) + startWd) / 7); maxCol = Math.max(maxCol, col);
      const cnt = cmap[d] || 0, x = padL + col * (cell + gap), y = padT + wd * (cell + gap);
      cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${heatColor(cnt, cd.cap)}" stroke="${cnt > cd.cap ? "var(--red)" : "#fff"}"><title>${fmt(d)} : ${cnt} tâches</title></rect>`;
    }
    d = addDays(d, 1);
  }
  const W = padL + (maxCol + 1) * (cell + gap) + 6, H = padT + rowsN * (cell + gap) + 6;
  const wdl = ["L", "M", "M", "J", "V", "S", "D"]; let lab = "";
  for(let i = 0; i < rowsN; i++) lab += `<text x="${padL - 5}" y="${padT + i * (cell + gap) + 11}" font-size="8" fill="var(--faint)" text-anchor="end">${wdl[i]}</text>`;
  return `<div class="scrollx"><svg width="${W}" height="${H}">${lab}${cells}</svg></div>` +
    `<div class="legend"><span>peu</span><span><i class="sq" style="background:#dbeafe;border-color:#dbeafe"></i></span>` +
    `<span><i class="sq" style="background:#93c5fd;border-color:#93c5fd"></i></span><span><i class="sq" style="background:var(--blue);border-color:var(--blue)"></i></span>` +
    `<span><i class="sq" style="background:var(--red);border-color:var(--red)"></i>&gt;${cd.cap}</span><span>chargé</span></div>`;
}

function bubbleMap(pts){   // carte des risques : x=jours avant échéance, y=avancement, taille=nb tâches
  if(!pts.length) return `<div class="empty">Aucun chantier avec échéance.</div>`;
  const W = 520, H = 230, padL = 34, padB = 30, padT = 12, padR = 14;
  const xs = pts.map(p => p.x); let xmin = Math.min(...xs, 0), xmax = Math.max(...xs, 7);
  if(xmin === xmax){ xmin -= 1; xmax += 1; }
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = v => padL + ((v - xmin) / (xmax - xmin)) * plotW, Y = v => padT + plotH - (v / 100) * plotH;
  let g = `<svg width="${W}" height="${H}">`;
  [0, 50, 100].forEach(v => g += `<line x1="${padL}" y1="${Y(v)}" x2="${W - padR}" y2="${Y(v)}" stroke="var(--line-soft)"/><text x="4" y="${Y(v) + 3}" font-size="9" fill="var(--faint)">${v}%</text>`);
  if(xmin <= 0 && xmax >= 0) g += `<line x1="${X(0)}" y1="${padT}" x2="${X(0)}" y2="${padT + plotH}" stroke="var(--red)" stroke-dasharray="3 3"/><text x="${X(0)}" y="${padT + 8}" font-size="8" fill="var(--red)" text-anchor="middle">échéance</text>`;
  g += `<text x="${padL}" y="${H - 4}" font-size="9" fill="var(--faint)">← en retard · jours avant échéance · à venir →</text>`;
  pts.forEach(p => {
    const cx = X(p.x), cy = Y(p.y), r = Math.max(5, Math.min(20, 6 + p.size * 1.3));
    g += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${p.color}" fill-opacity="0.5" stroke="${p.color}"><title>${esc(p.label)} — ${p.y}% — ${p.x} j</title></circle>`;
    g += `<text x="${cx}" y="${cy - r - 2}" font-size="8" fill="var(--ink)" text-anchor="middle">${esc(p.label.slice(0, 14))}</text>`;
  });
  return `<div class="scrollx">${g}</svg></div><div class="muted small">Bulle = nb de tâches · haut = avancé · à gauche de la ligne = en retard. Cible : coin haut-droit.</div>`;
}

function renderDashboard(){
  const chs = LIVE();   // tableau de bord : exclut les chantiers en pause
  const scheds = chs.map(c => ({c, S: computeSchedule(c)}));
  const active = chs.filter(c => colOf(c) !== "done");
  // A. Portefeuille
  const by = {todo: 0, doing: 0, block: 0, recette: 0, done: 0};
  chs.forEach(c => by[colOf(c)]++);
  const avg = active.length ? Math.round(active.reduce((a, c) => a + pct(c), 0) / active.length) : 0;
  // B. Délais
  let enRetard = 0, retardCumule = 0, lateTtl = 0; const ech7 = []; let jalon = null;
  scheds.forEach(({c, S}) => {
    if(c.hold) return;   // chantier en pause : hors métriques de retard
    if(colOf(c) !== "done" && c.echeance && S.fend > c.echeance) enRetard++;
    if(c.baseline){ const g = daysBetween(c.baseline.project_end, S.fend); if(g > 0) retardCumule += g; }
    lateTtl += c.taches.filter(t => taskLate(c, S, t.id)).length;
    if(colOf(c) !== "done" && c.echeance){ const j = daysBetween(TODAY, c.echeance); if(j >= 0 && j <= 7) ech7.push(c.titre); }
    c.taches.forEach(t => { if(t.is_milestone && !t.done && S.fc[t.id]){ const d = S.fc[t.id].ffDate; if(d >= TODAY && (!jalon || d < jalon.date)) jalon = {date: d, label: t.label}; } });
  });
  // C. Charge
  const cd = chargeData();
  const peak = cd.days.length ? Math.max(...cd.days.map(x => x.count)) : 0;
  const occ = cd.days.length ? Math.round(100 * (cd.days.reduce((a, x) => a + x.count, 0) / cd.days.length) / cd.cap) : 0;
  // D. Livrables
  let livOpen = 0, livLate = 0, relances = 0; const byPers = {};
  chs.forEach(c => { openAtt(c).forEach(l => { livOpen++; byPers[l.personne] = (byPers[l.personne] || 0) + 1; }); livLate += lateAtt(c).length; relances += relancesDues(c).length; });
  // E. Recette
  let recPb = 0, recPbLate = 0, recOk = 0, recTtl = 0;
  chs.forEach(c => {
    recPb += recProblemes(c).length; recPbLate += recProbLate(c).length;
    const st = recStats(c); recOk += st.ok; recTtl += st.total;
  });
  const recPct = recTtl ? Math.round(recOk / recTtl * 100) : 0;
  // E2. Risques
  let riskCrit = 0, riskAvere = 0;
  chs.forEach(c => openRisques(c).forEach(r => { if(crit(r) >= 15) riskCrit++; if(r.statut === "avere") riskAvere++; }));
  // F. Activité & hygiène
  let done7 = 0, done30 = 0, critN = 0, taskN = 0;
  chs.forEach(c => c.taches.forEach(t => { if(t.done && t.done_date){ const d = daysBetween(t.done_date, TODAY); if(d >= 0 && d <= 7) done7++; if(d >= 0 && d <= 30) done30++; } }));
  scheds.forEach(({c, S}) => c.taches.forEach(t => { if(!t.done){ taskN++; if(S.sched[t.id] && S.sched[t.id].critical) critN++; } }));
  const sansEch = active.filter(c => !c.echeance).length, sansRef = active.filter(c => !c.baseline).length;
  const critPct = taskN ? Math.round(100 * critN / taskN) : 0;
  // F2. En cours & temps de cycle réel (start_date → done_date) ; repère les tâches qui ont traîné
  let enCours = 0, traineuses = 0; const cycles = [];
  chs.forEach(c => c.taches.forEach(t => {
    if(t.start_date && !t.done && !c.hold) enCours++;
    if(t.done && t.start_date && t.done_date && !t.is_milestone){
      const cyc = Math.max(1, daysBetween(t.start_date, t.done_date));   // ≥ 1 jour : faite le jour même = 1 jour (un jalon n'a pas de cycle)
      cycles.push(cyc);
      const planned = Math.max(1, t.duree || 1);
      if(cyc > planned * 1.5 && cyc - planned >= 2) traineuses++;   // réel nettement > planifié
    }
  }));
  const cycleMoy = cycles.length ? Math.round(10 * cycles.reduce((a, b) => a + b, 0) / cycles.length) / 10 : 0;

  // données graphes additionnelles
  const persLate = {}; chs.forEach(c => openAtt(c).forEach(l => { if(isLate(l.date)) persLate[l.personne] = true; }));
  const statutRows = [["todo", "À faire"], ["doing", "En cours"], ["block", "Bloqué"], ["recette", "Recette"], ["done", "Terminé"]]
    .map(([k, l]) => ({label: l, value: by[k], color: STATUT_COLOR[k]}));
  const avancRows = active.map(c => ({label: c.titre, value: pct(c), disp: pct(c) + "%", color: STATUT_COLOR[colOf(c)]}))
    .sort((a, b) => a.value - b.value);
  const retardRows = scheds.filter(({c}) => colOf(c) !== "done" && c.echeance)
    .map(({c, S}) => ({label: c.titre, days: daysBetween(c.echeance, S.fend)}))
    .sort((a, b) => b.days - a.days);
  const persRows = topPersAll(byPers).map(([p, n]) => ({label: p, value: n, color: persLate[p] ? "var(--red)" : "var(--amber)"}));
  const ptCnt = {ok: 0, probleme: 0, a_verifier: 0};
  chs.forEach(c => { const s = recStats(c); Object.keys(ptCnt).forEach(k => ptCnt[k] += s[k]); });
  const retRows = [["ok", "Vérifié", "var(--green)"], ["probleme", "Problème", "var(--red)"],
                   ["a_verifier", "À vérifier", "var(--gray)"]]
    .map(([k, l, col]) => ({label: l, value: ptCnt[k], color: col}));
  const weeks = new Array(8).fill(0);
  chs.forEach(c => c.taches.forEach(t => { if(t.done && t.done_date){ const d = daysBetween(t.done_date, TODAY); if(d >= 0){ const w = Math.floor(d / 7); if(w < 8) weeks[w]++; } } }));
  const weekRows = weeks.map((v, i) => ({label: i === 0 ? "cette sem." : "S-" + i, value: v})).reverse();

  const bubblePts = active.filter(c => c.echeance).map(c => ({label: c.titre, x: daysBetween(TODAY, c.echeance),
    y: pct(c), size: c.taches.length, color: STATUT_COLOR[colOf(c)]}));

  // EVM — agrégat portefeuille (chantiers budgétés) — calculé en amont pour la bande
  const evmRows = scheds.map(({c, S}) => evm(c, S)).filter(E => E.BAC != null);
  let pBAC = 0, pPV = 0, pEV = 0, pAC = 0, acOn = false;
  evmRows.forEach(E => { pBAC += E.BAC; pPV += E.PV || 0; pEV += E.EV || 0; if(E.AC != null){ pAC += E.AC; acOn = true; } });
  const pSPI = (evmRows.length && pPV) ? pEV / pPV : null, pCPI = (acOn && pAC > 0) ? pEV / pAC : null;
  const pSV = pEV - pPV, pCV = acOn ? pEV - pAC : null;
  const pEAC = pCPI ? pBAC / pCPI : null, pVAC = pEAC != null ? pBAC - pEAC : null;

  // ===== Légende + repères d'interprétation (PMBOK) =====
  let h = `<div class="dlegend-bar">` +
    `<span class="leg-chip"><i class="lg-good"></i>bon</span>` +
    `<span class="leg-chip"><i class="lg-warn"></i>à surveiller</span>` +
    `<span class="leg-chip"><i class="lg-bad"></i>à risque</span>` +
    `<span class="leg-chip"><i class="lg-neut"></i>informatif</span>` +
    `<a class="lnk leg-toggle" onclick="this.parentNode.querySelector('.dref').classList.toggle('show')">Comment lire ces indicateurs ? ▾</a>` +
    `<div class="dref">` +
      `<div><b>SPI</b> (délai, EV/PV) &amp; <b>CPI</b> (coût, EV/AC) : <b class="g">≥ 1,0</b> en avance / sous budget · <b class="w">0,90–1,0</b> léger écart · <b class="b">&lt; 0,90</b> à risque.</div>` +
      `<div><b>SV</b> / <b>CV</b> (en €) : <b class="g">positif</b> = avance / économie ; <b class="b">négatif</b> = retard / dépassement.</div>` +
      `<div><b>EAC</b> (coût final estimé) : bon s'il reste ≤ budget, c.-à-d. <b>VAC</b> = BAC − EAC <b class="g">≥ 0</b>.</div>` +
      `<div><b>Retards, tâches/livrables en retard, relances, risques critiques</b> : objectif <b class="g">0</b> ; toute valeur &gt; 0 passe en <b class="b">rouge</b>.</div>` +
      (wipLimit() ? `<div><b>WIP</b> : chantiers en parallèle — bon <b class="g">≤ ${wipLimit()}</b> (au-delà : dispersion).</div>` : `<div><b>WIP</b> : chantiers en parallèle — <b class="g">aucune limite</b> définie.</div>`) +
      `<div class="muted">Survole un indicateur marqué ⓘ pour son interprétation détaillée.</div>` +
    `</div></div>`;

  // ===== Bande 1 — Performance & délais (repliable) =====
  let b1 = `<div class="kband">`;
  b1 += dkpi("Avancement moyen", avg + " %", active.length + " chantiers actifs", "", "", "Moyenne d'avancement (tâches faites) des chantiers actifs. Indicatif, pas de seuil bon/mauvais.");
  const wlim = wipLimit();
  b1 += dkpi("WIP — en cours", wlim ? (by.doing + "/" + wlim) : String(by.doing), wlim ? (by.doing > wlim ? "limite dépassée" : "dans la limite") : "illimité", wlim && by.doing > wlim ? "bad" : "good", "", wlim ? ("Chantiers menés en parallèle vs la limite. Bon ≤ " + wlim + " ; au-delà = dispersion, tout avance plus lentement.") : "Chantiers menés en parallèle. Aucune limite WIP définie (réglable dans Charge).");
  if(evmRows.length){
    b1 += dkpi("SPI — délai", fmtIdx(pSPI), (pSV >= 0 ? "+" : "") + fmtEur(pSV), idxCls(pSPI), "", "Indice de performance délai (EV/PV). ≥1 = à l'heure ou en avance · 0,90–1 = léger retard · <0,90 = en retard. Sous-texte = SV, l'écart en €.");
    b1 += dkpi("CPI — coût", fmtIdx(pCPI), pCV != null ? (pCV >= 0 ? "+" : "") + fmtEur(pCV) : "taux ?", idxCls(pCPI), "", "Indice de performance coût (EV/AC). ≥1 = sous budget · 0,90–1 = léger dépassement · <0,90 = dépassement. Requiert un taux journalier (réglages Charge).");
    b1 += dkpi("Coût final (EAC)", fmtEur(pEAC), pVAC != null ? "VAC " + (pVAC >= 0 ? "+" : "") + fmtEur(pVAC) : "—", pVAC != null ? (pVAC >= 0 ? "good" : "bad") : "", "", "Coût final estimé du portefeuille (BAC/CPI). Bon s'il reste ≤ budget : VAC ≥ 0 (vert), VAC < 0 = dépassement prévu (rouge).");
  }
  b1 += dkpi("Retard cumulé", retardCumule + " j", "Σ glissements / réf.", retardCumule ? "bad" : "good", "", "Somme des glissements de fin vs référence figée, tous chantiers. Objectif 0 j. Nécessite une référence figée.");
  b1 += dkpi("Tâches en retard", lateTtl, "à rattraper", lateTtl ? "bad" : "good", "", "Tâches/jalons non finis dont la fin PRÉVUE est déjà passée. Objectif 0.");
  b1 += dkpi("Échéances < 7 j", ech7.length, ech7.slice(0, 2).join(", ") || "rien d'imminent", ech7.length ? "bad" : "", "", "Chantiers dont l'échéance tombe dans les 7 prochains jours — à surveiller de près.");
  b1 += dkpi("Prochain jalon", jalon ? fmt(jalon.date) : "—", jalon ? jalon.label.slice(0, 22) : "aucun", "", "", "Prochain jalon non atteint, toutes échéances confondues. Informatif.");
  b1 += dkpi("Risques critiques", riskCrit, riskAvere + " avéré(s)", riskCrit ? "bad" : "good", "setView('risques')", "Risques ouverts de criticité ≥ 15 (proba × gravité). Objectif 0. Clic → registre des risques.");
  b1 += `</div>`;
  h += dband("perf", "Performance &amp; délais", b1);

  // ===== Bande 2 — Livraison & activité =====
  let b2 = `<div class="kband">`;
  b2 += dkpi("Livrables attendus", livOpen, livLate + " en retard", livLate ? "bad" : "", "setView('people')", "Livrables encore dûs ; le sous-texte compte ceux en retard (échéance passée). Rouge dès qu'un est en retard.");
  b2 += dkpi("Relances à faire", relances, "échéance dépassée", relances ? "bad" : "good", "setView('people')", "Livrables dont l'échéance est passée et non encore livrés → à relancer (puis re-suggéré tous les " + SETTINGS.relance_jours + " j). Tant que la date attendue n'est pas dépassée, aucune relance. Objectif 0.");
  b2 += dkpi("Recette vérifiée", recTtl ? recPct + " %" : "—", recOk + "/" + recTtl + " points", recTtl ? (recPct >= 90 ? "good" : recPct >= 50 ? "warn" : "bad") : "", "setView('recettes')", "Part des points de recette vérifiés, tous chantiers confondus. Clic → suivi de recette.");
  b2 += dkpi("Points en problème", recPb, recPbLate + " en retard", recPb ? "bad" : "good", "setView('recettes')", "Points de recette qui coincent. Objectif 0 avant de livrer. Clic → suivi de recette.");
  b2 += dkpi("En recette", by.recette, "chantiers en validation", "", "setView('recettes')", "Chantiers en phase de recette. Clic → suivi de recette.");
  const recT = recetteMin(null);
  b2 += dkpi("Temps recette", recT ? fmtDur(recT) : "—", "chronométré, tous chantiers", "", "setView('recettes')", "Temps total passé en recette. Le chrono démarre tout seul dès qu'un point est statué, si aucun autre chrono ne tourne.");
  // Coût main-d'œuvre déjà engagé sur TOUT le portefeuille (pas seulement les chantiers budgétés) :
  // temps chronométré valorisé au taux horaire. Indépendant du BAC.
  const mainCost = LIVE().reduce((a, c) => a + eurMin(chantierMin(c.id)), 0);
  const tauxSet = !!(+SETTINGS.taux_jour);
  b2 += dkpi("Coût main-d'œuvre", fmtEur(mainCost), fmtEur(tauxHeure()) + "/h" + (tauxSet ? "" : " (défaut)"), "", "setView('charge')", "Coût réel de main-d'œuvre déjà engagé sur TOUS les chantiers = temps chronométré valorisé au taux horaire (taux journalier / heures facturables, réglé dans Charge ; 15 €/h par défaut). Indépendant du budget — visible même sans BAC.");
  b2 += dkpi("Tâches en cours", enCours, "démarrées, non finies", "", "", "Tâches démarrées et pas encore terminées (hors chantiers en pause). Informatif — à recouper avec le WIP.");
  b2 += dkpi("Temps de cycle", cycleMoy + " j", cycles.length + " mesurée(s)", "", "", "Durée réelle moyenne d'une tâche (début réel → fin réelle). Plus c'est court, plus le flux est fluide.");
  b2 += dkpi("Terminées (7 j)", done7, done30 + " sur 30 j", "good", "", "Débit récent : tâches terminées sur 7 et 30 jours. Plus c'est haut, mieux c'est.");
  b2 += dkpi("Ont traîné", traineuses, "cycle ≫ planifié", traineuses ? "bad" : "good", "", "Tâches dont le cycle réel dépasse nettement la durée planifiée (×1,5 et ≥ 2 j). Objectif 0 — pointe les estimations à revoir.");
  b2 += dkpi("Sans échéance", sansEch, "chantiers actifs", sansEch ? "bad" : "good", "", "Chantiers actifs sans date d'échéance → impossible de mesurer leur retard. Objectif 0.");
  b2 += dkpi("Sans référence", sansRef, "chantiers actifs", sansRef ? "" : "good", "", "Chantiers actifs sans planning de référence figé → pas de mesure de dérive (SV, retard cumulé). À figer.");
  b2 += `</div>`;
  h += dband("livr", "Livraison &amp; activité", b2);

  // ===== Bande — Cohérence des données (repliable) =====
  // Anomalies calculées sur des champs existants ; chaque ligne ouvre le chantier concerné.
  const cohAnoms = [];
  const cohYr = +TODAY.slice(0, 4);
  STORE.chantiers.forEach(c => {
    const cohPush = txt => cohAnoms.push(`<div class="coh-row" onclick="openChantier('${c.id}')"><span class="coh-ch">${esc(c.titre)}</span><span class="coh-txt">${esc(txt)}</span></div>`);
    (c.livrables || []).forEach(l => {
      if(l.date){ const y = +l.date.slice(0, 4); if(y < cohYr - 1 || y > cohYr + 5) cohPush("Livrable « " + (l.quoi || l.personne || "?") + " » — date aberrante (" + fmt(l.date) + ")"); }
      if(livPending(l) && !l.date) cohPush("Livrable dû sans date — « " + (l.quoi || l.personne || "?") + " »");
      if(!l.contact_id) cohPush("Livrable sans contact annuaire — « " + (l.quoi || l.personne || "?") + " »");
    });
    (c.taches || []).forEach(t => { if(t.done && !t.done_date) cohPush("Tâche faite sans date de réalisation — « " + t.label + " »"); });
    risquesOf(c).forEach(r => { if(r.statut === "avere") cohPush("Risque avéré non clos — « " + (r.libelle || "?") + " »"); });
  });
  const bcoh = cohAnoms.length ? `<div class="cohlist">${cohAnoms.join("")}</div>` : `<div class="empty">Aucune anomalie détectée — données cohérentes.</div>`;
  h += dband("coherence", "Cohérence des données", bcoh, cohAnoms.length ? cohAnoms.length + " anomalie(s)" : "OK");

  // ===== Détail EVM (€) si budgété =====
  if(evmRows.length){
    let be = `<div class="kband">`;
    be += dkpi("Budget total (BAC)", fmtEur(pBAC), evmRows.length + " budgété(s)", "", "", "Budget à l'achèvement — somme des budgets saisis sur les chantiers.");
    be += dkpi("Valeur acquise (EV)", fmtEur(pEV), fmtPctw(pBAC ? pEV / pBAC : null) + " du budget", "", "", "Earned Value : budget correspondant au travail RÉELLEMENT fait (fait = 100 %, en cours = 50 %).");
    be += dkpi("Valeur planifiée (PV)", fmtEur(pPV), fmtPctw(pBAC ? pPV / pBAC : null) + " prévu à date", "", "", "Planned Value : budget qui DEVRAIT être consommé à aujourd'hui selon le planning. EV vs PV → avance / retard.");
    be += dkpi("Coût réel (AC)", acOn ? fmtEur(pAC) : "—", acOn ? "temps chrono × taux" : "définis un taux/jour", "", "", "Actual Cost : coût réel main-d'œuvre = temps chronométré (jours-personnes) × taux journalier. EV vs AC → sous / sur budget.");
    be += dkpi("Reste à dépenser (ETC)", (pEAC != null && acOn) ? fmtEur(pEAC - pAC) : "—", "estimé", "", "", "Estimate To Complete : ce qu'il reste à dépenser pour finir, au rythme de coût actuel (EAC − AC).");
    be += `</div>`;
    h += dband("evm", "Valeur acquise (EVM) — détail", be);
  }

  // ===== Visuels — grands graphes souples puis grille dense (repliable) =====
  let bv = `<div class="dash-row">` +
    chartBox("Risques — urgence × avancement", bubbleMap(bubblePts)) +
    chartBox("Marge / retard vs échéance (j)", divbar(retardRows)) +
    chartBox("Charge — calendrier (lim. " + cd.cap + ")", cd.days.length ? heatmapCalendar(cd) : `<div class="empty">—</div>`) + `</div>`;
  bv += `<div class="dgrid">`;
  bv += chartBox("Répartition par statut", donutChart(statutRows));
  bv += chartBox("Avancement / chantier", hbar(avancRows, {labelW: 120, barW: 110}));
  const coutRows = LIVE().map(c => ({t: c.titre, m: chantierMin(c.id)})).filter(r => r.m > 0)
    .sort((a, b) => b.m - a.m).slice(0, 8)
    .map(r => ({label: r.t, value: eurMin(r.m), disp: fmtEur(eurMin(r.m)), color: "var(--blue)"}));
  if(coutRows.length) bv += chartBox("Coût main-d'œuvre / chantier", hbar(coutRows, {labelW: 120, barW: 110}));
  bv += chartBox("Livrables / personne", hbar(persRows, {labelW: 120, barW: 110}));
  if(recTtl) bv += chartBox("Points de recette", donutChart(retRows));
  bv += chartBox("Terminées / semaine", vbar(weekRows));
  bv += chartBox("% chemin critique", `<div class="center">${donut(critPct)}<div class="muted small">${critN}/${taskN} tâches</div></div>`);
  bv += chartBox("Taux d'occupation", thresholdBar(occ, 100, Math.max(occ, 100), "%"));
  bv += chartBox("Pic de charge", thresholdBar(peak, cd.cap, Math.max(peak, cd.cap), " tâ./j"));
  bv += chartBox("Jours en surcharge", thresholdBar(cd.overload, 0, Math.max(cd.days.length, 1), " j", cd.overload > 0));
  bv += `</div>`;
  h += dband("vis", "Visuels", bv);

  $("dash").innerHTML = h;
}

// Analyse de charge chiffrée en heures (FEATURE 10) : deux volets ajoutés à la
// vue Charge. Prévisionnel — depuis chargeData() : capacité nette = jours ouvrés
// restants (cd.days, week-ends/congés déjà exclus par isOffISO) × heures_jour ;
// demande = Σ durée des tâches non finies (Σ des count par jour) × heures_jour ;
// occupation % ; date de PREMIÈRE RUPTURE en comparant cumul demande vs cumul
// capacité jour après jour. Rétrospectif — depuis timeStats().byDay (déjà calculé) :
// occupation moyenne, pic, et nombre de jours en surcharge (> 100 %).
function chargeAnalytics(cd){
  const hj = +SETTINGS.heures_jour || 7;
  // --- Prévisionnel (jours ouvrés à venir) ---
  const workDays = cd.days.length;                          // jours ouvrés restants sur l'horizon (week-ends/congés exclus)
  const capH = Math.round(workDays * hj);                   // capacité nette disponible
  const taskDays = cd.days.reduce((a, x) => a + x.count, 0);// Σ durée (jours) des tâches non finies
  const demH = Math.round(taskDays * hj);                   // demande = charge restant à produire
  const occ = capH > 0 ? Math.round(demH / capH * 100) : 0;
  // Première rupture : 1er jour où le cumul de la demande dépasse le cumul de la capacité.
  let cum = 0, rupt = null;
  for(let i = 0; i < cd.days.length; i++){
    cum += cd.days[i].count;
    if(cum > i + 1){ rupt = cd.days[i].date; break; }
  }
  let fut = `<div class="ch-h">Charge à venir — capacité vs demande (${workDays} j ouvrés · ${hj} h/j)</div>`;
  fut += `<div class="kband">`;
  fut += dkpi("Capacité nette", capH + " h", workDays + " j ouvrés restants", "", "", "Jours ouvrés restants sur l'horizon (week-ends et congés exclus) × heures facturables/jour. Ce que tu peux réellement produire d'ici la fin des tâches planifiées.");
  fut += dkpi("Charge à faire", demH + " h", taskDays + " tâche-jours", "", "", "Somme des durées des tâches non finies × heures facturables/jour. Le travail restant à produire.");
  fut += dkpi("Occupation prévue", occ + " %", occ > 100 ? "au-dessus de la capacité" : "dans la capacité", occ > 100 ? "bad" : "good", "", "Charge à faire ÷ capacité nette. Au-delà de 100 % = plus de travail planifié que d'heures disponibles.");
  fut += dkpi("1re rupture", rupt ? fmt(rupt) : "aucune", rupt ? "cumul demande > capacité" : "capacité tenue", rupt ? "bad" : "good", "", "Premier jour où le cumul de la demande dépasse le cumul de la capacité disponible depuis aujourd'hui : la date à partir de laquelle tu prends du retard si rien ne bouge.");
  fut += `</div>`;
  fut += chartBox("Occupation prévue", thresholdBar(occ, 100, Math.max(occ, 100), "%"));
  // --- Rétrospectif (occupation réelle chronométrée) ---
  const st = timeStats(), cap = hj * 60;
  const occDays = Object.values(st.byDay).filter(v => v > 0).map(v => v / cap * 100);
  const avgOcc = occDays.length ? Math.round(occDays.reduce((a, b) => a + b, 0) / occDays.length) : 0;
  const peakOcc = occDays.length ? Math.round(Math.max(...occDays)) : 0;
  const overN = occDays.filter(o => o > 100).length;
  let pas = `<div class="ch-h">Charge passée — occupation réelle chronométrée (${occDays.length} j travaillés)</div>`;
  pas += `<div class="kband">`;
  pas += dkpi("Occupation moyenne", avgOcc + " %", occDays.length + " j travaillés", avgOcc > 100 ? "bad" : "", "", "Temps chronométré moyen par jour travaillé ÷ heures facturables/jour. Reflète ta charge réelle passée.");
  pas += dkpi("Pic d'occupation", peakOcc + " %", "journée la plus chargée", peakOcc > 100 ? "bad" : "", "", "Journée la plus chargée en temps chronométré, rapportée aux heures facturables/jour.");
  pas += dkpi("Jours en surcharge", overN + " j", "> 100 % de la journée", overN ? "bad" : "good", "", "Nombre de jours travaillés où le temps chronométré a dépassé les heures facturables/jour.");
  pas += `</div>`;
  pas += chartBox("Occupation moyenne réelle", thresholdBar(avgOcc, 100, Math.max(avgOcc, 100), "%"));
  return fut + pas;
}
function renderCharge(){
  const cd = chargeData();
  let h = `<div class="settings">` +
    fldNum("Capacité / jour", "capacite_jour", 1) +
    fldNum("Max chantiers en cours (0 = illimité)", "wip_max", 0) +
    fldNum("Relance après (j)", "relance_jours", 1) +
    fldNum("Taux journalier (€)", "taux_jour", 0) +
    fldNum("Heures facturables/j", "heures_jour", 1) +
    `<label class="fld"><input type="checkbox" ${SETTINGS.jours_ouvres ? "checked" : ""} ` +
    `onchange="saveSetting('jours_ouvres',this.checked)"> Jours ouvrés (exclure week-ends)</label>` +
    `<label class="fld"><span class="fl">Journée de travail</span>` +
    `<input type="time" value="${SETTINGS.jour_debut || "07:00"}" title="Début" onchange="saveSetting('jour_debut',this.value)"> → ` +
    `<input type="time" value="${SETTINGS.jour_fin || "17:51"}" title="Fin de journée — sert uniquement à fermer un chrono OUBLIÉ un jour passé. Travailler plus tard n'est jamais tronqué." onchange="saveSetting('jour_fin',this.value)"></label>` +
    `<label class="fld"><span class="fl">Pause déjeuner (exclue du temps)</span>` +
    `<input type="time" value="${SETTINGS.pause_debut || "12:00"}" title="Début pause" onchange="saveSetting('pause_debut',this.value)"> → ` +
    `<input type="time" value="${SETTINGS.pause_fin || "13:00"}" title="Fin pause" onchange="saveSetting('pause_fin',this.value)"></label>` +
    `<label class="fld"><span class="fl">Vendredi (fin, sans pause)</span>` +
    `<input type="time" value="${SETTINGS.vendredi_fin || "13:30"}" title="Le vendredi : journée jusqu'à cette heure, sans pause déjeuner" onchange="saveSetting('vendredi_fin',this.value)"></label></div>`;
  h += chargeAnalytics(cd);
  h += `<div class="ch-h">Plan de charge — tâches actives par jour · limite <b>${cd.cap}</b> · horizon 120 j</div>`;
  if(!cd.days.length){ $("charge").innerHTML = h + `<div class="empty">Aucune tâche active planifiée.</div>`; return; }
  h += chargeChart(cd);
  h += `<div class="ch-h">Replanifier à la main — une barre par tâche <span class="muted small" style="font-weight:400">· glisse-la sur l'axe</span></div>`;
  h += chargeGantt(cd);
  const over = cd.days.filter(x => x.count > cd.cap);
  if(over.length){
    // Lissage assisté
    const sg = levelingSuggestions();
    h += `<div class="ch-h">Lissage assisté` +
         (sg.length ? ` <button class="btn sm primary" onclick="applyAllLeveling()">Tout lisser (${sg.length})</button>` : ``) + `</div>`;
    if(sg.length){
      h += `<div class="muted small" style="margin-bottom:8px">On ne décale que des tâches qui ont de la marge — la fin du projet ne bouge pas.</div>`;
      sg.forEach(s => {
        h += `<div class="sugg"><div class="sg-txt">Décaler <b>${esc(s.label)}</b> <span class="muted">— ${esc(s.chantier)}</span><br>` +
          `<span class="muted">de ${s.shift} j → début le <b>${fmt(s.newStart)}</b> · marge dispo ${s.slack} j · soulage le ${fmt(s.day)}</span></div>` +
          `<button class="btn sm primary" onclick="applyLeveling('${s.chantier_id}','${s.tache_id}','${s.newStart}')">Appliquer</button></div>`;
      });
    } else {
      h += `<div class="muted small" style="margin-bottom:10px">Aucune tâche déplaçable : sur les jours surchargés, les tâches sont soit <b>figées</b> (protégées), soit sur le <b>chemin critique</b> (sans marge). Réduis la charge en allongeant une échéance, en retirant une tâche, ou en défigeant un chantier.</div>`;
    }
    h += `<div class="ch-h">Jours en surcharge (${over.length})</div>`;
    over.forEach(x => {
      h += `<div class="overday"><b>${fmt(x.date)}</b> — ${x.count} tâches (limite ${cd.cap})<ul>` +
        x.tasks.map(t => {
          const ch = chById(t.chantier_id), fige = ch && ch.baseline;
          const tag = fige ? ` <span class="figbadge">figé — protégé</span>`
                    : (t.slack > 0 ? ` <span class="movable">marge ${t.slack} j</span>` : ` <span class="muted">(critique)</span>`);
          return `<li>${esc(t.label)} <span class="muted">— ${esc(t.chantier)}</span>${tag}</li>`;
        }).join("") + `</ul></div>`;
    });
  } else {
    h += `<div class="ok-note">Aucune journée au-dessus de la limite de ${cd.cap} tâches.</div>`;
  }
  $("charge").innerHTML = h;
  gcBind();   // écouteurs de glissement : posés APRÈS l'injection du HTML
}
function fldNum(label, key, min){
  return `<span class="fld"><span class="fl">${label}</span><input type="number" min="${min}" value="${SETTINGS[key]}" ` +
    `onchange="saveSetting('${key}',+this.value)"></span>`;
}
function chargeChart(cd){
  const dayW = 15, H = 170, padB = 30, padT = 12, padL = 26;
  const maxC = Math.max(cd.cap + 1, ...cd.days.map(x => x.count));
  const W = padL + cd.days.length * dayW + 12, plotH = H - padB - padT;
  const y = v => padT + plotH - (v / maxC) * plotH;
  let g = `<div class="scrollx"><svg width="${W}" height="${H}" class="chart">`;
  for(let v = 0; v <= maxC; v++){
    g += `<line x1="${padL}" y1="${y(v)}" x2="${W - 6}" y2="${y(v)}" stroke="var(--line-soft)"/>`;
    g += `<text x="${padL - 4}" y="${y(v) + 3}" font-size="9" fill="var(--faint)" text-anchor="end">${v}</text>`;
  }
  g += `<line x1="${padL}" y1="${y(cd.cap)}" x2="${W - 6}" y2="${y(cd.cap)}" stroke="var(--red)" stroke-dasharray="4 3"/>`;
  cd.days.forEach((x, i) => {
    const bx = padL + i * dayW + 2, bw = dayW - 3, over = x.count > cd.cap;
    if(x.count > 0) g += `<rect x="${bx}" y="${y(x.count)}" width="${bw}" height="${y(0) - y(x.count)}" ` +
      `fill="${over ? "var(--red)" : "var(--blue)"}"><title>${fmt(x.date)} : ${x.count} tâches</title></rect>`;
    if(i % 5 === 0) g += `<text x="${bx}" y="${H - 16}" font-size="8" fill="var(--faint)">${fmtShort(x.date)}</text>`;
  });
  g += `</svg></div><div class="legend"><span><i class="sq blue"></i>dans la limite</span>` +
       `<span><i class="sq red"></i>au-dessus de ${cd.cap}</span><span>— ligne rouge = capacité</span></div>`;
  return g;
}

// ======================================================================== //
//  Plan de charge — vue par tâche : barres horizontales déplaçables
// ======================================================================== //
// Le graphe en colonnes répond à « quels jours sont chargés ? » ; celui-ci
// répond à « quelle tâche déplacer, et de combien ? ».
// Même axe que le graphe en colonnes : UNE COLONNE = UN JOUR OUVRÉ de cd.days
// (week-ends et congés déjà retirés). Glisser d'une colonne décale donc d'un
// jour de travail réel, jamais sur un samedi.
// Déposer une barre écrit start_fix (début imposé) — exactement ce qu'applique
// le lissage assisté, mais choisi à la main. Déposer sur la butée gauche
// (item.minStart : prédécesseurs, aujourd'hui, livrable attendu) efface
// start_fix et rend la tâche au calcul automatique.
// Pendant le glissement, les DÉPENDANCES sont rejouées à l'identique du serveur
// (gcLayout) : les successeurs suivent la barre tirée, en cascade. Le serveur
// refait le même calcul au dépôt — l'aperçu et le résultat coïncident.
const GC_STEPS = [8, 11, 15, 20, 28];
let GC_DW = 15;                     // largeur d'une colonne (px) — zoom, conservé entre deux rendus
const GC = {days: [], items: [], order: [], bars: {}, y: {}, cap: 3, maxC: 1, scroll: 0, drag: null};

function gcCol(days, d){            // 1re colonne dont la date est >= d (days.length si au-delà de l'horizon)
  for(let i = 0; i < days.length; i++) if(days[i].date >= d) return i;
  return days.length;
}
// Recalcule la position de TOUTES les barres, dépendances comprises. C'est la
// même règle que le prévisionnel du serveur : début = max(ce qui est figé, début
// imposé, fin de chaque prédécesseur). Parcours par profondeur = ordre topologique.
// shift = {k, delta} : la barre tirée est clouée à sa position, les autres suivent.
function gcLayout(shift){
  const pos = new Array(GC.items.length);
  GC.order.forEach(k => {
    const it = GC.items[k];
    if(shift && shift.k === k){ pos[k] = it.sCol + shift.delta; return; }
    if(it.started){ pos[k] = it.sCol; return; }   // démarrée : son début réel prime, rien ne la pousse
    let s = Math.max(it.baseCol, it.fixCol);
    it.pk.forEach(j => { if(pos[j] != null) s = Math.max(s, pos[j] + GC.items[j].span); });
    pos[k] = s;
  });
  return pos;
}
function gcCounts(pos){             // charge par colonne, à partir d'une disposition
  const n = GC.days.length, cnt = new Array(n).fill(0);
  GC.items.forEach((it, k) => {
    const s = pos ? pos[k] : it.sCol;
    for(let i = Math.max(0, s); i < Math.min(n, s + it.span); i++) cnt[i]++;
  });
  return cnt;
}
// Flèches de dépendance : fin du prédécesseur → début du successeur. Redessinées
// au zoom et à chaque colonne franchie (les barres bougent, les liens suivent).
function gcArcs(pos, hot){
  const svg = $("gcArcs"); if(!svg) return;
  const dw = GC_DW;
  let p = `<defs><marker id="gcah" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">` +
          `<path d="M0,0 L5,3 L0,6 Z" fill="#cbd5e1"/></marker>` +
          `<marker id="gcahH" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">` +
          `<path d="M0,0 L5,3 L0,6 Z" fill="var(--amber)"/></marker></defs>`;
  GC.items.forEach((it, k) => {
    const y2 = GC.y[k]; if(y2 == null) return;
    it.pk.forEach(j => {
      const y1 = GC.y[j], jt = GC.items[j]; if(y1 == null) return;
      const x1 = ((pos ? pos[j] : jt.sCol) + jt.span) * dw;
      const x2 = (pos ? pos[k] : it.sCol) * dw;
      const on = hot && (hot.has(k) || hot.has(j));
      p += `<path class="gc-arc${on ? " on" : ""}" fill="none" ` +
           `d="M${x1},${y1} C${x1 + 14},${y1} ${x2 - 14},${y2} ${x2},${y2}" ` +
           `marker-end="url(#${on ? "gcahH" : "gcah"})"/>`;
    });
  });
  svg.style.width = (GC.days.length * dw) + "px";
  svg.innerHTML = p;
}
function gcPaint(cnt){              // met à jour l'histogramme + les bandes rouges, sans re-rendre la page
  const hist = $("gcHist"), stp = $("gcStripes");
  if(!hist) return;
  let over = 0;
  for(let i = 0; i < cnt.length; i++){
    const o = cnt[i] > GC.cap; if(o) over++;
    const hc = hist.children[i], st = stp ? stp.children[i] : null;
    if(hc){
      hc.firstChild.style.height = Math.round(Math.min(cnt[i], GC.maxC) / GC.maxC * 100) + "%";
      hc.classList.toggle("over", o);
      hc.title = `${fmt(GC.days[i].date)} : ${cnt[i]} tâche(s) · limite ${GC.cap}`;
    }
    if(st) st.classList.toggle("over", o);
  }
  const b = $("gcOver");
  if(b){ b.textContent = over; b.className = over ? "bad-t" : ""; }
}
function gcZoom(dir){
  const i = Math.max(0, Math.min(GC_STEPS.length - 1, GC_STEPS.indexOf(GC_DW) + dir));
  GC_DW = GC_STEPS[i];
  const el = document.querySelector(".gc");
  if(el) el.style.setProperty("--dw", GC_DW + "px");
  gcArcs(null);   // les barres ont changé de largeur : les liens doivent suivre
}
// Confirmation discrète : ce qui vient d'être ÉCRIT dans le chantier (pas un aperçu).
function gcFlash(msg){
  const el = document.createElement("div");
  el.className = "gc-flash"; el.innerHTML = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function gcUnpin(cid, tid){ mutate({op: "update_tache", chantier_id: cid, tache_id: tid, start_fix: null}); }

function chargeGantt(cd){
  const n = cd.days.length;
  if(!n || !cd.items.length) return `<div class="empty">Aucune tâche active planifiée.</div>`;
  // repère colonne de chaque tâche — mêmes bornes que le comptage de chargeData
  // (active si start <= jour < end), donc l'aperçu colle au graphe en colonnes.
  const items = cd.items.map(it => ({...it,
    sCol: gcCol(cd.days, it.start), eCol: gcCol(cd.days, it.end),
    baseCol: gcCol(cd.days, it.base), fixCol: it.fix ? gcCol(cd.days, it.fix) : -1}));
  items.forEach(it => it.span = Math.max(0, it.eCol - it.sCol));
  // prédécesseurs repérés par NUMÉRO DE BARRE (k) : la cascade travaille sur des lignes
  const kOf = new Map(); items.forEach((it, k) => kOf.set(it.chantier_id + "|" + it.tache_id, k));
  items.forEach(it => it.pk = it.preds.map(p => kOf.get(it.chantier_id + "|" + p)).filter(k => k != null));
  GC.days = cd.days; GC.items = items; GC.cap = cd.cap;
  GC.order = items.map((it, k) => k).sort((a, b) => items[a].depth - items[b].depth);
  const cnt0 = gcCounts(null);
  GC.maxC = Math.max(cd.cap + 1, ...cnt0);
  // une ligne de titre par chantier (échéance croissante), puis ses tâches par date de début
  const byCh = new Map();
  items.forEach((it, k) => {
    if(!byCh.has(it.chantier_id)) byCh.set(it.chantier_id, []);
    byCh.get(it.chantier_id).push({...it, k});
  });
  const groups = [...byCh.entries()].map(([id, its]) => ({c: chById(id), its})).filter(g => g.c);
  groups.sort((a, b) => {
    const ea = a.c.echeance || "9999-99-99", eb = b.c.echeance || "9999-99-99";
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });

  // en-tête : un repère par lundi (trait plus marqué au changement de mois)
  let ticks = "";
  cd.days.forEach((d, i) => {
    const first = i === 0, mois = i > 0 && d.date.slice(5, 7) !== cd.days[i - 1].date.slice(5, 7);
    if(!first && !mois && dparse(d.date).getUTCDay() !== 1) return;
    ticks += `<i class="gc-tick${mois ? " m" : ""}" style="left:calc(${i} * var(--dw))">` +
             `<b>${first && d.date === TODAY ? "auj." : fmtShort(d.date)}</b></i>`;
  });
  // histogramme (aligné sur les mêmes colonnes) + bandes rouges des jours en surcharge
  let hist = "", stripes = "";
  cd.days.forEach((d, i) => {
    const o = cnt0[i] > cd.cap;
    const mois = i > 0 && d.date.slice(5, 7) !== cd.days[i - 1].date.slice(5, 7);
    const sem = i > 0 && !mois && dparse(d.date).getUTCDay() === 1;
    hist += `<div class="gc-hc${o ? " over" : ""}" style="left:calc(${i} * var(--dw))" ` +
            `title="${fmt(d.date)} : ${cnt0[i]} tâche(s) · limite ${cd.cap}">` +
            `<i style="height:${Math.round(Math.min(cnt0[i], GC.maxC) / GC.maxC * 100)}%"></i></div>`;
    stripes += `<div class="gc-st${o ? " over" : ""}${mois ? " m" : sem ? " w" : ""}" ` +
               `style="left:calc(${i} * var(--dw))"></div>`;
  });

  let rows = "", horsHorizon = 0;
  groups.forEach(g => {
    const c = g.c;
    // une tâche qui commence au-delà de l'horizon n'a pas de colonne : on la compte, sans ligne
    const vis = g.its.filter(it => it.sCol < n);
    horsHorizon += g.its.length - vis.length;
    if(!vis.length) return;
    rows += `<div class="gc-row gc-grp"><div class="gc-lab" onclick="openChantier('${c.id}')" ` +
      `title="${c.baseline ? "Chantier figé — ouvre-le pour effacer la référence et pouvoir replanifier" : "Ouvrir " + esc(c.titre)}">` +
      themeDot(c.theme_id) + `<b>${esc(c.titre)}</b>` +
      (c.baseline ? `<em class="gc-fig">🔒 figé</em>` : "") +
      (c.echeance ? `<em class="gc-ech">${fmtShort(c.echeance)}</em>` : "") +
      `</div><div class="gc-track"></div></div>`;
    vis.slice().sort((a, b) => a.sCol - b.sCol || (a.label < b.label ? -1 : 1)).forEach(it => {
      const span = it.span;
      const minCol = gcCol(cd.days, it.minStart);
      const maxCol = Math.max(minCol, n - Math.max(1, span));
      // Verrous : chantier figé (la référence ne se contourne pas à la souris — il faut
      // l'effacer dans le chantier) et tâche démarrée (son début réel prime sur start_fix).
      const drag = !it.started && !it.fige && maxCol > minCol;
      const cls = (it.started ? "run" : it.slack > 0 ? "" : "crit") + (drag ? "" : " lock");
      const nSucc = items.filter(x => x.pk.includes(it.k)).length;
      const tip = `${it.label}\n${it.chantier}\nDébut ${fmt(it.start)} · fin prévue ${fmt(it.end)} · ${span} j ouvré(s)\n` +
        (it.slack > 0 ? `Marge : ${it.slack} j (déplaçable sans repousser la fin)` : "Chemin critique : aucune marge") +
        (it.pk.length ? `\n${it.pk.length} prédécesseur(s)` : "") +
        (nSucc ? ` · ${nSucc} tâche(s) dépendante(s) — elles suivront` : "") +
        (it.fixed ? `\nDébut imposé (📌)` : "") +
        (drag ? `\n\nGlisser pour replanifier · clic : ouvrir le chantier`
              : it.fige ? `\n\n🔒 Chantier figé : la référence sert de mètre-étalon.\nEfface-la dans le chantier pour pouvoir replanifier ici.`
              : it.started ? `\n\nTâche démarrée : son début réel prime — non déplaçable ici`
                           : `\n\nAucune place pour la déplacer sur l'horizon`);
      rows += `<div class="gc-row"><div class="gc-lab">` +
        `<span class="gc-t" title="${esc(it.label)} — ${esc(it.chantier)}">${esc(it.label)}</span>` +
        (it.fixed ? `<span class="gc-pin" title="Début imposé — cliquer pour rendre au calcul automatique" ` +
                    `onclick="gcUnpin('${it.chantier_id}','${it.tache_id}')">📌</span>` : "") +
        (it.fige ? `<span class="gc-lock" title="Chantier figé — non déplaçable">🔒</span>` : "") +
        (it.started ? `<span class="gc-run" title="Tâche démarrée">⏱</span>` : "") +
        `</div><div class="gc-track">` +
        (!it.started && it.slack > 0 && span
          ? `<div class="gc-float" style="left:calc(${it.sCol + span} * var(--dw));width:calc(${it.slack} * var(--dw))" ` +
            `title="Marge : ${it.slack} j — jusqu'ici, déplacer ne repousse pas la fin"></div>` : "") +
        `<div class="gc-bar ${cls}${it.fixed ? " pin" : ""}" data-k="${it.k}" data-drag="${drag ? 1 : 0}" ` +
        (drag ? "" : `onclick="openChantier('${it.chantier_id}')" `) +   // verrouillée : le clic mène là où on peut agir
        `data-min="${minCol}" data-max="${maxCol}" ` +
        `style="left:calc(${it.sCol} * var(--dw));width:calc(${Math.max(1, span)} * var(--dw))" title="${esc(tip)}">` +
        (span >= 2 ? `<span>${span} j</span>` : "") + `</div>` +
        `</div></div>`;
    });
  });

  const over0 = cnt0.filter(v => v > cd.cap).length;
  return `<div class="gc" style="--dw:${GC_DW}px;--lw:210px">` +
    `<div class="gc-tools">` +
      `<span class="gc-hint">Glisse une barre à l'horizontale : la tâche est replanifiée <b>dans le chantier</b>, ` +
      `et ses tâches dépendantes suivent. Butée gauche = au plus tôt possible (retour au calcul automatique).</span>` +
      `<span class="gc-stat"><b id="gcOver" class="${over0 ? "bad-t" : ""}">${over0}</b> jour(s) au-dessus de ${cd.cap}</span>` +
      `<span class="gc-zoom">Zoom <button onclick="gcZoom(-1)" title="Dézoomer">−</button>` +
      `<button onclick="gcZoom(1)" title="Zoomer">+</button></span>` +
    `</div>` +
    `<div class="gc-scroll" id="gcScroll"><div class="gc-inner" style="width:calc(var(--lw) + ${n} * var(--dw))">` +
      `<div class="gc-stripes" id="gcStripes" style="left:var(--lw)">${stripes}</div>` +
      `<svg class="gc-arcs" id="gcArcs" style="left:var(--lw)"></svg>` +
      `<div class="gc-row gc-head"><div class="gc-lab"></div><div class="gc-track">${ticks}</div></div>` +
      `<div class="gc-row gc-hist"><div class="gc-lab">charge / jour</div>` +
        `<div class="gc-track" id="gcHist">${hist}` +
        `<i class="gc-cap" style="bottom:${Math.round(cd.cap / GC.maxC * 100)}%" title="Limite : ${cd.cap} tâches/jour"></i></div></div>` +
      rows +
    `</div></div>` +
    (horsHorizon ? `<div class="muted small" style="margin-top:6px">${horsHorizon} tâche(s) commencent au-delà de l'horizon de 120 j — non affichées ici.</div>` : "") +
    `<div class="legend"><span><i class="sq blue"></i>déplaçable (a de la marge)</span>` +
    `<span><i class="sq inkb"></i>critique — la déplacer repousse la fin</span>` +
    `<span><i class="sq runb"></i>⏱ démarrée (non déplaçable)</span>` +
    `<span>🔒 chantier figé — efface la référence dans le chantier pour replanifier</span>` +
    `<span><i class="sq floatb"></i>marge disponible</span>` +
    `<span><i class="sq" style="background:var(--red-bg);border-color:#f0b4b4"></i>jour au-dessus de la limite</span>` +
    `<span><i class="arc-lg"></i>dépendance (la suivante suit)</span>` +
    `<span>📌 début imposé (cliquer = auto)</span></div></div>`;
}

// Glissement : pointeur capturé sur la barre, déplacement arrondi à la colonne
// (= au jour ouvré). L'histogramme et les bandes rouges se recalculent à chaque
// colonne franchie ; rien n'est écrit tant que le bouton n'est pas relâché.
function gcBind(){
  const sc = $("gcScroll"); if(!sc) return;
  sc.scrollLeft = GC.scroll || 0;
  sc.addEventListener("scroll", () => { GC.scroll = sc.scrollLeft; }, {passive: true});
  sc.addEventListener("pointerdown", gcDown);
  // géométrie verticale mesurée sur le rendu (les lignes ne bougent plus ensuite),
  // pour tracer les flèches de dépendance et déplacer les barres poussées
  const inner = sc.firstElementChild; if(!inner) return;
  const ir = inner.getBoundingClientRect();
  GC.bars = {}; GC.y = {};
  sc.querySelectorAll(".gc-bar").forEach(b => {
    const k = +b.dataset.k, r = b.getBoundingClientRect();
    GC.bars[k] = b; GC.y[k] = r.top - ir.top + r.height / 2;
  });
  const svg = $("gcArcs"); if(svg) svg.style.height = inner.offsetHeight + "px";
  gcArcs(null);
}
// Déplace les barres selon une disposition calculée ; renvoie les lignes bougées.
function gcApply(pos){
  const moved = new Set();
  GC.items.forEach((it, k) => {
    const b = GC.bars[k]; if(!b) return;
    const d = pos[k] - it.sCol;
    if(d){ b.style.transform = `translateX(calc(${d} * var(--dw)))`; moved.add(k);
           if(!GC.drag || k !== GC.drag.k) b.classList.add("push"); }
    else { b.style.transform = ""; b.classList.remove("push"); }
  });
  return moved;
}
function gcReset(){
  Object.keys(GC.bars).forEach(k => {
    const b = GC.bars[k]; b.style.transform = ""; b.classList.remove("push", "grab");
  });
  gcPaint(gcCounts(null)); gcArcs(null);
}
function gcDown(e){
  if(e.button !== 0) return;
  const bar = e.target.closest(".gc-bar");
  if(!bar || bar.dataset.drag !== "1") return;
  const k = +bar.dataset.k, it = GC.items[k]; if(!it) return;
  e.preventDefault();
  const d = GC.drag = {k, it, bar, x0: e.clientX, delta: 0, moved: false,
                       min: +bar.dataset.min - it.sCol, max: +bar.dataset.max - it.sCol};
  if(bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
  bar.classList.add("grab");
  const inner = bar.closest(".gc-inner"); if(inner) inner.classList.add("dragging");
  d.tip = document.createElement("div"); d.tip.className = "gc-tip";
  document.body.appendChild(d.tip);
  gcTip(e);
  window.addEventListener("pointermove", gcMove);
  window.addEventListener("pointerup", gcUp);
  window.addEventListener("pointercancel", gcUp);
}
function gcMove(e){
  const d = GC.drag; if(!d) return;
  if(Math.abs(e.clientX - d.x0) > 3) d.moved = true;
  const delta = Math.max(d.min, Math.min(d.max, Math.round((e.clientX - d.x0) / GC_DW)));
  if(delta !== d.delta){
    d.delta = delta;
    const pos = gcLayout({k: d.k, delta});   // la tâche tirée + toute sa descendance
    const moved = gcApply(pos);
    d.pushed = moved.size - (moved.has(d.k) ? 1 : 0);
    gcPaint(gcCounts(pos));
    gcArcs(pos, moved);
  }
  gcTip(e);
}
function gcTip(e){
  const d = GC.drag; if(!d || !d.tip) return;
  const day = GC.days[Math.min(d.it.sCol + d.delta, GC.days.length - 1)];
  let t = `<b>${fmt(day ? day.date : d.it.start)}</b>`;
  t += d.delta ? `<span>${d.delta > 0 ? "+" : ""}${d.delta} j ouvré(s)</span>` : `<span>position actuelle</span>`;
  if(d.pushed) t += `<span class="push">↳ ${d.pushed} tâche(s) dépendante(s) suivent</span>`;
  if(d.delta === d.min) t += `<span class="ok">↩ au plus tôt — repasse en calcul automatique</span>`;
  else if(d.delta > d.it.slack) t += `<span class="warn">au-delà de la marge (${d.it.slack} j) — la fin du chantier recule</span>`;
  d.tip.innerHTML = t;
  d.tip.style.left = (e.clientX + 14) + "px";
  d.tip.style.top = (e.clientY + 18) + "px";
}
function gcUp(){
  const d = GC.drag; if(!d) return;
  window.removeEventListener("pointermove", gcMove);
  window.removeEventListener("pointerup", gcUp);
  window.removeEventListener("pointercancel", gcUp);
  GC.drag = null;
  const inner = d.bar.closest(".gc-inner"); if(inner) inner.classList.remove("dragging");
  if(d.tip) d.tip.remove();
  const it = d.it, day = GC.days[it.sCol + d.delta];
  if(!d.moved){ gcReset(); openChantier(it.chantier_id); return; }   // clic net = ouvrir le chantier
  if(!d.delta || !day){ gcReset(); return; }                          // revenu à sa place : rien à écrire
  // (chantier figé / tâche démarrée : la barre n'est pas saisissable, gcDown a déjà refusé)
  const auto = d.delta === d.min;
  // Écriture RÉELLE dans le chantier : le serveur repropage les dépendances, puis
  // le Gantt du chantier, les retards et la fin calculée bougent d'autant.
  // On laisse l'aperçu à l'écran le temps de l'aller-retour : s'il a abouti, la vue
  // est reconstruite (la barre tirée n'est plus dans le document) ; sinon on remet
  // l'écran en phase avec les données, qui n'ont pas changé.
  mutate({op: "update_tache", chantier_id: it.chantier_id, tache_id: it.tache_id,
          start_fix: auto ? null : day.date}).then(() => {
    if(d.bar.isConnected){ gcReset(); return; }
    gcFlash(`<b>${esc(it.label)}</b> — ${esc(it.chantier)}<span>` +
      (auto ? `début rendu au calcul automatique (${fmt(it.minStart)})`
            : `début imposé au ${fmt(day.date)}`) +
      (d.pushed ? ` · ${d.pushed} tâche(s) dépendante(s) décalée(s)` : "") + `</span>`);
  });
}

// (12) Filtres & recherche du portefeuille — état module, sans appel serveur.
const BOARD_F = {q: "", prio: null, themes: new Set(), etats: new Set(), _focus: false};
function matchFilter(c){
  const F = BOARD_F;
  if(F.q && !(c.titre || "").toLowerCase().includes(F.q.toLowerCase())) return false;
  if(F.prio && c.prio !== F.prio) return false;
  if(F.themes.size && !F.themes.has(c.theme_id || "")) return false;
  for(const e of F.etats){
    if(e === "late" && !lateTasks(c).length) return false;
    if(e === "att"  && !openAtt(c).length)   return false;
    if(e === "risk" && !(topCrit(c) >= 10))  return false;
    if(e === "hold" && !c.hold)              return false;
  }
  return true;
}
function boardSearch(v){ BOARD_F.q = v; BOARD_F._focus = true; renderBoard(); }
function boardTogglePrio(p){ BOARD_F.prio = BOARD_F.prio === p ? null : p; renderBoard(); }
function boardToggleTheme(t){ BOARD_F.themes.has(t) ? BOARD_F.themes.delete(t) : BOARD_F.themes.add(t); renderBoard(); }
function boardToggleEtat(e){ BOARD_F.etats.has(e) ? BOARD_F.etats.delete(e) : BOARD_F.etats.add(e); renderBoard(); }
function boardClearF(){ BOARD_F.q = ""; BOARD_F.prio = null; BOARD_F.themes.clear(); BOARD_F.etats.clear(); renderBoard(); }
function renderBoard(){
  const b = $("board"); b.innerHTML = "";
  { // (12) barre légère de filtres/recherche, en tête du board
    const F = BOARD_F, bar = document.createElement("div"); bar.className = "board-filter";
    // Le thème remplace le tag comme axe de filtrage : 10 boutons stables au lieu
    // d'une liste qui enflait à chaque nouveau chantier.
    const used = new Set(LIVE().map(c => c.theme_id || ""));
    const active = F.q || F.prio || F.themes.size || F.etats.size;
    let bh = `<input id="boardQ" class="bf-q" type="text" placeholder="Rechercher un chantier…" value="${esc(F.q)}" oninput="boardSearch(this.value)">`;
    bh += `<span class="bf-grp">` + Object.keys(PRIO).map(p =>
      `<button class="bf-seg ${F.prio === p ? "on" : ""}" onclick="boardTogglePrio('${p}')">${PRIO[p]}</button>`).join("") + `</span>`;
    bh += `<span class="bf-grp">` + [["late", "⏰ retard"], ["att", "⌛ attente"], ["risk", "⚠ risque"], ["hold", "⏸ pause"]].map(([k, l]) =>
      `<button class="bf-seg ${F.etats.has(k) ? "on" : ""}" onclick="boardToggleEtat('${k}')">${l}</button>`).join("") + `</span>`;
    bh += `<span class="bf-grp th-filter">` + THEMES_ON().filter(t => used.has(t.id)).map(t =>
      `<button class="th-fb ${F.themes.has(t.id) ? "on" : ""}" style="--th:${t.couleur}" ` +
      `onclick="boardToggleTheme('${t.id}')">${t.icone} ${esc(t.nom)}</button>`).join("") +
      (used.has("") ? `<button class="th-fb ${F.themes.has("") ? "on" : ""}" onclick="boardToggleTheme('')">○ sans thème</button>` : "") +
      `</span>`;
    if(active) bh += `<button class="bf-clear" onclick="boardClearF()">✕ effacer</button>`;
    bar.innerHTML = bh; b.appendChild(bar);
  }
  COLS.forEach(col => {
    const isDone = col.key === "done";
    const isTodo = col.key === "todo";
    let cards;
    if(isTodo){        // À faire = todos actifs + TOUS les chantiers en pause, rangés selon TODO_SORT
      cards = sortTodo(STORE.chantiers.filter(c => c.hold || colOf(c) === "todo"));
    } else if(isDone){ // Terminé : du plus récemment terminé au plus ancien
      cards = LIVE().filter(c => colOf(c) === col.key)
        .sort((a, c) => (lastDoneDate(c) < lastDoneDate(a) ? -1 : lastDoneDate(c) > lastDoneDate(a) ? 1 : (a.ordre || 0) - (c.ordre || 0)));
    } else if(col.key === "doing"){   // En cours : rangée par échéance ou avancement (comme « À faire »)
      cards = sortColumn(LIVE().filter(c => colOf(c) === col.key), DOING_SORT);
    } else {           // autres colonnes : ordre manuel du board
      cards = LIVE().filter(c => colOf(c) === col.key).sort((a, c) => (a.ordre || 0) - (c.ordre || 0));
    }
    cards = cards.filter(matchFilter);   // (12) filtres du portefeuille appliqués AVANT comptage/rendu
    const total = cards.length;
    // À faire / Terminé repliés : on ne montre que les N premiers ; un bouton déplie le reste.
    const preview = isDone ? DONE_PREVIEW : TODO_PREVIEW;
    const collapsed = ((isDone && !SHOW_ALL_DONE) || (isTodo && TODO_COLLAPSED)) && total > preview;
    const visible = collapsed ? cards.slice(0, preview) : cards;
    const el = document.createElement("div");
    el.className = "col"; el.dataset.col = col.key;
    const autoNote = col.key === "block" ? `<span class="auto">auto</span>` : "";
    el.innerHTML = `<div class="col-h s-${col.key}"><span class="nm">${col.label}</span>${autoNote}<span class="ct">${total}</span></div>`;
    const body = document.createElement("div"); body.className = "col-body";
    if(col.key !== "block"){   // la colonne Bloqué est calculée → pas une cible de drop
      el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
      el.addEventListener("dragleave", () => el.classList.remove("over"));
      el.addEventListener("drop", e => {
        e.preventDefault(); el.classList.remove("over");
        const id = e.dataTransfer.getData("id"); const c = chById(id);
        if(c && c.statut !== col.key) mutate({op: "move_chantier", id, statut: col.key});
      });
    }
    if((isTodo || col.key === "doing") && total){   // barre de tri : Échéance / Avancement (À faire + En cours)
      const setter = isTodo ? "TODO_SORT" : "DOING_SORT", mode = isTodo ? TODO_SORT : DOING_SORT;
      const bar = document.createElement("div"); bar.className = "todo-tools";
      bar.innerHTML = `<span class="tt-lbl">Trier</span>` +
        `<button class="tt-seg ${mode === "echeance" ? "on" : ""}" onclick="event.stopPropagation();${setter}='echeance';renderBoard()">Échéance</button>` +
        `<button class="tt-seg ${mode === "avancement" ? "on" : ""}" onclick="event.stopPropagation();${setter}='avancement';renderBoard()">Avancement</button>`;
      body.appendChild(bar);
    }
    if(!visible.length){ const e = document.createElement("div"); e.className = "empty"; e.textContent = "—"; body.appendChild(e); }
    visible.forEach(c => {
      const open = openAtt(c), late = lateAtt(c);
      const card = document.createElement("div");
      card.className = `card p-${c.prio}${c.hold ? " on-hold" : ""}`;
      card.draggable = true;
      card.addEventListener("dragstart", e => { e.dataTransfer.setData("id", c.id); card.classList.add("drag"); });
      card.addEventListener("dragend", () => card.classList.remove("drag"));
      card.onclick = () => openChantier(c.id);
      const p = pct(c), lateDue = c.statut !== "done" && isLate(c.echeance);
      const refPin = c.baseline
        ? ` <span class="c-pin" title="Référence figée${c.baseline_edits ? ` — planning replanifié ${c.baseline_edits}× depuis` : ""}">📌</span>`
        : "";
      let h = `<div class="c-title">${esc(c.titre)}${refPin}</div>`;
      h += `<div class="c-prog"><span class="track"><i style="width:${p}%"></i></span><span class="pc">${p}%</span></div>`;
      h += `<div class="c-meta"><span class="due ${lateDue ? "late" : ""}">éch. ${fmt(c.echeance)}</span>` +
           `<span class="pr-${c.prio}">${PRIO[c.prio]}</span></div>`;
      // Carte bloquée : on montre DIRECTEMENT la raison (point bloquant, livrable attendu/en retard).
      if(col.key === "block") h += `<div class="c-blk">⛔ <b>Bloqué</b> — ${esc(blockReason(c))}</div>`;
      const bdg = [];
      if(c.hold) bdg.push(`<span class="bdg b-hold">⏸ En pause${c.hold_until ? ` · reprise ${fmtShort(c.hold_until)}` : ""}</span>`);
      // Chaque type a une icône + une couleur dédiées → reconnaissable d'un coup d'œil.
      const tc = topCrit(c);
      if(tc >= 10){ const lv = critLevel(tc);
        bdg.push(`<span class="bdg b-risk" style="color:${lv.col};background:${lv.bg};border-color:${lv.col}">⚠ Risque ${lv.lbl.toLowerCase()}</span>`); }
      const lt = lateTasks(c).length;
      if(lt) bdg.push(`<span class="bdg b-late">⏰ ${lt} tâche${lt > 1 ? "s" : ""} en retard</span>`);
      if(open.length){ const names = [...new Set(open.map(a => a.personne))].join(", ");
        bdg.push(late.length
          ? `<span class="bdg b-livlate">✉ Livrable en retard · ${esc(names)}</span>`
          : `<span class="bdg b-wait">⌛ En attente · ${esc(names)}</span>`); }
      if(col.key === "recette"){ const st = recStats(c), nb = recProblemes(c).length;
        bdg.push(`<span class="bdg b-rec">🧪 ${st.total ? `${st.ok}/${st.total} vérifiés` : "aucun point"}</span>`);
        if(nb) bdg.push(`<span class="bdg b-anobloq" title="Points de recette en problème">✕ ${nb} problème${nb > 1 ? "s" : ""}</span>`); }
      if(c.cdc){ const sc = CDC_ST[c.cdc.statut] || CDC_ST.brouillon;
        bdg.push(`<span class="bdg b-cdc ${sc.cls}">📄 CdC ${sc.lbl}</span>`); }
      if(bdg.length) h += `<div class="c-badges">${bdg.join("")}</div>`;
      if(c.theme_id && thById(c.theme_id)) h += `<div class="c-tags">` +
        themeChip(c.theme_id, {click: `event.stopPropagation();boardToggleTheme('${c.theme_id}')`}) + `</div>`;
      if(c.hold) h += `<div class="c-actions"><button class="btn sm" title="Reprendre ce chantier (le remet dans la charge)" onclick="event.stopPropagation();mutate({op:'set_hold',chantier_id:'${c.id}',hold:false})">▶ Reprendre</button></div>`;
      card.innerHTML = h; body.appendChild(card);
    });
    if((isDone || isTodo) && total > preview){   // bouton replier / déplier (Terminé & À faire)
      const tg = document.createElement("button");
      tg.className = "done-toggle";
      const expanded = isDone ? SHOW_ALL_DONE : !TODO_COLLAPSED;
      tg.textContent = expanded ? "▲ Réduire" : `▼ Voir tout (${total})`;
      tg.onclick = e => { e.stopPropagation(); if(isDone) SHOW_ALL_DONE = !SHOW_ALL_DONE; else TODO_COLLAPSED = !TODO_COLLAPSED; renderBoard(); };
      body.appendChild(tg);
    }
    el.appendChild(body); b.appendChild(el);
  });
  if(BOARD_F._focus){ BOARD_F._focus = false; const q = $("boardQ"); if(q){ q.focus(); const n = q.value.length; q.setSelectionRange(n, n); } }
}

function renderPeople(){
  const map = {};
  const relSet = new Set();
  LIVE().forEach(c => relancesDues(c).forEach(l => relSet.add(l.id)));
  LIVE().forEach(c => c.livrables.forEach(l => {
    const ct = contactById(l.contact_id);
    const key = ct ? ct.id : "__none__";
    (map[key] = map[key] || {id: ct ? ct.id : null, nom: ct ? ct.nom : ((l.personne || "").trim() || "(personne non renseignée)"),
      role: ct ? ct.role : l.role, moi: ct ? ct.moi : false, items: []}).items.push({...l, chantier: c.titre, chantier_id: c.id});
  }));
  const w = $("people"); w.innerHTML = "";
  const groups = Object.values(map).sort((a, b) =>
    (b.moi ? 1 : 0) - (a.moi ? 1 : 0) || a.nom.localeCompare(b.nom));
  if(!groups.length){ w.innerHTML = `<div class="empty">Aucune attente enregistrée.</div>`; return; }
  let head = `<div class="people-hint">Géré depuis l'<a onclick="setView('contacts')">annuaire</a> : une fiche par personne (renommer, rôle, fusionner les doublons).</div>`;
  groups.forEach(info => {
    head += `<div class="person"><h3>${info.moi ? "🧍 " : ""}${esc(info.nom)}</h3>` +
      `<div class="role">${esc(info.role || "")}</div>`;
    info.items.sort((a, b) => {
      const ua = ((livPending(a) && isLate(a.date)) || relSet.has(a.id)) ? 1 : 0;
      const ub = ((livPending(b) && isLate(b.date)) || relSet.has(b.id)) ? 1 : 0;
      return ub - ua;
    });
    info.items.forEach(it => {
      const late = (livPending(it)) && isLate(it.date);
      const relDue = relSet.has(it.id);
      const cls = it.statut === "recu" ? "recu" : it.statut === "annule" ? "annule"
                : it.statut === "partiel" ? "partiel" : (late ? "retard" : "attente");
      const u = (extra) => `mutate({op:'update_livrable',chantier_id:'${it.chantier_id}',livrable_id:'${it.id}',${extra}})`;
      head += `<div class="deliv clickable" onclick="openChantier('${it.chantier_id}')" title="Ouvrir le chantier"><span class="stm ${cls}"></span><div><div class="q">${esc(it.quoi)}${relDue ? ` <span class="lt-badge">À relancer</span>` : ""}</div>` +
           `<div class="meta ${late ? "late" : ""}"><b>${esc(it.chantier)}</b> · attendu le ${fmt(it.date)} · ` +
           `${late ? "EN RETARD" : LIV[it.statut]}</div>` +
           (it.impact ? `<div class="relance">Impact : ${esc(it.impact)}</div>` : "") +
           (it.relances ? `<div class="relance">relancé ${it.relances}× · dernière le ${fmt(it.derniere)}</div>` : "") +
           `<div class="acts" onclick="event.stopPropagation()">` +
             `<select title="Changer le statut" onchange="${u("statut:this.value")}">` +
               Object.keys(LIV).map(s => `<option value="${s}" ${it.statut === s ? "selected" : ""}>${LIV[s]}</option>`).join("") + `</select>` +
             `<a onclick="${u("relance:true")}">Relancé aujourd'hui</a>` +
           `</div></div></div>`;
    });
    head += `</div>`;
  });
  w.innerHTML = head;
}

// ---- Personnes (gestion) -------------------------------------------------
function peopleStats(){
  const st = {};
  STORE.contacts.forEach(c => { st[c.id] = {id: c.id, nom: c.nom, role: c.role || "", moi: !!c.moi, total: 0, open: 0, chs: {}}; });
  LIVE().forEach(c => {
    c.livrables.forEach(l => {
      const s = st[l.contact_id]; if(!s) return;
      s.total++; if(livPending(l)) s.open++;
      if(!s.chs[c.id]) s.chs[c.id] = {id: c.id, titre: c.titre, role: l.role || ""};
    });
    (c.parties || []).forEach(p => {
      const s = st[p.contact_id]; if(!s) return;
      if(!s.chs[c.id]) s.chs[c.id] = {id: c.id, titre: c.titre, role: p.role || ""};
    });
  });
  return Object.values(st).map(s => ({...s, chantiers: Object.values(s.chs)}))
    .sort((a, b) => (b.moi ? 1 : 0) - (a.moi ? 1 : 0) || a.nom.localeCompare(b.nom));
}
let PEOPLE_SORT = "nom";
function togglePeopleSort(){ PEOPLE_SORT = (PEOPLE_SORT === "open") ? "nom" : "open"; renderContacts(); }
function filterContacts(q){
  q = (q || "").trim().toLowerCase();
  document.querySelectorAll("#contacts tr[data-search]").forEach(tr => {
    tr.style.display = (!q || tr.getAttribute("data-search").includes(q)) ? "" : "none";
  });
}
function renderContacts(){
  let rows = peopleStats();
  if(PEOPLE_SORT === "open") rows = rows.slice().sort((a, b) => (b.open - a.open) || a.nom.localeCompare(b.nom));
  let h = `<div class="ch-h">Annuaire — personnes <button class="btn sm primary" onclick="addPerson()">+ Ajouter</button></div>`;
  h += `<div class="people-hint">Source de vérité unique. « <b>moi</b> » = toi ; « <b>Fusionner</b> » replie un doublon dans une autre fiche (réattribue ses livrables).</div>`;
  if(!rows.length){ $("contacts").innerHTML = h + `<div class="empty">Aucune personne. Ajoute-en une, ou crée un livrable.</div>`; return; }
  h += roleDatalist();
  h += `<div class="people-tools"><input class="people-search" placeholder="Rechercher un nom, un rôle…" oninput="filterContacts(this.value)">` +
    `<a class="people-sort" onclick="togglePeopleSort()">Trier : ${PEOPLE_SORT === "open" ? "livrables ouverts" : "nom"}</a></div>`;
  h += `<table class="ptable"><thead><tr><th>Nom</th><th>Rôle</th><th>Livrables</th><th>Chantiers</th><th></th></tr></thead><tbody>`;
  rows.forEach(p => {
    const others = rows.filter(o => o.id !== p.id);
    const mergeSel = others.length
      ? `<select class="merge-sel" title="Fusionner dans une autre fiche" onchange="mergePerson('${p.id}',this.value)"><option value="">Fusionner dans…</option>` +
        others.map(o => `<option value="${o.id}">${esc(o.nom)}</option>`).join("") + `</select>` : "";
    const chips = p.chantiers.length
      ? `<div class="chips">` + p.chantiers.map(x => `<span class="chip clickable" title="${esc(x.role || "")}" onclick="openChantier('${x.id}')">${esc(x.titre)}${x.role ? ` · ${esc(x.role)}` : ""}</span>`).join("") + `</div>`
      : `<span class="muted">—</span>`;
    h += `<tr data-search="${esc((p.nom + " " + (p.role || "")).toLowerCase())}"><td><b>${p.moi ? "🧍 " : ""}${esc(p.nom)}</b>` +
      (p.moi ? ` <span class="moi-badge">moi</span>` : ` <a class="setmoi" onclick="setMoi('${p.id}')">définir comme moi</a>`) + `</td>` +
      `<td><input class="role-edit" list="personRoles" value="${esc(p.role || "")}" placeholder="rôle" onchange="setPersonRole('${p.id}',this.value)"></td>` +
      `<td>${p.total}${p.open ? ` <span class="muted">(${p.open} ouvert${p.open > 1 ? "s" : ""})</span>` : ""}</td>` +
      `<td>${chips}</td>` +
      `<td class="pacts"><a onclick="renamePerson('${p.id}','${jqs(p.nom)}')">Renommer</a>` + mergeSel +
      `<a class="danger" onclick="removePerson('${p.id}','${jqs(p.nom)}',${p.total})">Supprimer</a></td></tr>`;
  });
  h += `</tbody></table>`;
  $("contacts").innerHTML = h;
}
function addPerson(){
  const n = prompt("Nom de la personne :"); if(!n || !n.trim()) return;
  const r = (prompt("Rôle (optionnel) :") || "").trim();
  mutate({op: "add_contact", nom: n.trim(), role: r});
}
function renamePerson(id, nom){
  const n = prompt("Nouveau nom :", nom);
  if(n && n.trim() && n.trim() !== nom) mutate({op: "update_contact", id, nom: n.trim()});
}
function setPersonRole(id, role){ mutate({op: "update_contact", id, role}); }
function setMoi(id){ mutate({op: "update_contact", id, moi: true}); }
function mergePerson(fromId, intoId){
  if(!intoId){ return; }
  const a = contactById(fromId), b = contactById(intoId);
  if(a && b && confirm(`Fusionner « ${a.nom} » dans « ${b.nom} » ?\nTous ses livrables et rôles de partie prenante seront réattribués à « ${b.nom} », et « ${a.nom} » disparaîtra.`))
    mutate({op: "merge_contact", from_id: fromId, into_id: intoId});
  else renderContacts();   // annulé → on remet le select sur "Fusionner dans…"
}
function removePerson(id, nom, total){
  const msg = total > 0
    ? `« ${nom} » a ${total} livrable(s) — ils deviendront « non assignés ». Supprimer ?\n(astuce : « Fusionner » conserve les livrables sur une autre personne.)`
    : `Supprimer « ${nom} » ?`;
  if(confirm(msg)) mutate({op: "remove_contact", id});
}

// ---- Absences (congés / RTT / fériés) ------------------------------------
// Poser une absence retire ses jours du calendrier de planning : le CPM les
// enjambe (addUnits/workOffset), donc toutes les fins de tâches situées après
// glissent d'autant. L'écart avec la référence figée (baseline) reste visible
// sur le Gantt — c'est exactement le décalage que les congés provoquent.
const ABS_TYPES = {conge: "Congés", rtt: "RTT", ferie: "Férié", recup: "Récupération",
                   formation: "Formation", maladie: "Arrêt maladie", autre: "Absence"};
const ABSENCES = () => STORE.absences || [];
function absJours(a){                 // jours ouvrés (hors week-end) couverts par la période
  let d = a.debut, n = 0, g = 0;
  while(d <= a.fin && g++ < 400){ if(!isWeekend(dparse(d))) n++; d = addDays(d, 1); }
  return n;
}
function renderAbsences(){
  const moi = STORE.contacts.find(c => c.moi)?.id || null;
  const list = ABSENCES().slice().sort((a, b) => a.debut < b.debut ? -1 : 1);
  const an = TODAY.slice(0, 4);
  const items = chargeData().items;   // tâches non finies + fenêtre prévisionnelle (un seul calcul)

  const poses = list.filter(a => a.type !== "ferie" && absBlocksPlan(a, moi) && a.debut.slice(0, 4) === an);
  const nbJours = poses.reduce((s, a) => s + absJours(a), 0);
  const aVenir = list.filter(a => a.fin >= TODAY);
  const prochaine = aVenir[0];

  let h = `<div class="ch-h">Congés &amp; absences` +
    `<button class="btn sm primary" onclick="addAbsence()">+ Poser une absence</button>` +
    `<button class="btn sm" onclick="importFeries()">Importer les fériés ${an}</button></div>`;
  h += `<div class="people-hint">Les jours posés sortent du calendrier : le planning les enjambe et les échéances calculées reculent d'autant. ` +
       `Une absence rattachée à quelqu'un d'autre est <b>informative</b> — sans affectation des tâches, elle ne décale rien.</div>`;

  h += `<div class="abs-kpis">` +
    `<div class="abs-kpi"><b>${nbJours}</b><span>jour${nbJours > 1 ? "s" : ""} posé${nbJours > 1 ? "s" : ""} en ${an}</span></div>` +
    `<div class="abs-kpi"><b>${prochaine ? fmtShort(prochaine.debut) : "—"}</b><span>${prochaine ? "prochaine : " + esc(prochaine.label) : "rien de prévu"}</span></div>` +
    `<div class="abs-kpi"><b>${OFF.size}</b><span>jours hors planning</span></div></div>`;

  h += `<div class="abs-form">` +
    `<label>Du <input type="date" id="absDebut" value="${TODAY}"></label>` +
    `<label>au <input type="date" id="absFin"></label>` +
    `<label>Type <select id="absType">` +
      Object.entries(ABS_TYPES).filter(([k]) => k !== "ferie")
        .map(([k, v]) => `<option value="${k}">${v}</option>`).join("") + `</select></label>` +
    `<label>Libellé <input id="absLabel" placeholder="optionnel"></label>` +
    `<label>Qui <select id="absQui"><option value="">Moi</option>` +
      STORE.contacts.filter(c => !c.moi).map(c => `<option value="${c.id}">${esc(c.nom)}</option>`).join("") +
      `</select></label>` +
    `<button class="btn sm primary" onclick="submitAbsence()">Poser</button></div>`;

  if(!list.length){ $("absences").innerHTML = h + `<div class="empty">Aucune absence enregistrée. Commence par importer les jours fériés, puis pose tes congés.</div>`; return; }

  h += `<table class="ptable abs-table"><thead><tr><th>Période</th><th>Type</th><th>Libellé</th><th>Jours</th><th>Qui</th><th>Impact planning</th><th></th></tr></thead><tbody>`;
  list.forEach(a => {
    const passe = a.fin < TODAY;
    const pese = absBlocksPlan(a, moi);
    const touchees = pese && !passe ? items.filter(i => i.start <= a.fin && a.debut < i.end) : [];
    const chs = [...new Set(touchees.map(i => i.chantier))];
    const qui = a.contact_id ? (contactById(a.contact_id)?.nom || "?") : "Moi";
    const per = a.debut === a.fin ? fmt(a.debut) : `${fmt(a.debut)} → ${fmt(a.fin)}`;
    h += `<tr class="${passe ? "abs-past" : ""}">` +
      `<td><b>${per}</b></td>` +
      `<td><span class="abs-tag t-${a.type}">${ABS_TYPES[a.type] || a.type}</span></td>` +
      `<td>${esc(a.label)}</td>` +
      `<td>${absJours(a)}</td>` +
      `<td>${esc(qui)}${pese ? "" : ` <span class="muted" title="n'affecte pas le planning">info</span>`}</td>` +
      `<td>${passe ? `<span class="muted">passé</span>`
            : !pese ? `<span class="muted">—</span>`
            : touchees.length ? `<span class="abs-hit" title="${esc(chs.join(" · "))}">${touchees.length} tâche${touchees.length > 1 ? "s" : ""} décalée${touchees.length > 1 ? "s" : ""} · ${chs.length} chantier${chs.length > 1 ? "s" : ""}</span>`
            : `<span class="muted">aucune tâche en cours</span>`}</td>` +
      `<td class="pacts"><a onclick="removeAbsence('${a.id}')" class="danger">Supprimer</a></td></tr>`;
  });
  h += `</tbody></table>`;
  $("absences").innerHTML = h;
}
function submitAbsence(){
  const debut = $("absDebut").value, fin = $("absFin").value || debut;
  if(!debut){ alert("Indique au moins une date de début."); return; }
  mutate({op: "add_absence", debut, fin, type: $("absType").value,
          label: $("absLabel").value.trim(), contact_id: $("absQui").value || null});
}
function addAbsence(){ $("absDebut")?.focus(); }
function importFeries(){ mutate({op: "import_feries", annee: +TODAY.slice(0, 4)}); }
function removeAbsence(id){
  const a = ABSENCES().find(x => x.id === id); if(!a) return;
  if(confirm(`Supprimer « ${a.label} » (${fmt(a.debut)} → ${fmt(a.fin)}) ?\nLes tâches replanifiées reviendront sur ces jours.`))
    mutate({op: "remove_absence", id});
}

// ======================================================================== //
//  CPM — planning calcule (dates, marges, chemin critique)
// ======================================================================== //
const _schedCache = new Map();   // mémoïsation : clé = id chantier, validé par identité d'objet (STORE remplacé au mutate → invalidé)
function computeSchedule(c){
  const _hit = _schedCache.get(c.id);
  if(_hit && _hit.c === c) return _hit.S;
  const tasks = c.taches || [];
  const start = c.date_debut || TODAY;
  const ids = new Set(tasks.map(t => t.id));
  const byId = {}; tasks.forEach(t => byId[t.id] = t);
  const preds = {}; tasks.forEach(t => preds[t.id] = (t.preds || []).filter(p => ids.has(p) && p !== t.id));
  const dur = t => t.is_milestone ? 0 : Math.max(0, t.duree || 0);
  const sfix = {}; tasks.forEach(t => sfix[t.id] = t.start_fix ? workOffset(start, t.start_fix) : null);
  // verrous par livrable rattache : la tache attend l'entree externe
  const _today = workOffset(start, TODAY);
  const gateP = {}, gateF = {}, gateInfo = {};   // planifie / previsionnel / details pour l'UI
  (c.livrables || []).forEach(l => {
    if(!l.tache_id || !ids.has(l.tache_id) || l.statut === "annule") return;
    (gateInfo[l.tache_id] = gateInfo[l.tache_id] || []).push(l);
    if(!l.date) return;
    const off = workOffset(start, l.date);
    gateP[l.tache_id] = Math.max(gateP[l.tache_id] ?? -1e9, off);            // plan : arrive a sa date prevue
    if(l.statut !== "recu")                                                  // pas encore recu : bloque jusqu'a la date (ou auj.)
      gateF[l.tache_id] = Math.max(gateF[l.tache_id] ?? -1e9, Math.max(off, _today));
  });
  const succ = {}; tasks.forEach(t => succ[t.id] = []);
  tasks.forEach(t => preds[t.id].forEach(p => succ[p].push(t.id)));

  // detection de cycle (topo Kahn)
  const indeg = {}; tasks.forEach(t => indeg[t.id] = preds[t.id].length);
  const q = tasks.filter(t => indeg[t.id] === 0).map(t => t.id); const topo = [];
  while(q.length){ const id = q.shift(); topo.push(id); succ[id].forEach(s => { if(--indeg[s] === 0) q.push(s); }); }
  const cycle = topo.length < tasks.length;

  // forward pass (relaxation, robuste aux cycles)
  const ES = {}, EF = {}, DEP = {};
  tasks.forEach(t => { ES[t.id] = 0; EF[t.id] = dur(t); DEP[t.id] = 0; });
  for(let i = 0; i <= tasks.length; i++){
    let ch = false;
    tasks.forEach(t => {
      let es = 0, dep = 0;
      preds[t.id].forEach(p => { es = Math.max(es, EF[p]); dep = Math.max(dep, DEP[p] + 1); });
      if(sfix[t.id] != null) es = Math.max(es, sfix[t.id]);   // debut impose (au plus tot a cette date)
      if(t.id in gateP) es = Math.max(es, gateP[t.id]);       // attend un livrable (date prevue)
      if(es !== ES[t.id] || dep !== DEP[t.id]){ ES[t.id] = es; EF[t.id] = es + dur(t); DEP[t.id] = dep; ch = true; }
    });
    if(!ch) break;
  }
  let projectDays = 0; tasks.forEach(t => projectDays = Math.max(projectDays, EF[t.id]));

  // backward pass
  const LF = {}, LS = {};
  tasks.forEach(t => { LF[t.id] = projectDays; LS[t.id] = projectDays - dur(t); });
  for(let i = 0; i <= tasks.length; i++){
    let ch = false;
    tasks.forEach(t => {
      let lf = succ[t.id].length ? Infinity : projectDays;
      succ[t.id].forEach(s => lf = Math.min(lf, LS[s]));
      if(lf !== LF[t.id]){ LF[t.id] = lf; LS[t.id] = lf - dur(t); ch = true; }
    });
    if(!ch) break;
  }

  const sched = {};
  tasks.forEach(t => {
    const slack = LS[t.id] - ES[t.id];
    sched[t.id] = {
      task: t, es: ES[t.id], ef: EF[t.id], ls: LS[t.id], lf: LF[t.id],
      slack, critical: Math.abs(slack) < 1e-9, depth: DEP[t.id],
      startDate: addUnits(start, ES[t.id]), endDate: addUnits(start, EF[t.id]),
    };
  });
  const order = tasks.slice().map(t => t.id).sort((a, b) => sched[a].es - sched[b].es || sched[a].depth - sched[b].depth);

  // --- Previsionnel "vivant" : on integre le reel et on pousse l'aval ---
  const todayIdx = workOffset(start, TODAY);
  const fc = {};
  order.slice().sort((a, b) => sched[a].depth - sched[b].depth).forEach(id => {
    const t = byId[id];
    let predFin = 0; preds[id].forEach(p => predFin = Math.max(predFin, fc[p] ? fc[p].ffIdx : 0));
    let fsIdx, ffIdx;
    const realStart = t.start_date ? Math.max(0, workOffset(start, t.start_date)) : null;
    if(t.done && t.done_date){
      ffIdx = Math.max(0, workOffset(start, t.done_date));   // fin = date reelle de completion
      // debut = debut REEL si connu, sinon reconstitue depuis la duree (pas un trou geant)
      fsIdx = realStart != null ? Math.min(realStart, ffIdx) : Math.max(0, ffIdx - dur(t));
    } else if(realStart != null){
      fsIdx = realStart;                       // EN COURS : le debut reel prime sur le previsionnel
      ffIdx = Math.max(fsIdx + dur(t), todayIdx);   // au moins jusqu'a aujourd'hui tant qu'inachevee
    } else {
      fsIdx = Math.max(predFin, todayIdx);   // une tache non finie ne peut pas finir dans le passe
      if(sfix[id] != null) fsIdx = Math.max(fsIdx, sfix[id]);   // debut impose
      if(id in gateF) fsIdx = Math.max(fsIdx, gateF[id]);       // attend un livrable non recu
      ffIdx = fsIdx + dur(t);
    }
    const late = t.done ? workOffset(start, t.done_date) > EF[id] : ffIdx > EF[id];
    fc[id] = {fsIdx, ffIdx, fsDate: addUnits(start, fsIdx), ffDate: addUnits(start, ffIdx), late};
  });
  let fendIdx = 0; order.forEach(id => fendIdx = Math.max(fendIdx, fc[id].ffIdx));

  const S = {start, projectDays, sched, byId, preds, cycle, order, gateInfo, gateF,
             end: addUnits(start, projectDays),
             fc, fendIdx, fend: addUnits(start, fendIdx),
             baseline: c.baseline || null};
  _schedCache.set(c.id, {c, S});
  return S;
}

// ======================================================================== //
//  Page detaillee d'un chantier
// ======================================================================== //
function openChantier(id){ CUR = id; renderPage(); showView("page"); window.scrollTo(0, 0); }
function backToBoard(){ CUR = null; showView("board"); }
// Mise en pause (hold) : reprise manuelle ; date de reprise optionnelle (déclenche un rappel).
function toggleHold(id){
  const c = chById(id); if(!c) return;
  if(c.hold){ mutate({op: "set_hold", chantier_id: id, hold: false}); return; }
  const d = prompt("Mettre ce chantier en pause.\nDate de reprise prévue (AAAA-MM-JJ) — laisser vide pour aucune :", "");
  if(d === null) return;
  mutate({op: "set_hold", chantier_id: id, hold: true, until: (d || "").trim() || null});
}
// Replanifie le travail RESTANT pour repartir d'aujourd'hui : glisse la cible (référence
// figée des tâches non finies + échéance + débuts imposés + livrables attendus) du retard
// pris, sans toucher aux tâches déjà faites. Sert à effacer le retard dû à un gel/une pause.
function replanToday(id){
  const c = chById(id); if(!c) return;
  const S = computeSchedule(c);
  const pend = (c.taches || []).filter(t => !t.done);
  if(!pend.length){ alert("Rien à replanifier — toutes les tâches sont terminées."); return; }
  let earliest = null;   // début de référence le plus ancien parmi les tâches non finies
  pend.forEach(t => {
    let rs = null;
    if(S.baseline){ const b = (S.baseline.tasks || []).find(x => x.id === t.id); rs = b ? b.start : null; }
    if(!rs){ const sc = S.sched[t.id]; rs = sc ? sc.startDate : null; }
    if(rs && (!earliest || rs < earliest)) earliest = rs;
  });
  if(!earliest){ alert("Aucune référence de planning sur laquelle s'appuyer pour replanifier."); return; }
  const days = daysBetween(earliest, TODAY);
  if(days <= 0){ alert("Déjà à jour — le travail restant ne part pas du passé."); return; }
  if(!confirm(`Replanifier « ${c.titre} » ?\n\nLe travail restant glisse de ${days} jour(s) pour repartir d'aujourd'hui.\nLes tâches déjà faites ne bougent pas ; plus aucun retard artificiel ne sera affiché.`)) return;
  mutate({op: "replan_now", chantier_id: id, days});
}
// Garde-fou : pas de raccourci lettre quand le focus est dans un champ de saisie.
function inField(el){ const t = el || document.activeElement; if(!t) return false;
  const tag = t.tagName; return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable; }
document.addEventListener("keydown", e => {
  // Échap : ferme d'abord la recherche, puis tout menu ouvert, sinon revient au tableau.
  if(e.key === "Escape"){
    const sm = $("searchMenu");
    if(sm && sm.classList.contains("open")){ closeSearch(); return; }
    if(document.querySelector(".menu.open")){ document.querySelectorAll(".menu.open").forEach(m => m.classList.remove("open")); return; }
    if(CUR) backToBoard();
    return;
  }
  // Recherche globale : '/' (hors saisie) ou Ctrl/Cmd+K.
  if((e.key === "/" && !inField(e.target)) || ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K"))){
    e.preventDefault(); openSearch(); return;
  }
  // Raccourcis lettre — inactifs pendant une saisie ou avec un modificateur.
  if(inField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if(k === "s"){ if(activeSession()) mutate({op: "clock_stop"}); }
  else if(k === "t"){ setView("board"); }
  else if(k === "p"){ setView("planning"); }
  else if(k === "d"){ setView("dash"); }
  // Capture immédiate : c'est le point qui décide si l'outil remplace le papier.
  // On écrit BEAUCOUP plus souvent une note ou une action qu'on ne crée un chantier,
  // donc « n » va à la note et la création de chantier passe sur « c ».
  else if(k === "a"){ e.preventDefault(); captureAction(); }
  else if(k === "n"){ e.preventDefault(); captureNote(); }
  else if(k === "c"){ e.preventDefault(); newChantier(); }
});
// Ouvre la vue et pose le curseur dans le champ de saisie : zéro clic entre
// l'idée et sa capture.
function captureAction(){
  setView("actions");
  const el = $("ac_new"); if(el){ el.focus(); el.select(); }
}
function captureNote(){
  setView("notes");
  const el = $("nt_corps"); if(el) el.focus();
}

function renderPage(){
  const c = chById(CUR); if(!c){ backToBoard(); return; }
  const S = computeSchedule(c);
  const p = pct(c);
  const col = COLS.find(k => k.key === c.statut);
  const bl = S.baseline;
  const blocked = isBlocked(c);

  let h = "";
  // En-tete
  h += `<div class="pg-top">`;
  h += `<button class="ghost" onclick="backToBoard()">← Tableau</button>`;
  const statusTxt = c.hold ? `En pause${c.hold_until ? ` — reprise prévue le ${fmt(c.hold_until)}` : ""}`
                  : blocked ? `Bloqué (auto) — ${esc(blockReason(c))}` : col.label;
  h += `<div class="pg-titlewrap"><div class="d-status ${c.hold ? "hold" : blocked ? "block" : c.statut}">${statusTxt} · priorité ${PRIO[c.prio]}</div>` +
       `<h2 class="pg-title" contenteditable="true" onblur="saveField('titre',this.textContent)">${esc(c.titre)}</h2></div>`;
  h += `<div class="grow"></div>`;
  if(!c.hold && c.statut !== "done" && lateTasks(c).length)
    h += `<button class="ghost" onclick="replanToday('${c.id}')" title="Glisser le travail restant pour repartir d'aujourd'hui — efface le retard dû à un gel ou une pause">⏩ Replanifier</button>`;
  h += `<button class="ghost ${c.hold ? "held" : ""}" onclick="toggleHold('${c.id}')" title="${c.hold ? "Reprendre ce chantier" : "Mettre en pause : sort le chantier des retards, de la charge et du WIP"}">${c.hold ? "▶ Reprendre" : "⏸ Mettre en pause"}</button>`;
  h += `<select onchange="mutate({op:'move_chantier',id:'${c.id}',statut:this.value})" class="sel" title="État d'avancement — Recette et Terminé se posent tout seuls (recette ouverte, toutes les tâches faites), comme Bloqué">` +
       COLS.filter(k => k.key !== "block").map(k => `<option value="${k.key}" ${c.statut === k.key ? "selected" : ""}>${k.label}</option>`).join("") + `</select>`;
  h += `<select onchange="mutate({op:'update_chantier',id:'${c.id}',prio:this.value})" class="sel">` +
       ["h", "m", "b"].map(x => `<option value="${x}" ${c.prio === x ? "selected" : ""}>Priorité ${PRIO[x]}</option>`).join("") + `</select>`;
  h += `</div>`;

  // KPI
  h += `<div class="kpis">`;
  h += kpi("Avancement", p + " %", c.taches.filter(t => t.done).length + " / " + c.taches.length + " tâches");
  h += kpi("Fin prévisionnelle", fmt(S.fend),
           bl ? "référence : " + fmt(bl.project_end) : (c.echeance ? "échéance : " + fmt(c.echeance) : ""));
  // Retard vs reference (si figee) sinon vs echeance
  let rd, rlabel, rsub, rcls = "";
  if(bl){
    rd = daysBetween(bl.project_end, S.fend); rlabel = "Retard vs référence";
    rsub = "réf. figée le " + fmt(bl.frozen_at);
  } else if(c.echeance){
    rd = daysBetween(c.echeance, S.fend); rlabel = "Fin vs échéance";
    rsub = "fige une référence pour suivre le retard";
  } else { rd = null; rlabel = "Retard"; rsub = "définis une échéance"; }
  let rval = rd == null ? "—" : (rd > 0 ? "+" + rd + " j" : (rd < 0 ? rd + " j" : "à l'heure"));
  if(rd != null && rd > 0) rcls = "bad"; else if(rd != null && rd < 0) rcls = "good";
  h += kpi(rlabel, rval, rsub, rcls);
  h += kpi("Attentes en retard", String(lateAtt(c).length), openAtt(c).length + " ouverte(s)",
           lateAtt(c).length ? "bad" : "");
  h += `</div>`;

  // EVM — valeur acquise
  const E = evm(c, S);
  h += `<div class="evm-head"><span>Valeur acquise (EVM)</span>` +
       `<span class="evm-budget">Budget (BAC) <input type="number" min="0" step="100" value="${c.budget != null ? c.budget : ""}" placeholder="—" ` +
       `onchange="mutate({op:'update_chantier',id:'${c.id}',budget:this.value})"> €</span></div>`;
  if(E.BAC != null){
    h += `<div class="kpis">`;
    h += kpi("Valeur acquise (EV)", fmtEur(E.EV), fmtPctw(E.evFrac) + " achevé");
    h += kpi("Valeur planifiée (PV)", fmtEur(E.PV), fmtPctw(E.pvFrac) + " prévu à date");
    h += kpi("Coût réel (AC)", fmtEur(E.AC), E.AC == null ? "définis un taux/jour (Charge)" : (Math.round(E.pjours * 10) / 10) + " j-pers · ⏱");
    h += kpi("SPI — délai", fmtIdx(E.SPI), E.SV != null ? (E.SV >= 0 ? "+" : "") + fmtEur(E.SV) + " (SV)" : "—", idxCls(E.SPI));
    h += kpi("CPI — coût", fmtIdx(E.CPI), E.CV != null ? (E.CV >= 0 ? "+" : "") + fmtEur(E.CV) + " (CV)" : "définis un taux/jour", idxCls(E.CPI));
    h += kpi("Coût final (EAC)", fmtEur(E.EAC), E.VAC != null ? "écart " + (E.VAC >= 0 ? "+" : "") + fmtEur(E.VAC) + " (VAC)" : "—", E.VAC != null ? (E.VAC >= 0 ? "good" : "bad") : "");
    h += `</div>`;
  } else {
    // Pas de budget : on montre quand même le coût main-d'œuvre déjà dépensé (temps chronométré
    // valorisé), qui existe indépendamment du BAC. Avec un taux_jour réglé, il égale l'AC de l'EVM.
    const cmin = chantierMin(c.id);
    if(cmin > 0){
      const tauxSet = !!(+SETTINGS.taux_jour), jp = cmin / ((+SETTINGS.heures_jour || 7) * 60);
      h += `<div class="kpis">`;
      h += kpi("Coût main-d'œuvre à date", fmtEur(eurMin(cmin)),
               (Math.round(jp * 10) / 10) + " j-pers · " + fmtEur(tauxHeure()) + "/h" + (tauxSet ? "" : " (taux défaut)"));
      h += `</div>`;
    }
    h += `<div class="muted small evm-empty">` + (cmin > 0
      ? `Coût réel déjà engagé ci-dessus. Saisis un budget (BAC) pour l'analyse complète de la valeur acquise (SPI/CPI, coût final estimé).`
      : `Saisis un budget (BAC) pour activer l'analyse de la valeur acquise. Le coût réel se calcule depuis ton temps chronométré × le taux horaire`)
      + ` (réglages dans <a class="lnk" onclick="setView('charge')">Charge</a>).</div>`;
  }

  // Colonnes : gauche (objectif, anneau, échéance, parties, tags, blocage) / droite (visuels)
  h += `<div class="pg-grid"><div class="pg-left">`;

  h += card("Objectif", `<textarea onblur="mutate({op:'update_chantier',id:'${c.id}',objectif:this.value})" ` +
            `placeholder="Décris l'objectif…">${esc(c.objectif || "")}</textarea>`);

  h += card("Cahier des charges", cdcSummary(c));

  h += card("Avancement", `<div class="ring-wrap">${donut(p)}<div class="ring-meta">` +
            `<div><b>${c.taches.filter(t => t.done).length}</b> / ${c.taches.length} tâches</div>` +
            `<div class="muted">${c.taches.filter(t => t.is_milestone).length} jalon(s)</div></div></div>`);

  // Échéance + début
  h += card("Calendrier", countdownBlock(c, S));

  // Parties prenantes
  h += card(`Parties prenantes <span class="add" onclick="showAddPartie('${c.id}')">+ ajouter</span>`,
    (c.parties.length ? c.parties.map(pp =>
      `<div class="row-line"><span>${esc(pp.nom)}${pp.role ? ` <span class="muted">· ${esc(pp.role)}</span>` : ""}</span>` +
      `<span class="del" onclick="mutate({op:'remove_partie',chantier_id:'${c.id}',partie_id:'${pp.id}'})">×</span></div>`).join("")
      : `<div class="empty">Personne pour l'instant.</div>`) + `<div id="addPartie_${c.id}"></div>`);

  // Thème — un seul, choisi dans la liste fermée (plus de saisie libre)
  h += card("Thème",
    themeSelect(c.theme_id, `mutate({op:'set_theme',chantier_id:'${c.id}',theme_id:this.value||null})`) +
    `<div class="muted small" style="margin-top:6px">Maille transverse : ce chantier, ses actions et ses notes ` +
    `se retrouvent ensemble dans <span class="add" onclick="setView('themes')">Thèmes</span>.</div>`);

  // Blocage
  h += card("Point bloquant", `<textarea placeholder="Qu'est-ce qui bloque ?" ` +
            `onblur="mutate({op:'update_chantier',id:'${c.id}',blocage:this.value})">${esc(c.blocage || "")}</textarea>`);

  h += `</div><div class="pg-right">`;

  // Tâches (checklist enrichie)
  const tasksDoneN = c.taches.filter(t => t.done).length;
  const tasksHideTog = tasksDoneN ? ` <span class="add" onclick="toggleHideDone()" title="Masquer/afficher les tâches terminées">${HIDE_DONE_TASKS ? "Afficher terminées" : "Masquer terminées (" + tasksDoneN + ")"}</span>` : "";
  h += card(`Plan de tâches <span class="add" onclick="showAddTache('${c.id}')">+ tâche</span> <span class="add" onclick="showWbs('${c.id}')">+ modèle</span>${tasksHideTog}`, taskTable(c, S), "taches");

  // Recette — dans la colonne large : c'est une surface de travail quotidienne,
  // pas une fiche d'identité. Le plan de tâches dit ce qui est fait, elle dit
  // ce qui est vérifié.
  h += card("Recette", recetteCard(c) + peopleDatalist(), "recette");

  // Risques
  h += card(`Risques <span class="add" onclick="showAddRisque('${c.id}')">+ risque</span>`, risquesBlock(c), "risques");

  // Gantt
  h += card("Diagramme de Gantt", S.cycle ? cycleWarn() : ganttSVG(c, S), "gantt");

  // PERT
  h += card("Réseau PERT — chemin critique", S.cycle ? cycleWarn() : pertSVG(c, S));

  // Livrables
  h += card(`Ce que j'attends <span class="add" onclick="showAddLiv('${c.id}')">+ livrable</span>`, livrablesBlock(c));

  // Courbe d'avancement
  h += card("Avancement dans le temps", progressCurve(c, S));

  // Historique = les notes rattachées à ce chantier (même magasin que le bloc-notes,
  // donc une seule écriture, pas deux endroits où consigner la même chose).
  const hns = notesOf(c.id);
  h += card(`Historique <span class="add" onclick="showAddNote('${c.id}')">+ note</span>` +
            ` <span class="add" onclick="setView('notes')">bloc-notes</span>`,
    `<div id="addNote_${c.id}"></div>` + (hns.length
      ? hns.map(n => `<div class="hist"><span class="d">${(NT_TYPE[n.type] || NT_TYPE.note).ic} ${fmt(n.date)}${n.heure ? " " + n.heure : ""}</span>` +
          (n.titre ? `<b>${esc(n.titre)}</b>` : "") +
          `<div class="hist-c">${esc(n.corps)}</div>` +
          `<span class="del" title="Supprimer" onclick="if(confirm('Supprimer cette note ?'))mutate({op:'note_remove',id:'${n.id}'})">×</span></div>`).join("")
      : `<div class="empty">Aucune note.</div>`));

  h += `</div></div>`;

  // Suppression
  h += `<div class="pg-foot"><span class="danger-link" onclick="if(confirm('Supprimer définitivement ce chantier ?'))mutate({op:'delete_chantier',id:'${c.id}'})">Supprimer ce chantier</span></div>`;

  $("page").innerHTML = h;
}

function kpi(label, value, sub, cls){
  return `<div class="kpi ${cls || ""}"><div class="lab">${label}</div><div class="num">${esc(value)}</div>` +
         (sub ? `<div class="sub">${esc(sub)}</div>` : "") + `</div>`;
}
// Toutes les sections de la page chantier sont réductibles : chevron dans l'en-tête,
// état plié/déplié mémorisé. La clé est explicite si fournie, sinon dérivée du titre.
function card(title, body, key){
  key = key || slugKey(title);
  const col = isCollapsed(key);
  return `<section class="cardx collapsible${col ? " collapsed" : ""}" id="card_${key}">` +
    `<div class="cardx-h" onclick="cardHeadClick(event,'${key}')">` +
      `<span class="cardx-fold" title="Réduire / déployer">▸</span>${title}</div>` +
    `<div class="cardx-b">${body}</div></section>`;
}
// Clé stable dérivée du titre : texte avant le 1er tag HTML, sans accents, en slug.
function slugKey(title){
  return String(title).split("<")[0]
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sec";
}
// Sections réductibles — état conservé dans localStorage : la page étant reconstruite
// à chaque mutation, un simple booléen en mémoire ne suffirait pas ; on le persiste
// donc aussi entre rechargements.
function collapsedSet(){
  try { return JSON.parse(localStorage.getItem("collapsed_sections") || "{}") || {}; }
  catch(e){ return {}; }
}
function isCollapsed(key){ return collapsedSet()[key] === true; }
function toggleCollapse(key){
  const s = collapsedSet();
  if(s[key]) delete s[key]; else s[key] = true;
  try { localStorage.setItem("collapsed_sections", JSON.stringify(s)); } catch(e){}
  const el = document.getElementById("card_" + key);   // bascule sur place, sans re-rendu
  if(el) el.classList.toggle("collapsed", !!s[key]);
}
function cardHeadClick(e, key){
  if(e.target.closest(".add")) return;   // clic sur un bouton d'action (+ tâche, + risque…) : ne pas plier
  toggleCollapse(key);
}
function cycleWarn(){
  return `<div class="empty">Dépendances circulaires détectées — corrige les prédécesseurs pour calculer le planning.</div>`;
}
function saveField(field, val){
  const v = (val || "").trim(); const c = chById(CUR);
  if(c && v && v !== c[field]) mutate({op: "update_chantier", id: CUR, [field]: v});
}

// ---- visuels -------------------------------------------------------------
function donut(p){
  const r = 42, cx = 52, cy = 52, circ = 2 * Math.PI * r;
  const off = circ * (1 - p / 100);
  return `<svg width="104" height="104" viewBox="0 0 104 104" class="donut">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line-soft)" stroke-width="10"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--ink)" stroke-width="10" ` +
    `stroke-dasharray="${circ}" stroke-dashoffset="${off}" stroke-linecap="butt" transform="rotate(-90 ${cx} ${cy})"/>` +
    `<text x="52" y="58" text-anchor="middle" font-size="22" font-weight="700" fill="var(--ink)">${p}%</text></svg>`;
}

function countdownBlock(c, S){
  const jr = c.echeance ? daysBetween(TODAY, c.echeance) : null;
  const ecoule = c.date_debut ? Math.max(0, daysBetween(c.date_debut, TODAY)) : null;
  let h = `<div class="kv"><span class="k">Début</span><span class="v">` +
    `<input type="date" value="${c.date_debut || ""}" onchange="mutate({op:'update_chantier',id:'${c.id}',date_debut:this.value})"></span></div>`;
  h += `<div class="kv"><span class="k">Échéance</span><span class="v">` +
    `<input type="date" value="${c.echeance || ""}" onchange="mutate({op:'update_chantier',id:'${c.id}',echeance:this.value})"></span></div>`;
  if(jr != null){
    const late = jr < 0 && c.statut !== "done";
    h += `<div class="count ${late ? "late" : ""}">${jr < 0 ? "J+" + Math.abs(jr) : "J−" + jr}` +
         `<span> ${late ? "en retard" : (jr === 0 ? "aujourd'hui" : "restants")}</span></div>`;
  }
  h += `<div class="muted small">Fin prévisionnelle (réel + reste) : <b>${fmt(S.fend)}</b>` +
       (ecoule != null ? ` · ${ecoule} j écoulés` : "") + `</div>`;
  // Reference (baseline)
  h += `<div class="baseline">`;
  if(S.baseline){
    const rd = daysBetween(S.baseline.project_end, S.fend);
    const ed = c.baseline_edits || 0;
    h += `<div class="muted small">Référence figée le <b>${fmt(S.baseline.frozen_at)}</b> — fin prévue alors : <b>${fmt(S.baseline.project_end)}</b></div>`;
    h += `<div class="small ${rd > 0 ? "bad-t" : rd < 0 ? "good-t" : ""}">${rd > 0 ? "Glissement de +" + rd + " j" : rd < 0 ? Math.abs(rd) + " j d'avance" : "Conforme à la référence"}</div>`;
    h += `<div class="small ${ed ? "bad-t" : "muted"}" title="Compte les vraies replanifications (ajout/retrait/réordonnancement de tâches, durée, dépendances, début imposé, échéance). Démarrer/terminer une tâche n'est PAS compté.">${ed ? "Planning replanifié " + ed + "× depuis le figeage" : "Planning inchangé depuis le figeage"}</div>`;
    h += `<div class="acts"><a onclick="setBaseline()">Re-figer</a> <a class="danger" onclick="mutate({op:'clear_baseline',chantier_id:'${c.id}'})">Effacer</a></div>`;
  } else {
    h += `<button class="btn sm" onclick="setBaseline()">Figer la référence</button>` +
         `<div class="muted small" style="margin-top:5px">Capture le planning prévu actuel pour mesurer le retard ensuite.</div>`;
  }
  h += `</div>`;
  return h;
}

function setBaseline(){
  const c = chById(CUR); if(!c) return;
  const S = computeSchedule(c);
  const baseline = {
    frozen_at: TODAY, project_end: S.end, echeance: c.echeance,
    tasks: S.order.map(id => ({id: id, start: S.sched[id].startDate, end: S.sched[id].endDate})),
  };
  mutate({op: "set_baseline", chantier_id: c.id, baseline});
}

let HIDE_DONE_TASKS = false;   // bascule globale : masquer les tâches terminées de la LISTE (l'ordonnancement/Gantt reste complet)
function toggleHideDone(){ HIDE_DONE_TASKS = !HIDE_DONE_TASKS; renderPage(); }
function taskTable(c, S){
  if(!c.taches.length) return `<div class="empty">Aucune tâche — ajoute des tâches (durée + prédécesseurs) pour générer le Gantt et le PERT.</div><div id="addTache_${c.id}"></div>`;
  const lbl = {}; c.taches.forEach(x => lbl[x.id] = x.label);
  const order = HIDE_DONE_TASKS ? S.order.filter(id => !S.sched[id].task.done) : S.order;
  const hiddenDone = S.order.length - order.length;
  let h = `<div class="ttable">`;
  order.forEach(id => {
    const s = S.sched[id], t = s.task;
    const fixed = !!t.start_fix;
    h += `<div class="trow ${s.critical ? "crit" : ""}">`;
    // ligne 1 : etat + libelle + jalon + suppr
    h += `<div class="trow-main">`;
    // --- avancement : UN SEUL contrôle contextuel (plus de case grisée) ---
    //  jalon → case (coché directement) ; tâche → bouton qui avance : ▶ Démarrer → ✓ Terminer → ✓ Terminé
    const tmin = t.is_milestone ? 0 : tacheMin(t.id);
    const act = (!t.is_milestone && t.start_date && !t.done) ? activeForTache(t.id) : null;
    if(t.is_milestone){
      h += `<span class="box ${t.done ? "ok" : ""}" title="Jalon atteint / pas encore" onclick="mutate({op:'toggle_tache',chantier_id:'${c.id}',tache_id:'${t.id}'})"></span>`;
    } else if(t.done){
      h += `<button class="tprog-done" title="Terminé — cliquer pour rouvrir" onclick="mutate({op:'toggle_tache',chantier_id:'${c.id}',tache_id:'${t.id}'})">✓ Terminé</button>`;
    } else if(t.start_date){
      h += `<span class="tstate inprog${act ? " running" : ""}" title="${act ? "Chrono en cours (depuis " + act.debut + ")" : "Démarrée — chrono en pause"}">${act ? "⏱ en cours" : "● en cours"}</span>`;
    } else if(startBlocked(c)){
      h += `<button class="tstart blocked" title="Limite de ${SETTINGS.wip_max || 3} chantiers « En cours » atteinte — terminez ou mettez en pause un chantier d'abord" onclick="alert('${wipFullMsg()}')">▶ Démarrer</button>`;
    } else {
      h += `<button class="tstart" title="Démarrer — lance le chrono et enregistre le début réel" onclick="mutate({op:'start_tache',chantier_id:'${c.id}',tache_id:'${t.id}'})">▶ Démarrer</button>`;
    }
    h += `<input class="tlabel ${t.done ? "done" : ""}" value="${esc(t.label)}" ` +
         `onblur="if(this.value.trim()&&this.value!=='${jqs(t.label)}')mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',label:this.value.trim()})">`;
    h += `<label class="ms" title="Jalon (durée 0)"><input type="checkbox" ${t.is_milestone ? "checked" : ""} ` +
         `onchange="mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',is_milestone:this.checked})"> jalon</label>`;
    // actions secondaires — terminée : récap réel ; en cours : ✓ Terminer + chrono + début réel + annuler
    if(!t.is_milestone && t.done){
      // dates réelles éditables (corriger l'historique d'une tâche terminée)
      h += `<span class="fld"><span class="fl">réel</span>` +
        `<input type="date" class="tstart-date" value="${t.start_date || ""}" title="Début réel" ` +
        `onchange="mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',start_date:this.value||null})">` +
        `<span class="dl-sep">→</span>` +
        `<input type="date" class="tstart-date" value="${t.done_date || ""}" title="Fin réelle" ` +
        `onchange="mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',done_date:this.value||null})"></span>` +
        (tmin ? `<span class="tstate real" title="Temps chronométré">⏱ ${fmtDur(tmin)}</span>` : "");
    } else if(!t.is_milestone && t.start_date){
      h += `<button class="tfinish" title="Terminer la tâche (enregistre la fin réelle)" onclick="mutate({op:'toggle_tache',chantier_id:'${c.id}',tache_id:'${t.id}'})">✓ Terminer</button>`;
      h += act
        ? `<button class="tstart stop" title="Mettre le chrono en pause (démarré à ${act.debut})" onclick="mutate({op:'clock_stop',id:'${act.id}'})">⏸ Pause</button>`
        : `<button class="chrono" title="Reprendre le chrono sur cette tâche" onclick="mutate({op:'clock_start',kind:'tache',chantier_id:'${c.id}',tache_id:'${t.id}'})">▶ Reprendre${tmin ? " · " + fmtDur(tmin) : ""}</button>`;
      h += `<input type="date" class="tstart-date" value="${t.start_date}" title="Début réel (corrigeable)" ` +
           `onchange="mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',start_date:this.value||null})">`;
      h += `<span class="tstart-undo" title="Annuler le démarrage (revenir à « à faire »)" ` +
           `onclick="mutate({op:'start_tache',chantier_id:'${c.id}',tache_id:'${t.id}',date:null})">↺</span>`;
    }
    h += `<span class="del" title="Supprimer" onclick="if(confirm('Supprimer cette tâche ?'))mutate({op:'remove_tache',chantier_id:'${c.id}',tache_id:'${t.id}'})">×</span>`;
    h += `</div>`;
    // ligne 2 : debut (impose ou auto) / duree / fin / predecesseurs / marge
    h += `<div class="trow-sub">`;
    h += `<span class="fld ${fixed ? "fix" : ""}"><span class="fl">Début${fixed ? " (imposé)" : ""}</span>` +
         `<input type="date" value="${t.start_fix || s.startDate}" title="${fixed ? "Début imposé — vide pour repasser en auto" : "Calculé. Saisir une date pour l'imposer."}" ` +
         `onchange="setStart('${c.id}','${t.id}',this.value)">` +
         (fixed ? `<span class="unfix" title="Repasser en calcul auto" onclick="setStart('${c.id}','${t.id}','')">auto</span>` : "") + `</span>`;
    if(!t.is_milestone){
      h += `<span class="fld"><span class="fl">Durée</span><input class="duree" type="number" min="0" value="${t.duree}" ` +
           `onchange="mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',duree:this.value})"><span class="fu">j</span></span>`;
      h += `<span class="fld"><span class="fl">Fin</span><input type="date" value="${s.endDate}" title="Saisir une fin ajuste la durée" ` +
           `onchange="setEnd('${c.id}','${t.id}',this.value)"></span>`;
    } else {   // jalon : cellules Durée/Fin vides pour garder l'alignement des colonnes
      h += `<span class="fld fld-empty muted">jalon</span><span class="fld fld-empty"></span>`;
    }
    // predecesseurs
    const avail = c.taches.filter(o => o.id !== t.id && !t.preds.includes(o.id));
    const chips = t.preds.map(pid => `<span class="predchip">${esc(lbl[pid] || "?")}` +
      `<span class="x" title="Retirer" onclick="removePred('${c.id}','${t.id}','${pid}')">×</span></span>`).join("");
    const addsel = avail.length
      ? `<select class="predadd" onchange="addPred('${c.id}','${t.id}',this.value);this.value=''">` +
        `<option value="">+ après…</option>` + avail.map(o => `<option value="${o.id}">${esc(o.label)}</option>`).join("") + `</select>`
      : "";
    h += `<span class="predcell"><span class="fl">après</span>${chips || `<span class="muted">début</span>`}${addsel}</span>`;
    h += `<span class="dates">${s.critical ? "critique" : (s.slack ? "marge " + s.slack + " j" : "")}</span>`;
    // verrous livrables rattachés
    const gates = S.gateInfo[t.id] || [];
    const pend = gates.filter(l => l.statut !== "recu");
    if(gates.length){
      h += pend.length
        ? `<span class="gate wait gate-row">⊘ attend : ${pend.map(l => esc(l.quoi) + " (" + esc(l.personne) + (l.date ? ", " + fmtShort(l.date) : "") + ")").join(" · ")}</span>`
        : `<span class="gate ok gate-row">✓ livrable reçu</span>`;
    }
    h += `</div>`;   // fin trow-sub
    // description / notes (éditable inline ; sauvegarde au blur si modifiée, vide autorisé)
    h += `<textarea class="tdesc" rows="1" placeholder="+ description / notes…" ` +
         `onblur="if(this.value!==this.defaultValue)mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',desc:this.value})">${esc(t.desc || "")}</textarea>`;
    // checklist d'étapes (sous-tâches) — sans planning propre, juste un découpage cochable
    const subs = t.subtasks || [];
    const sdone = subs.filter(x => x.done).length;
    h += `<div class="subtasks">`;
    if(subs.length) h += `<div class="sub-head">Étapes · <b>${sdone}/${subs.length}</b>${sdone === subs.length ? " ✓" : ""}</div>`;
    subs.forEach(st => {
      h += `<div class="strow${st.done ? " done" : ""}">` +
        `<span class="sbox ${st.done ? "ok" : ""}" title="Fait / à faire" onclick="mutate({op:'toggle_subtask',chantier_id:'${c.id}',tache_id:'${t.id}',subtask_id:'${st.id}'})"></span>` +
        `<input class="slabel${st.done ? " done" : ""}" value="${esc(st.label)}" ` +
          `onblur="if(this.value.trim()&&this.value!==this.defaultValue)mutate({op:'update_subtask',chantier_id:'${c.id}',tache_id:'${t.id}',subtask_id:'${st.id}',label:this.value.trim()})">` +
        (st.done && st.done_at ? `<span class="sdate" title="Étape cochée le ${fmtDT(st.done_at)}">✓ ${fmtDT(st.done_at)}</span>` : ``) +
        `<span class="sdel" title="Supprimer l'étape" onclick="mutate({op:'remove_subtask',chantier_id:'${c.id}',tache_id:'${t.id}',subtask_id:'${st.id}'})">×</span>` +
        `</div>`;
    });
    h += `<input class="sadd" placeholder="+ étape…" onkeydown="if(event.key==='Enter')addSubtask('${c.id}','${t.id}',this)">`;
    h += `</div>`;
    h += `</div>`;   // fin trow
  });
  h += `</div>`;
  if(hiddenDone) h += `<div class="muted small" style="padding:6px 2px 2px">${hiddenDone} tâche${hiddenDone > 1 ? "s" : ""} terminée${hiddenDone > 1 ? "s" : ""} masquée${hiddenDone > 1 ? "s" : ""} — <a class="lnk" onclick="toggleHideDone()">afficher</a></div>`;
  h += `<div id="addTache_${c.id}"></div>`;
  return h;
}
function setStart(cid, tid, val){
  mutate({op: "update_tache", chantier_id: cid, tache_id: tid, start_fix: val || null});
}
function setEnd(cid, tid, val){
  if(!val) return;
  const c = chById(cid);
  const S = computeSchedule(c);
  const t = c.taches.find(x => x.id === tid);
  const eff = t.start_fix || S.sched[tid].startDate;   // debut effectif (impose ou calcule)
  const duree = Math.max(0, workOffset(eff, val));   // en unités de planning (jours ouvrés si réglé), comme le rendu
  mutate({op: "update_tache", chantier_id: cid, tache_id: tid, duree});
}
function addPred(cid, tid, pid){
  if(!pid) return;
  const t = chById(cid).taches.find(x => x.id === tid);
  const preds = [...(t.preds || [])]; if(!preds.includes(pid)) preds.push(pid);
  mutate({op: "update_tache", chantier_id: cid, tache_id: tid, preds});
}
function removePred(cid, tid, pid){
  const t = chById(cid).taches.find(x => x.id === tid);
  const preds = (t.preds || []).filter(x => x !== pid);
  mutate({op: "update_tache", chantier_id: cid, tache_id: tid, preds});
}
function addSubtask(cid, tid, el){
  const v = el.value.trim(); if(!v) return;
  mutate({op: "add_subtask", chantier_id: cid, tache_id: tid, label: v});
}

function ganttSVG(c, S){
  const tasks = S.order; if(!tasks.length) return `<div class="empty">—</div>`;
  const bl = S.baseline, hasBl = !!bl;
  const blById = {}; if(bl) bl.tasks.forEach(b => blById[b.id] = b);
  const tIdx = workOffset(S.start, TODAY);
  const off = d => Math.max(0, workOffset(S.start, d));
  // référence (plan) : baseline figée si présente, sinon plan CPM courant
  const refOf = id => { const b = blById[id], s = S.sched[id]; return b ? {s: off(b.start), e: off(b.end)} : {s: s.es, e: s.ef}; };
  // réalisé : réel pour fait/en cours, sinon posé sur le plan
  // réalisé/prévisionnel : passe AVANT qui propage les retards réels sur l'aval
  // (une tâche démarrée en retard repousse le début de ses successeurs non démarrés)
  const actMap = {};
  S.order.slice().sort((a, b) => S.sched[a].depth - S.sched[b].depth).forEach(id => {
    const t = S.byId[id], r = refOf(id), rs = t.start_date ? off(t.start_date) : null;
    const dur = Math.max(0, r.e - r.s);
    const predEnd = (S.preds[id] || []).reduce((m, p) => actMap[p] ? Math.max(m, actMap[p].e) : m, 0);
    if(t.done && t.done_date){
      const de = off(t.done_date), a = rs != null ? Math.min(rs, de) : Math.max(0, de - dur);
      const minDur = t.is_milestone ? 0 : 1;   // une tâche faite occupe ≥ 1 jour (le jour où elle a été faite) ; un jalon reste ponctuel
      actMap[id] = {s: a, e: Math.max(a + minDur, de)};
    } else if(rs != null){
      actMap[id] = {s: rs, e: Math.max(rs + dur, tIdx)};                 // en cours
    } else {
      // pas démarré : ne JAMAIS placer dans le passé (≥ aujourd'hui), décalé par les preds
      // en retard ET par un livrable attendu non reçu (gateF, comme fc)
      const gate = (S.gateF && (id in S.gateF)) ? S.gateF[id] : -1;
      const s = Math.max(r.s, predEnd, gate, tIdx);
      actMap[id] = {s, e: s + dur};
    }
  });
  const actOf = id => actMap[id] || refOf(id);
  let days = Math.max(1, S.projectDays, tIdx);
  tasks.forEach(id => { const r = refOf(id), a = actOf(id); days = Math.max(days, r.e, a.e); });
  const labelW = 180, dayW = Math.max(9, Math.min(28, Math.floor(740 / days))), rowH = 34, top = 28;
  const W = labelW + days * dayW + 30, H = top + tasks.length * rowH + 16;
  const x = d => labelW + d * dayW;
  let g = `<div class="scrollx"><svg width="${W}" height="${H}" class="gantt">`;
  g += `<defs><marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">` +
       `<path d="M0,0 L6,3 L0,6 Z" fill="#9ca3af"/></marker>` +
       `<pattern id="ov" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
       `<rect width="6" height="6" fill="#fde2cf"/><line x1="0" y1="0" x2="0" y2="6" stroke="#ea580c" stroke-width="3"/></pattern>` +
       `<pattern id="crit" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
       `<rect width="6" height="6" fill="#a7f3d0"/><line x1="0" y1="0" x2="0" y2="6" stroke="#059669" stroke-width="3"/></pattern></defs>`;
  // pas adaptatif : on n'étiquette/quadrille que tous les N jours pour garder ~38px entre dates (lisible)
  const step = Math.max(1, Math.ceil(38 / dayW));
  for(let d = 0; d <= days; d += step){
    g += `<line x1="${x(d)}" y1="${top}" x2="${x(d)}" y2="${H - 12}" stroke="var(--line-soft)"/>`;
    g += `<text x="${x(d)}" y="${top - 8}" font-size="9" fill="var(--faint)" text-anchor="middle">${fmtShort(addUnits(S.start, d))}</text>`;
  }
  if(tIdx >= 0 && tIdx <= days) g += `<line x1="${x(tIdx)}" y1="${top}" x2="${x(tIdx)}" y2="${H - 12}" stroke="var(--red)" stroke-dasharray="3 3"/>`;
  // fleches de dependance — suivent les positions RÉELLES des barres (réalisé), pas le plan
  const barCy = k => top + k * rowH + 21;   // centre vertical de la barre "réalisé"
  tasks.forEach((id, i) => {
    S.preds[id].forEach(p => {
      const j = tasks.indexOf(p); if(j < 0) return;
      const x1 = x(actOf(p).e), y1 = barCy(j);
      const x2 = x(actOf(id).s), y2 = barCy(i);
      g += `<path d="M${x1},${y1} C${x1 + 12},${y1} ${x2 - 12},${y2} ${x2},${y2}" fill="none" stroke="#d1d5db" stroke-width="1" marker-end="url(#ah)"/>`;
    });
  });
  // barres : référence (plan, fin grise) + réalisé (réel) + dépassement (hachuré orange)
  tasks.forEach((id, i) => {
    const s = S.sched[id], t = s.task, y0 = top + i * rowH + 5, r = refOf(id), a = actOf(id);
    g += `<text x="${labelW - 8}" y="${y0 + 10}" font-size="11" text-anchor="end" fill="var(--ink)">${esc(t.label.slice(0, 26))}</text>`;
    const yRef = y0 + 1, yAct = hasBl ? y0 + 9 : y0 + 7;   // sans référence figée : barre seule, un peu remontée
    const inprog = !t.done && !!t.start_date;
    const late = !inprog && taskLate(c, S, id);   // retard = prévision vs référence/échéance (pas le plan auto)
    // dépassement = DURÉE propre de la tâche (réelle vs prévue), pas la fin calendaire
    const plannedDur = Math.max(0, r.e - r.s), actualDur = Math.max(0, a.e - a.s);
    const over = !t.is_milestone && actualDur > plannedDur;
    const extra = over ? actualDur - plannedDur : 0;
    const lateStart = Math.max(0, a.s - r.s);   // retard de démarrage (jours ouvrés)
    const dlabel = t.done ? "terminé" : inprog ? "en cours" : late ? "en retard" : s.critical ? "critique" : "à faire";
    const real = (t.start_date || t.done) ? fmt(addUnits(S.start, a.s)) + " → " + (t.done ? fmt(addUnits(S.start, a.e)) : "…") : "—";
    const durTxt = (t.start_date || t.done) && !t.is_milestone
      ? `\nDurée : ${actualDur} j réel vs ${plannedDur} j prévu` + (over ? ` (+${extra}, plus long)` : actualDur < plannedDur ? ` (−${plannedDur - actualDur}, plus rapide)` : " (conforme)")
      : "";
    const tip = `${esc(t.label)}\nPlanifié : ${fmt(addUnits(S.start, r.s))} → ${fmt(addUnits(S.start, r.e))}\nRéel : ${real}` +
                (lateStart ? `\nDémarrage : +${lateStart} j de retard` : "") + durTxt + `\n(${dlabel})`;
    if(t.is_milestone){
      if(hasBl) g += `<path d="M${x(r.s)},${yRef + 3} L${x(r.s) + 4},${yRef + 7} L${x(r.s)},${yRef + 11} L${x(r.s) - 4},${yRef + 7} Z" fill="none" stroke="#cbd5e1"/>`;
      const mx = x(t.done ? a.e : r.s), cy = yAct + 7, rr = 6;
      g += `<path d="M${mx},${cy - rr} L${mx + rr},${cy} L${mx},${cy + rr} L${mx - rr},${cy} Z" fill="${t.done ? "var(--green)" : late ? "var(--red)" : s.critical ? "#059669" : "var(--ink)"}"><title>${tip}</title></path>`;
    } else {
      // référence (plan) — barre fine grise UNIQUEMENT si une référence est figée
      if(hasBl) g += `<rect x="${x(r.s)}" y="${yRef}" width="${Math.max(2, (r.e - r.s) * dayW)}" height="5" rx="1" fill="#e5e7eb"><title>${tip}</title></rect>`;
      // réalisé — segment dans le plan ; priorité : terminé > en cours > en retard > critique > à faire
      let fill, stroke = "";
      if(t.done) fill = "var(--green)";
      else if(inprog){ fill = "var(--inprog)"; stroke = ` stroke="var(--inprog-d)" stroke-width="1.5"`; }   // bleu
      else if(late) fill = "var(--red)";                                                                     // en retard
      else if(s.critical){ fill = "url(#crit)"; stroke = ` stroke="#047857" stroke-width=".8"`; }            // vert texturé
      else { fill = "#a78bfa"; stroke = ` stroke="#7c3aed" stroke-width=".8"`; }                             // à faire (violet, distinct du gris du plan)
      // segment "dans la durée prévue" (à partir du début RÉEL) + queue de dépassement de DURÉE
      const overStart = a.s + plannedDur, mainEnd = over ? overStart : a.e;
      g += `<rect x="${x(a.s)}" y="${yAct}" width="${Math.max(3, (mainEnd - a.s) * dayW)}" height="14" rx="2" fill="${fill}"${stroke} opacity="${t.done ? .9 : 1}"><title>${tip}</title></rect>`;
      // dépassement = la tâche a pris plus de temps que prévu (queue hachurée orange)
      if(over) g += `<rect x="${x(overStart)}" y="${yAct}" width="${Math.max(2, extra * dayW)}" height="14" rx="2" fill="url(#ov)" stroke="#ea580c" stroke-width=".6"><title>A pris +${extra} j de plus que prévu — ${esc(t.label)}</title></rect>`;
    }
    // DÉRIVE calendaire : écart de FIN réelle/projetée vs plan (fin trait sous la barre).
    // Rouge = fini/projeté plus tard que prévu, vert = plus tôt. La dérive s'accumule le long de la chaîne.
    const endSlip = a.e - r.e;
    if(hasBl && endSlip !== 0){   // dérive vs référence figée seulement (pas vs un plan auto non figé)
      const dyl = y0 + 26, xa = x(Math.min(r.e, a.e)), xb = x(Math.max(r.e, a.e));
      const dc = endSlip > 0 ? "rgba(220,38,38,.55)" : "rgba(5,150,105,.55)";
      g += `<line x1="${xa}" y1="${dyl}" x2="${xb}" y2="${dyl}" stroke="${dc}" stroke-width="3" stroke-linecap="round">` +
           `<title>Dérive de fin vs plan : ${endSlip > 0 ? "+" + endSlip : endSlip} j ${endSlip > 0 ? "(en retard)" : "(en avance)"}</title></line>`;
    }
  });
  g += `</svg></div>`;
  g += `<div class="legend">` + (hasBl ? `<span><i class="sq refb"></i>référence figée</span>` : ``) +
       `<span><i class="sq todob"></i>à faire</span><span><i class="sq inprogb"></i>en cours</span>` +
       `<span><i class="sq red"></i>en retard</span><span><i class="sq critb"></i>critique</span>` +
       `<span><i class="sq green"></i>terminée</span><span><i class="sq ovb"></i>dépassement (durée)</span>` +
       `<span><i class="drift-lg"></i>dérive de fin (rouge=retard, vert=avance)</span>` +
       `<span><i class="dia"></i>jalon</span></div>`;
  return g;
}

function pertSVG(c, S){
  const tasks = S.order; if(!tasks.length) return `<div class="empty">—</div>`;
  // colonnes par profondeur
  const cols = {}; tasks.forEach(id => { const d = S.sched[id].depth; (cols[d] = cols[d] || []).push(id); });
  const depths = Object.keys(cols).map(Number).sort((a, b) => a - b);
  const NW = 158, NH = 70, COLW = 196, ROWH = 100, padX = 16, padY = 16;
  const maxRows = Math.max(...depths.map(d => cols[d].length));
  const W = padX * 2 + depths.length * COLW, H = padY * 2 + maxRows * ROWH;
  const pos = {};
  depths.forEach((d, ci) => cols[d].forEach((id, ri) => pos[id] = {x: padX + ci * COLW, y: padY + ri * ROWH}));
  let g = `<div class="scrollx"><svg width="${W}" height="${H}" class="pert">`;
  g += `<defs><marker id="ap" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">` +
       `<path d="M0,0 L6,3 L0,6 Z" fill="#9ca3af"/></marker>` +
       `<marker id="apc" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">` +
       `<path d="M0,0 L6,3 L0,6 Z" fill="var(--red)"/></marker></defs>`;
  // arcs
  tasks.forEach(id => S.preds[id].forEach(p => {
    if(!pos[p] || !pos[id]) return;
    const a = pos[p], b = pos[id];
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    const crit = S.sched[p].critical && S.sched[id].critical;
    g += `<path d="M${x1},${y1} C${x1 + 28},${y1} ${x2 - 28},${y2} ${x2},${y2}" fill="none" ` +
         `stroke="${crit ? "var(--red)" : "#d1d5db"}" stroke-width="${crit ? 2 : 1}" marker-end="url(#${crit ? "apc" : "ap"})"/>`;
  }));
  // noeuds
  tasks.forEach(id => {
    const s = S.sched[id], t = s.task, P = pos[id];
    const crit = s.critical;
    g += `<g transform="translate(${P.x},${P.y})">`;
    g += `<rect width="${NW}" height="${NH}" rx="3" fill="#fff" stroke="${crit ? "var(--red)" : "var(--line)"}" stroke-width="${crit ? 2 : 1}"/>`;
    g += `<text x="${NW / 2}" y="16" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--ink)">${esc(t.label.slice(0, 22))}</text>`;
    g += `<line x1="0" y1="24" x2="${NW}" y2="24" stroke="var(--line-soft)"/>`;
    g += `<text x="8" y="40" font-size="9.5" fill="var(--muted)">déb ${fmtShort(s.startDate)}</text>`;
    g += `<text x="${NW - 8}" y="40" text-anchor="end" font-size="9.5" fill="var(--muted)">fin ${fmtShort(s.endDate)}</text>`;
    g += `<text x="8" y="56" font-size="9.5" fill="var(--muted)">${t.is_milestone ? "jalon" : "durée " + t.duree + "j"}</text>`;
    g += `<text x="${NW - 8}" y="56" text-anchor="end" font-size="9.5" fill="${crit ? "var(--red)" : "var(--muted)"}">${crit ? "critique" : "marge " + s.slack + "j"}</text>`;
    g += `</g>`;
  });
  g += `</svg></div><div class="legend"><span><i class="sq red"></i>chemin critique (marge 0)</span><span>chaque case = ES/EF + marge</span></div>`;
  return g;
}

function livrablesBlock(c){
  let h = "";
  if(!c.livrables.length) h += `<div class="empty">Rien en attente.</div>`;
  // mini-frise
  if(c.livrables.length){
    const dates = c.livrables.filter(l => l.date).map(l => l.date);
    if(dates.length){
      let mn = dates.reduce((a, b) => a < b ? a : b), mx = dates.reduce((a, b) => a > b ? a : b);
      if(TODAY < mn) mn = TODAY; if(TODAY > mx) mx = TODAY;
      const span = Math.max(1, daysBetween(mn, mx)), labelW = 150, W = labelW + 520 + 20, dayW = 520 / span;
      const x = d => labelW + daysBetween(mn, d) * dayW;
      let g = `<div class="scrollx"><svg width="${W}" height="${c.livrables.length * 24 + 30}" class="frise">`;
      const tIdx = x(TODAY);
      g += `<line x1="${tIdx}" y1="14" x2="${tIdx}" y2="${c.livrables.length * 24 + 18}" stroke="var(--red)" stroke-dasharray="3 3"/>`;
      g += `<text x="${tIdx}" y="10" font-size="9" fill="var(--red)" text-anchor="middle">auj.</text>`;
      c.livrables.forEach((l, i) => {
        const y = 24 + i * 24;
        g += `<text x="${labelW - 8}" y="${y + 4}" font-size="10.5" text-anchor="end" fill="var(--ink)">${esc((l.personne || "").slice(0, 18))}</text>`;
        g += `<line x1="${labelW}" y1="${y}" x2="${labelW + 520}" y2="${y}" stroke="var(--line-soft)"/>`;
        if(l.date){
          const late = (livPending(l)) && isLate(l.date);
          const col = l.statut === "recu" ? "var(--green)" : l.statut === "annule" ? "var(--faint)"
                    : l.statut === "partiel" ? "var(--blue)" : (late ? "var(--red)" : "var(--amber)");
          g += `<circle cx="${x(l.date)}" cy="${y}" r="5" fill="${col}"/>`;
          g += `<text x="${x(l.date) + 9}" y="${y + 3}" font-size="9" fill="var(--muted)">${fmtShort(l.date)}</text>`;
        }
      });
      g += `</svg></div>`;
      h += g;
    }
  }
  // liste editable
  c.livrables.forEach(l => {
    const late = (livPending(l)) && isLate(l.date);
    const cls = l.statut === "recu" ? "recu" : l.statut === "annule" ? "annule"
              : l.statut === "partiel" ? "partiel" : (late ? "retard" : "attente");
    const cidSel = l.contact_id || "";
    const psel = `<select class="liv-psel" title="Qui doit le livrer" onchange="assignPerson('${c.id}','${l.id}',this)">` +
      (cidSel ? "" : `<option value="" selected>— choisir —</option>`) +
      knownPeople().map(p => `<option value="${esc(p.id)}" ${p.id === cidSel ? "selected" : ""}>${p.moi ? "🧍 " : ""}${esc(p.nom)}</option>`).join("") +
      `<option value="__new__">+ nouvelle…</option></select>`;
    const u = (extra) => `mutate({op:'update_livrable',chantier_id:'${c.id}',livrable_id:'${l.id}',${extra}})`;
    h += `<div class="d-deliv"><span class="stm ${cls}" style="margin-top:6px"></span><div class="dl-body">` +
      `<input class="liv-q" value="${esc(l.quoi)}" placeholder="Ce que j'attends" title="Description" onchange="${u("quoi:this.value")}">` +
      `<div class="liv-meta">` +
        `<span class="fld"><span class="fl">de</span>${psel}</span>` +
        `<span class="fld"><span class="fl">pour le</span><input type="date" class="liv-d" value="${l.date || ""}" onchange="${u("date:this.value")}"></span>` +
        `<span class="fld"><span class="fl">statut</span><select onchange="${u("statut:this.value")}">` +
          Object.keys(LIV).map(s => `<option value="${s}" ${l.statut === s ? "selected" : ""}>${LIV[s]}</option>`).join("") + `</select></span>` +
        (late ? `<span class="lt-badge">EN RETARD</span>` : "") +
      `</div>` +
      (l.impact ? `<div class="relance">Impact : ${esc(l.impact)}</div>` : "") +
      (l.relances ? `<div class="relance">relancé ${l.relances}× · dernière le ${fmt(l.derniere)}</div>` : "") +
      `<div class="acts">` +
        `<select title="Rattacher à une tâche : elle attend ce livrable" onchange="${u("tache_id:this.value")}"><option value="">— ne bloque aucune tâche —</option>` +
          c.taches.map(t => `<option value="${t.id}" ${l.tache_id === t.id ? "selected" : ""}>bloque : ${esc(t.label)}</option>`).join("") + `</select>` +
        `<a onclick="${u("relance:true")}">Relancé aujourd'hui</a>` +
        `<a class="danger" onclick="if(confirm('Supprimer ce livrable ?'))mutate({op:'remove_livrable',chantier_id:'${c.id}',livrable_id:'${l.id}'})">Supprimer</a>` +
      `</div></div></div>`;
  });
  h += `<div id="addLiv_${c.id}"></div>`;
  return h;
}

// ---------------------------------------------------------------------------
// Recette — la checklist, directement sur la page du chantier.
// Pas de page dédiée : ce qu'on regarde tous les jours doit être là où on est.
// ---------------------------------------------------------------------------
function recetteCard(c){
  if(!c.recette)
    return `<div class="empty">Aucune liste de recette. Elle sert à ne rien oublier avant de dire « c'est livré ».</div>` +
      `<button class="btn sm primary" onclick="mutate({op:'recette_init',chantier_id:'${c.id}'})">+ Démarrer la recette</button>`;
  const st = recStats(c), pts = recPoints(c), run = recChrono(c.id), min = recetteMin(c.id);
  let h = "";
  // Bandeau : avancement, temps passé, et le chrono qui va avec.
  h += `<div class="rec-top">`;
  h += `<span class="rec-count ${st.fini ? "done" : ""}">${st.ok}/${st.total} vérifié${st.ok > 1 ? "s" : ""}</span>`;
  if(st.probleme) h += `<span class="rec-pb">${st.probleme} problème${st.probleme > 1 ? "s" : ""}</span>`;
  if(st.fini) h += `<span class="rec-fini">✓ Tout est vérifié</span>`;
  h += `<span class="grow"></span>`;
  h += `<span class="rec-time" title="Temps total chronométré sur cette recette">⏱ ${min ? fmtDur(min) : "0 min"}</span>`;
  if(run) h += `<span class="tstate inprog running" title="Chrono en cours depuis ${run.debut}">⏱ ${esc((run.label || "").replace(/^Recette — /, ""))}</span>`;
  h += `</div>`;
  if(st.total){
    h += `<div class="rec-bar" title="${st.ok} vérifié(s) · ${st.probleme} problème(s) · ${st.a_verifier} à vérifier">` +
      (st.ok ? `<i class="p-ok" style="width:${st.ok / st.total * 100}%"></i>` : "") +
      (st.probleme ? `<i class="p-ko" style="width:${st.probleme / st.total * 100}%"></i>` : "") + `</div>`;
  }
  h += `<div id="recForm_${c.id}"></div>`;
  if(!pts.length)
    h += `<div class="empty">Aucun point. Pars de la liste type : c'est plus rapide, et ça évite d'oublier ` +
         `ce qu'on ne pense jamais à écrire (habilitations, reprise de l'historique, sauvegarde).</div>`;
  // à vérifier et problèmes d'abord : ce qui reste à faire est en haut
  const ord = {probleme: 0, a_verifier: 1, ok: 2};
  pts.slice().sort((a, b) => ord[a.statut] - ord[b.statut]).forEach(p => h += recPointRow(c, p));
  h += `<div class="rec-add"><a class="lnk" onclick="showPointPicker('${c.id}')">+ depuis la liste type</a>` +
       `<a class="lnk" onclick="showPointForm('${c.id}')">+ point sur mesure</a></div>`;
  if(st.fini && c.statut !== "done")
    h += `<div class="rec-done-hint">Tout est vérifié — <a class="lnk" onclick="mutate({op:'move_chantier',id:'${c.id}',statut:'done'})">passer le chantier en « Terminé »</a></div>`;
  return h;
}

// Une ligne de point EST une ligne de tâche : mêmes classes, mêmes gestes,
// même cycle ▶ Démarrer → ⏹ Terminer → ✓ Vérifié, et le temps sur la ligne.
// Seule différence : le troisième état « problème », qu'une tâche n'a pas.
function recPointRow(c, p){
  const run = activeForPoint(p.id), min = pointMin(p.id);
  const pb = p.statut === "probleme", ok = p.statut === "ok";
  const late = pb && isLate(p.echeance);
  const u = extra => `mutate({op:'point_update',chantier_id:'${c.id}',point_id:'${p.id}',${extra}})`;
  const set = st => `pointSet('${c.id}','${p.id}','${st}')`;

  // contrôle principal, à gauche — décalque de celui d'une tâche
  let ctrl;
  if(ok){
    ctrl = `<button class="tprog-done" title="Vérifié — cliquer pour rouvrir" onclick="${set("a_verifier")}">✓ Vérifié</button>`;
  } else if(run){
    ctrl = `<button class="tstart stop" title="Terminer : arrête le chrono et marque vérifié" onclick="ptStop('${c.id}','${p.id}')">⏹ Terminer</button>` +
           `<span class="tstate inprog running" title="Chrono en cours depuis ${run.debut}">⏱ ${run.debut}</span>`;
  } else if(p.debut){
    ctrl = `<button class="tfinish" title="Marquer vérifié" onclick="${set("ok")}">✓ Vérifier</button>` +
           `<span class="tstate inprog" title="Vérification démarrée le ${fmt(p.debut)} — chrono en pause">● en cours</span>`;
  } else {
    ctrl = `<button class="tstart" title="Démarrer la vérification — lance le chrono sur ce point" onclick="mutate({op:'point_start',chantier_id:'${c.id}',point_id:'${p.id}'})">▶ Démarrer</button>`;
  }

  let h = `<div class="trow${pb ? " pb" : ""}${late ? " late" : ""}"><div class="trow-main">`;
  h += ctrl;
  h += `<input class="tlabel ${ok ? "done" : ""}" value="${esc(p.titre)}" ` +
       `onblur="if(this.value.trim()&&this.value!=='${jqs(p.titre)}')${u("titre:this.value.trim()")}">`;
  h += pb
    ? `<button class="pt-flag on" title="Problème levé — cliquer quand c'est corrigé" onclick="${set("ok")}">⚠ Problème</button>`
    : `<button class="pt-flag" title="Signaler un problème sur ce point" onclick="${set("probleme")}">⚠</button>`;
  if(min) h += `<span class="tstate real" title="Temps chronométré sur ce point">⏱ ${fmtDur(min)}</span>`;
  if(ok && p.verifie_le) h += `<span class="dates">vérifié le ${fmt(p.verifie_le)}</span>`;
  h += `<span class="del" title="Supprimer ce point" onclick="if(confirm('Supprimer « ${jqs(p.titre)} » ?'))mutate({op:'point_remove',chantier_id:'${c.id}',point_id:'${p.id}'})">×</span>`;
  h += `</div>`;
  if(pb){
    h += `<div class="pt-pb">` +
      `<input class="pt-c" value="${esc(p.constat || "")}" placeholder="Qu'est-ce qui ne va pas ?" onchange="${u("constat:this.value")}">` +
      `<input class="pt-q" list="recPeople" value="${esc(p.qui || "")}" placeholder="qui corrige" onchange="${u("qui:this.value")}">` +
      `<input class="pt-e" type="date" title="Corrigé avant le" value="${p.echeance || ""}" onchange="${u("echeance:this.value")}">` +
      (late ? `<span class="lt-badge">EN RETARD</span>` : "") + `</div>`;
  }
  return h + `</div>`;
}
function pointSet(cid, pid, statut){ mutate({op: "point_set", chantier_id: cid, point_id: pid, statut}); }
// Terminer = arrêter le chrono ET marquer vérifié — exactement comme acStop() sur une action.
async function ptStop(cid, pid){
  await mutate({op: "clock_stop"});
  await mutate({op: "point_set", chantier_id: cid, point_id: pid, statut: "ok"});
}
function showPointForm(cid){
  $("recForm_" + cid).innerHTML =
    `<div class="miniform"><input id="pt_titre" placeholder="Ce qu'il faut vérifier (ex. « L'export est accepté par Sage »)">` +
    `<div class="actions"><button class="btn sm" onclick="hide('recForm_${cid}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="pointAdd('${cid}')">Ajouter</button></div></div>`;
  $("pt_titre").focus();
  $("pt_titre").addEventListener("keydown", e => { if(e.key === "Enter") pointAdd(cid); });
}
function pointAdd(cid){
  const t = $("pt_titre").value.trim();
  if(!t){ $("pt_titre").focus(); return; }
  mutate({op: "point_add", chantier_id: cid, titre: t});
}

// ---------------------------------------------------------------------------
// Liste de points types — on coche, on n'écrit pas. Une checklist qu'il faut
// rédiger de zéro ne se rédige jamais.
// ---------------------------------------------------------------------------
const POINTS_CATALOG = {
  "Données & reprise": [
    "Volumétrie reprise identique à la source",
    "Totaux de contrôle identiques (montants, quantités)",
    "Aucun doublon créé par la reprise",
    "Champs obligatoires tous renseignés",
    "Accents et caractères spéciaux préservés",
    "Historique antérieur toujours consultable",
  ],
  "Reporting & Power BI": [
    "Indicateur clé recoupé avec le chiffre officiel",
    "Filtres et sélecteurs appliqués correctement",
    "Rafraîchissement automatique effectif",
    "Export vers Excel conforme à l'écran",
    "Chaque utilisateur ne voit que son périmètre",
    "Libellés, unités et devises corrects",
  ],
  "Interfaces & flux": [
    "Fichier généré au bon format, au bon endroit",
    "Import accepté par le système destinataire",
    "Rejets tracés et exploitables",
    "Rejeu d'un flux sans double intégration",
    "Traitement planifié déclenché à l'heure",
    "Alerte envoyée en cas d'échec",
  ],
  "Compta & gestion": [
    "Écritures équilibrées (débit = crédit)",
    "Imputation analytique présente et juste",
    "Comptes et journaux conformes au plan comptable",
    "TVA calculée au bon taux",
    "Rapprochement avec le grand livre",
    "Aucune écriture possible sur période close",
  ],
  "Application métier": [
    "Création d'un enregistrement de bout en bout",
    "Modification et suppression conformes",
    "Contrôles de saisie bloquants aux bons endroits",
    "Recherche et filtres renvoient le bon résultat",
    "Circuit de validation respecté",
    "Édition / impression conforme au modèle",
    "Fonctionne sur le poste utilisateur réel",
  ],
  "Atelier & production": [
    "Déclaration au poste remontée (OF, quantité, temps)",
    "Temps passé imputé au bon ordre de fabrication",
    "Stock décrémenté à la déclaration",
    "Fonctionne malgré une coupure réseau",
    "Traçabilité lot / série conservée",
    "Écran lisible dans les conditions de l'atelier",
  ],
  "Accès & sécurité": [
    "Chaque profil accède à ce qui le concerne",
    "Un profil restreint ne peut pas élargir ses droits",
    "Compte désactivé : accès effectivement révoqué",
    "Actions sensibles tracées",
  ],
  "Mise en service": [
    "Sauvegarde ET restauration testées",
    "Procédure d'exploitation rédigée et à jour",
    "Mode opératoire utilisateur disponible",
    "Utilisateurs formés et autonomes",
    "Support et escalade identifiés",
    "L'existant fonctionne toujours (non-régression)",
  ],
};
const PT_CAT_NOMS = Object.keys(POINTS_CATALOG);
let PT_CAT_I = 0;
// Le sélecteur tient dans n'importe quelle largeur : les domaines sont des
// puces qui passent à la ligne, la liste occupe toute la place en dessous.
function showPointPicker(cid){
  PT_CAT_I = 0;
  $("recForm_" + cid).innerHTML =
    `<div class="miniform pt-pick-box"><div class="rk-step">Choisis un domaine, décoche ce qui ne s'applique pas.</div>` +
    `<div id="ptbrowse_${cid}">${ptBrowseHtml(cid, 0)}</div>` +
    `<div id="ptlist_${cid}">${ptListHtml(cid, 0)}</div>` +
    `<div class="actions"><button class="btn sm" onclick="hide('recForm_${cid}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="pointAddLot('${cid}')">Ajouter les points cochés</button></div></div>`;
}
function ptBrowseHtml(cid, ci){
  return `<div class="pt-cats">` + PT_CAT_NOMS.map((cat, i) =>
    `<button class="pt-cat ${i === ci ? "sel" : ""}" onclick="ptCat('${cid}',${i})">${esc(cat)}</button>`).join("") + `</div>`;
}
function ptListHtml(cid, ci){
  return `<div class="pt-pick">` + POINTS_CATALOG[PT_CAT_NOMS[ci]].map((l, i) =>
    `<label class="pt-opt"><input type="checkbox" class="pt-ck" data-i="${i}" checked>` +
    `<span>${esc(l)}</span></label>`).join("") + `</div>`;
}
function ptCat(cid, ci){
  PT_CAT_I = ci;
  $("ptbrowse_" + cid).innerHTML = ptBrowseHtml(cid, ci);
  $("ptlist_" + cid).innerHTML = ptListHtml(cid, ci);
}
function pointAddLot(cid){
  const cat = POINTS_CATALOG[PT_CAT_NOMS[PT_CAT_I]];
  const titres = [...document.querySelectorAll("#ptlist_" + cid + " .pt-ck")]
    .filter(e => e.checked).map(e => cat[+e.dataset.i]);
  if(!titres.length){ alert("Coche au moins un point."); return; }
  mutate({op: "point_add_lot", chantier_id: cid, titres});
}
function peopleDatalist(){
  return `<datalist id="recPeople">` + knownPeople().map(p => `<option value="${esc(p.nom)}">`).join("") + `</datalist>`;
}

function progressCurve(c, S){
  const total = c.taches.length; if(!total) return `<div class="empty">—</div>`;
  const dones = c.taches.filter(t => t.done && t.done_date).map(t => t.done_date).sort();
  const start = S.start, endRef = [c.echeance, TODAY, S.end, dones[dones.length - 1]].filter(Boolean).sort().pop();
  const span = Math.max(1, daysBetween(start, endRef));
  const W = 560, H = 150, padL = 30, padB = 22, padT = 10, plotW = W - padL - 14, plotH = H - padT - padB;
  const x = d => padL + (daysBetween(start, d) / span) * plotW;
  const y = v => padT + plotH - (v / total) * plotH;
  let pts = `${padL},${y(0)}`; let cum = 0;
  dones.forEach(d => { pts += ` ${x(d)},${y(cum)}`; cum++; pts += ` ${x(d)},${y(cum)}`; });
  pts += ` ${x(endRef)},${y(cum)}`;
  // ligne ideale (lineaire start->echeance)
  const idealEnd = c.echeance || S.end;
  let g = `<svg width="${W}" height="${H}" class="curve">`;
  g += `<line x1="${padL}" y1="${y(0)}" x2="${W - 8}" y2="${y(0)}" stroke="var(--line-soft)"/>`;
  g += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${y(0)}" stroke="var(--line-soft)"/>`;
  g += `<text x="6" y="${y(total) + 4}" font-size="9" fill="var(--faint)">${total}</text>`;
  g += `<text x="10" y="${y(0) + 4}" font-size="9" fill="var(--faint)">0</text>`;
  g += `<line x1="${padL}" y1="${y(0)}" x2="${x(idealEnd)}" y2="${y(total)}" stroke="#d1d5db" stroke-dasharray="4 3"/>`;
  const tIdx = x(TODAY);
  if(daysBetween(start, TODAY) >= 0) g += `<line x1="${tIdx}" y1="${padT}" x2="${tIdx}" y2="${y(0)}" stroke="var(--red)" stroke-dasharray="3 3"/>`;
  g += `<polyline points="${pts}" fill="none" stroke="var(--ink)" stroke-width="2"/>`;
  g += `<text x="${padL}" y="${H - 6}" font-size="9" fill="var(--faint)">${fmtShort(start)}</text>`;
  g += `<text x="${x(idealEnd)}" y="${H - 6}" font-size="9" fill="var(--faint)" text-anchor="end">${fmtShort(idealEnd)}</text>`;
  g += `</svg><div class="legend"><span><i class="sq inkb"></i>réel (tâches terminées)</span><span><i class="sq grayb"></i>idéal</span></div>`;
  return g;
}

// ---- mini-formulaires (page) ---------------------------------------------
function showAddTache(id){
  const c = chById(id);
  const opts = c.taches.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
  $("addTache_" + id).innerHTML =
    `<div class="miniform"><input id="ntl" placeholder="Nouvelle tâche">` +
    `<div class="row"><label class="ms"><input type="checkbox" id="ntm"> jalon</label>` +
    `<span class="fld"><span class="fl">Durée</span><input id="ntd" type="number" min="0" value="1"><span class="fu">j</span></span>` +
    `<span class="fld"><span class="fl">Début imposé (option.)</span><input id="nts" type="date"></span></div>` +
    (opts ? `<select id="ntp"><option value="">après… (prédécesseur, optionnel)</option>${opts}</select>`
          : `<select id="ntp" style="display:none"></select>`) +
    `<div class="actions"><button class="btn sm" onclick="hide('addTache_${id}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addTache('${id}')">Ajouter</button></div></div>`;
  $("ntl").focus();
  $("ntl").addEventListener("keydown", e => { if(e.key === "Enter") addTache(id); });
}
function addTache(id){
  const v = $("ntl").value.trim(); if(!v) return;
  const pv = $("ntp").value;
  mutate({op: "add_tache", chantier_id: id, label: v, is_milestone: $("ntm").checked,
          duree: $("ntd").value, start_fix: $("nts").value || null, preds: pv ? [pv] : []});
}
// Insérer un modèle de tâches (WBS) standard
function showWbs(id){
  const items = Object.keys(WBS_TEMPLATES).map(name => {
    const ts = WBS_TEMPLATES[name], steps = ts.map(t => esc(t.label)).join(" → ");
    return `<button class="tpl-item" onclick="applyWbs('${id}','${jqs(name)}')"><b>${esc(name)}</b>` +
      `<span class="muted small">${ts.length} tâches · ${steps}</span></button>`;
  }).join("");
  $("addTache_" + id).innerHTML =
    `<div class="miniform"><div class="tpl-h">Insérer un modèle de tâches (WBS) — durées &amp; dépendances pré-câblées :</div>` +
    `<div class="tpl-list">${items}</div>` +
    `<div class="actions"><button class="btn sm" onclick="hide('addTache_${id}')">Annuler</button></div></div>`;
}
function applyWbs(id, name){
  const ts = WBS_TEMPLATES[name]; if(!ts) return;
  mutate({op: "apply_template", chantier_id: id, taches: ts});
}

// ---- import / modele Excel ----------------------------------------------
function importExcel(input){
  const file = input.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const d = await api("POST", "/api/import", {b64: reader.result});
    input.value = "";
    if(d.error){ alert(d.error); return; }
    STORE = d.store; TODAY = d.today;
    alert(d.message || "Import terminé.");
    CUR = null; showView("board");   // showView peint déjà l'alerte + le board
  };
  reader.readAsDataURL(file);
}
function showAddNote(id){
  $("addNote_" + id).innerHTML =
    `<div class="miniform"><textarea id="nnt" placeholder="Note (relance, décision, point…)"></textarea>` +
    `<div class="actions"><button class="btn sm" onclick="hide('addNote_${id}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addNote('${id}')">Ajouter</button></div></div>`;
  $("nnt").focus();
}
function addNote(id){ const v = $("nnt").value.trim(); if(v) mutate({op: "add_note", chantier_id: id, texte: v}); }

function showAddPartie(id){
  const chips = PARTIE_CATALOG.map(p =>
    `<button class="tpl-chip" title="${esc(p.role)}" onclick="partieFill('${jqs(p.nom)}','${jqs(p.role)}')">${esc(p.nom)}</button>`).join("");
  const people = knownPeople().map(p => `<option value="${esc(p.id)}">${p.moi ? "🧍 " : ""}${esc(p.nom)}${p.role ? " (" + esc(p.role) + ")" : ""}</option>`).join("");
  $("addPartie_" + id).innerHTML =
    `<div class="miniform"><div class="row"><select id="ppc" onchange="partiePick()"><option value="">— depuis l'annuaire / nouveau —</option>${people}</select></div>` +
    `<div class="tpl-h">Rôle standard (clic pour pré-remplir) :</div><div class="tpl-chips">${chips}</div>` +
    `<div class="row"><input id="ppn" placeholder="Nom / entité"><input id="ppr" placeholder="Rôle"></div>` +
    `<div class="actions"><button class="btn sm" onclick="hide('addPartie_${id}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addPartie('${id}')">Ajouter</button></div></div>`;
  $("ppn").focus();
}
function partieFill(nom, role){ $("ppn").value = nom; $("ppr").value = role; }
function partiePick(){ const c = contactById($("ppc").value); if(c) $("ppn").value = c.nom; }
function addPartie(id){
  const cidp = $("ppc") ? $("ppc").value : "";
  const v = $("ppn").value.trim();
  const role = $("ppr").value.trim();
  if(cidp) mutate({op: "add_partie", chantier_id: id, contact_id: cidp, role});
  else if(v) mutate({op: "add_partie", chantier_id: id, nom: v, role});
}

// (le tag libre a été remplacé par le thème : liste fermée, choisie dans un <select>)

// ---- Personnes : l'annuaire (STORE.contacts) est la source de vérité --------
// Rôles standard suggérés (PMP/PRINCE2) — le champ reste libre (datalist).
const PERSON_ROLES = ["Chef de projet", "Sponsor / Commanditaire", "MOA / Métier",
  "MOE / Technique", "Demandeur", "Référent métier", "Référent technique",
  "Utilisateur final", "DSI / IT", "Achats", "Direction", "Fournisseur / externe",
  "Contrôle de gestion", "Contributeur"];
function roleDatalist(){
  return `<datalist id="personRoles">${PERSON_ROLES.map(r => `<option value="${esc(r)}">`).join("")}</datalist>`;
}
function contactById(id){ return id ? STORE.contacts.find(c => c.id === id) || null : null; }
// Annuaire trié : "moi" en tête, puis alpha.
function knownPeople(){
  return STORE.contacts.slice().sort((a, b) =>
    (b.moi ? 1 : 0) - (a.moi ? 1 : 0) || (a.nom || "").localeCompare(b.nom || ""))
    .map(c => ({id: c.id, nom: c.nom, role: c.role || "", moi: !!c.moi}));
}
function showAddLiv(id){
  const opts = knownPeople().map(p => `<option value="${esc(p.id)}">${p.moi ? "🧍 " : ""}${esc(p.nom)}${p.role ? " (" + esc(p.role) + ")" : ""}</option>`).join("");
  let cat = `<div class="tpl-h">Livrable type (clic pour pré-remplir) :</div><div class="tpl-chips tpl-chips-sc">`;
  Object.entries(LIVRABLE_CATALOG).forEach(([g, items]) => {
    cat += `<span class="tpl-grp">${esc(g)}</span>`;
    items.forEach(it => cat += `<button class="tpl-chip" title="${esc(it.impact || "")}" onclick="livFill('${jqs(it.l)}','${jqs(it.impact || "")}')">${esc(it.l)}</button>`);
  });
  cat += `</div>`;
  $("addLiv_" + id).innerHTML =
    `<div class="miniform">` + cat +
    `<div class="row"><select id="lvperson" onchange="lvPersonChange()"><option value="">— choisir dans l'annuaire —</option>${opts}<option value="__new__">+ nouvelle personne…</option></select></div>` +
    `<div class="row" id="lvname" style="display:none"><input id="lvp" placeholder="Nom"><input id="lvr" placeholder="Rôle / service" list="personRoles"></div>` + roleDatalist() +
    `<input id="lvq" placeholder="Ce que tu attends (le livrable)">` +
    `<div class="row"><input id="lvd" type="date"><select id="lvs">` +
      Object.keys(LIV).map(s => `<option value="${s}">${LIV[s]}</option>`).join("") + `</select></div>` +
    `<input id="lvi" placeholder="Impact si en retard (optionnel)">` +
    `<div class="actions"><button class="btn sm" onclick="hide('addLiv_${id}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addLiv('${id}')">Ajouter</button></div></div>`;
}
function livFill(quoi, impact){ $("lvq").value = quoi; if(impact && !$("lvi").value.trim()) $("lvi").value = impact; }
function lvPersonChange(){
  const nw = $("lvperson").value === "__new__";
  $("lvname").style.display = nw ? "flex" : "none";
  if(nw) $("lvp").focus();
}
function addLiv(id){
  const sel = $("lvperson").value;
  const op = {op: "add_livrable", chantier_id: id, quoi: $("lvq").value.trim(),
              date: $("lvd").value || null, statut: $("lvs").value, impact: $("lvi").value.trim()};
  if(sel === "__new__"){ op.personne = $("lvp").value.trim(); op.role = $("lvr").value.trim(); }
  else if(sel){ op.contact_id = sel; }
  if(!op.quoi){ alert("Indique ce que tu attends."); return; }
  if(!op.contact_id && !op.personne){ alert("Choisis une personne (ou « nouvelle personne »)."); return; }
  mutate(op);
}
function assignPerson(cid, lid, sel){   // liste déroulante d'un livrable (valeur = contact_id)
  const v = sel.value;
  if(v === "__new__"){
    // CRÉE une fiche dans l'annuaire ET l'affecte directement à ce livrable
    const nom = prompt("Nouvelle personne :");
    if(nom && nom.trim()){
      const role = (prompt("Rôle (optionnel) :") || "").trim();
      mutate({op: "update_livrable", chantier_id: cid, livrable_id: lid, personne: nom.trim(), role});
    } else { renderPage(); }   // annulé → on redessine pour réafficher la personne actuelle
    return;
  }
  if(v) mutate({op: "update_livrable", chantier_id: cid, livrable_id: lid, contact_id: v});  // fiche existante
}
function hide(id){ if($(id)) $(id).innerHTML = ""; }

function newChantier(){
  let h = `<div class="modal-bg" onclick="closeModal(event)"><div class="modal" onclick="event.stopPropagation()">`;
  h += `<h3>Nouveau chantier</h3>`;
  h += `<input id="ncTitre" class="modal-inp" placeholder="Titre du chantier">`;
  h += `<div class="tpl-h">Partir d'un modèle standard (optionnel) :</div><div class="tpl-list">`;
  h += `<button class="tpl-item sel" onclick="ncPick(this,'')"><b>Vierge</b><span class="muted small">aucun pré-remplissage</span></button>`;
  Object.keys(CHANTIER_TEMPLATES).forEach(name => {
    const t = CHANTIER_TEMPLATES[name];
    h += `<button class="tpl-item" onclick="ncPick(this,'${jqs(name)}')"><b>${esc(name)}</b>` +
      `<span class="muted small">${t.taches.length} tâches · ${t.livrables.length} livrables · ${t.parties.length} parties · ${t.risques.length} risques</span></button>`;
  });
  h += `</div><div class="actions"><button class="btn sm" onclick="closeModal()">Annuler</button>` +
    `<button class="btn sm primary" onclick="createNc()">Créer</button></div></div></div>`;
  const d = document.createElement("div"); d.id = "ncModal"; d.innerHTML = h;
  document.body.appendChild(d);
  window._ncTpl = ""; $("ncTitre").focus();
  $("ncTitre").addEventListener("keydown", e => { if(e.key === "Enter") createNc(); });
}
function ncPick(btn, name){
  window._ncTpl = name;
  document.querySelectorAll("#ncModal .tpl-item").forEach(x => x.classList.remove("sel"));
  btn.classList.add("sel");
}
function closeModal(e){ if(e && e.target !== e.currentTarget) return; const m = $("ncModal"); if(m) m.remove(); }
function createNc(){
  const titre = $("ncTitre").value.trim(); if(!titre){ $("ncTitre").focus(); return; }
  const tpl = window._ncTpl;
  if(!tpl){ mutate({op: "create_chantier", titre, statut: "todo", prio: "m"}); }
  else { const t = CHANTIER_TEMPLATES[tpl];
    mutate({op: "apply_template", create: {titre, prio: "m", statut: "todo"},
            taches: t.taches, livrables: t.livrables, parties: t.parties, risques: t.risques}); }
  closeModal();
}

// ======================================================================== //
//  Risques (registre par chantier + vue globale avec matrice de criticité)
// ======================================================================== //
let RK_EDIT = new Set();   // ids de risques en mode édition (sinon lecture seule)
function rkEdit(id){ RK_EDIT.add(id); renderPage(); }
function rkDone(id){ RK_EDIT.delete(id); renderPage(); }

// --- Registre global : tri de colonnes + filtres (aucune donnée nouvelle, agit sur allRisques()) ---
let RK_SORT = {key: "crit", dir: -1};                                                 // colonne de tri + sens
let RK_FILT = {statut: "", categorie: "", chantier: "", responsable: "", cell: ""};    // filtres actifs
const rkCanon = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();   // clé catégorie repliée (accents/casse)
const RK_CATS_CANON = RISK_CATS.map(rkCanon);
const rkInCatalog = s => RK_CATS_CANON.includes(rkCanon(s));                            // catégorie connue du catalogue ?
const rkAnyFilt = () => RK_FILT.statut || RK_FILT.categorie || RK_FILT.chantier || RK_FILT.responsable || RK_FILT.cell;
function rkPass(r){   // le risque passe-t-il les filtres courants ?
  const f = RK_FILT;
  if(f.statut && r.statut !== f.statut) return false;
  if(f.categorie && rkCanon(r.categorie) !== f.categorie) return false;
  if(f.chantier && r._c.id !== f.chantier) return false;
  if(f.responsable && (r.responsable || "") !== f.responsable) return false;
  if(f.cell && (r.probabilite + "_" + r.gravite) !== f.cell) return false;
  return true;
}
function rkSortBy(key){ if(RK_SORT.key === key) RK_SORT.dir *= -1; else RK_SORT = {key, dir: key === "crit" ? -1 : 1}; renderRisques(); }
function rkFilt(k, v){ RK_FILT[k] = (RK_FILT[k] === v ? "" : v); renderRisques(); }   // toggle (matrice / barres / chip)
function rkSetFilt(k, v){ RK_FILT[k] = v; renderRisques(); }                          // valeur directe (selects)
function rkClearFilt(){ RK_FILT = {statut: "", categorie: "", chantier: "", responsable: "", cell: ""}; renderRisques(); }
function rkSortVal(r, key){
  switch(key){
    case "chantier": return (r._c.titre || "").toLowerCase();
    case "categorie": return rkCanon(r.categorie);
    case "responsable": return (r.responsable || "").toLowerCase();
    case "revue": return r.echeance_revue || "9999-99-99";
    case "statut": return Object.keys(RISK).indexOf(r.statut);
    default: return crit(r);
  }
}
function rkTh(key, label){   // en-tête de colonne cliquable (tri)
  const on = RK_SORT.key === key, ar = on ? (RK_SORT.dir > 0 ? " ▲" : " ▼") : "";
  return `<th class="rk-th${on ? " on" : ""}" onclick="rkSortBy('${key}')">${label}${ar}</th>`;
}

function risquesBlock(c){
  const rs = risquesOf(c).slice().sort((a, b) => (riskActive(b) - riskActive(a)) || (crit(b) - crit(a)));
  let h = "";
  if(!rs.length) h += `<div class="empty">Aucun risque identifié.</div>`;
  rs.forEach(r => {
    const n = crit(r), lv = critLevel(n), off = !riskActive(r);
    const late = riskActive(r) && isLate(r.echeance_revue);
    const u = extra => `mutate({op:'update_risque',chantier_id:'${c.id}',risque_id:'${r.id}',${extra}})`;
    const delx = `<span class="del" title="Supprimer" onclick="if(confirm('Supprimer ce risque ?'))mutate({op:'remove_risque',chantier_id:'${c.id}',risque_id:'${r.id}'})">×</span>`;
    h += `<div class="rk ${off ? "rk-off" : ""}">`;
    if(!RK_EDIT.has(r.id)){
      // ----- LECTURE SEULE (par défaut) : un risque ajouté ne s'édite pas par accident -----
      h += `<div class="rk-top"><span class="rk-crit" style="color:${lv.col};background:${lv.bg}" title="Proba ${r.probabilite} × Gravité ${r.gravite}">${n} · ${lv.lbl}</span>` +
        `<span class="rk-lib-ro">${esc(r.libelle)}</span>` +
        `<a class="lnk rk-edit" onclick="rkEdit('${r.id}')">Modifier</a>` + delx + `</div>`;
      // statut modifiable inline via un menu STYLÉ (pas de <select> natif → popup hors-style)
      const stMenu = `<div class="menu rk-stm" id="rkstm_${r.id}">` +
        `<button class="rk-st-pill rk-st-${r.statut}" title="Changer le statut" onclick="fixedMenu(event,'rkstm_${r.id}')">${RISK[r.statut] || r.statut}<span class="rk-st-car">▾</span></button>` +
        `<div class="menu-list rk-stm-list">` +
          Object.keys(RISK).map(s => `<a class="rk-stm-opt ${s === r.statut ? "on" : ""}" onclick="mutate({op:'update_risque',chantier_id:'${c.id}',risque_id:'${r.id}',statut:'${s}'})"><span class="rk-dot rk-st-${s}"></span>${RISK[s]}</a>`).join("") +
        `</div></div>`;
      h += `<div class="rk-ro-meta">` + stMenu +
        `<span class="rk-chip">${esc(r.categorie || "—")}</span>` +
        `<span class="rk-chip" title="Probabilité">Proba <b>${r.probabilite}</b>/5 · ${PROBA_LBL[r.probabilite] || ""}</span>` +
        `<span class="rk-chip" title="Gravité (impact)">Gravité <b>${r.gravite}</b>/5 · ${GRAV_LBL[r.gravite] || ""}</span>` +
        (r.responsable ? `<span class="rk-chip">👤 ${esc(r.responsable)}</span>` : "") +
        (r.echeance_revue ? `<span class="rk-chip ${late ? "rk-chip-late" : ""}">📅 revue ${fmt(r.echeance_revue)}${late ? " — en retard" : ""}</span>` : "") +
        `</div>`;
      if(r.parade) h += `<div class="rk-ro-parade"><span class="fl">Parade</span> ${esc(r.parade)}</div>`;
    } else {
      // ----- ÉDITION (après clic sur « Modifier ») -----
      const rcats = RISK_CATS.includes(r.categorie) ? RISK_CATS : [r.categorie || "Autre", ...RISK_CATS];
      h += `<div class="rk-top"><span class="rk-crit" style="color:${lv.col};background:${lv.bg}">${n} · ${lv.lbl}</span>` +
        `<input class="rk-lib" value="${esc(r.libelle)}" placeholder="Risque" onchange="${u("libelle:this.value")}">` +
        `<a class="lnk rk-edit" onclick="rkDone('${r.id}')">Terminé</a>` + delx + `</div>`;
      h += `<div class="rk-meta">` +
        `<span class="fld"><span class="fl">Probabilité</span><select onchange="${u("probabilite:this.value")}">${proba5(r.probabilite)}</select></span>` +
        `<span class="fld"><span class="fl">Gravité</span><select onchange="${u("gravite:this.value")}">${grav5(r.gravite)}</select></span>` +
        `<span class="fld"><span class="fl">Catégorie</span><select onchange="${u("categorie:this.value")}">` +
          rcats.map(x => `<option ${r.categorie === x ? "selected" : ""}>${esc(x)}</option>`).join("") + `</select></span>` +
        `<span class="fld"><span class="fl">Statut</span><select onchange="${u("statut:this.value")}">` +
          Object.keys(RISK).map(s => `<option value="${s}" ${r.statut === s ? "selected" : ""}>${RISK[s]}</option>`).join("") + `</select></span>` +
        `<span class="fld"><span class="fl">Revue</span><input type="date" class="liv-d" value="${r.echeance_revue || ""}" onchange="${u("echeance_revue:this.value")}"></span>` +
        (late ? `<span class="lt-badge">REVUE EN RETARD</span>` : "") + `</div>`;
      const psel = `<select class="liv-psel" onchange="${u("responsable:this.value")}"><option value="">— responsable —</option>` +
        knownPeople().map(p => `<option value="${esc(p.nom)}" ${p.nom === (r.responsable || "") ? "selected" : ""}>${esc(p.nom)}</option>`).join("") + `</select>`;
      h += `<div class="rk-meta"><span class="fld"><span class="fl">Responsable</span>${psel}</span></div>`;
      h += `<input class="rk-parade" value="${esc(r.parade)}" placeholder="Parade / mitigation" onchange="${u("parade:this.value")}">`;
    }
    h += `</div>`;
  });
  h += `<div id="addRisque_${c.id}"></div>`;
  return h;
}

function riskMatrix(risks){
  const cell = 54, padL = 70, padT = 14, padB = 24, padR = 10;
  const W = padL + 5 * cell + padR, H = padT + 5 * cell + padB;
  const at = {}; risks.forEach(r => { const k = r.probabilite + "_" + r.gravite; (at[k] = at[k] || []).push(r); });
  let g = `<div class="scrollx"><svg width="${W}" height="${H}">`;
  for(let gr = 5; gr >= 1; gr--){
    for(let p = 1; p <= 5; p++){
      const n = p * gr, lv = critLevel(n), items = at[p + "_" + gr] || [];
      const x = padL + (p - 1) * cell, y = padT + (5 - gr) * cell;
      const tip = `${items.length} risque(s) — proba ${p} × gravité ${gr} = ${n} (${lv.lbl})` +
        (items.length ? "\n• " + items.map(r => r.libelle).join("\n• ") : "");
      const rksel = RK_FILT.cell === (p + "_" + gr);
      const cclk = items.length ? ` onclick="event.stopPropagation();rkFilt('cell','${p}_${gr}')" style="cursor:pointer"` : "";   // cellule cliquable → filtre proba×gravité
      g += `<rect x="${x}" y="${y}" width="${cell - 3}" height="${cell - 3}" rx="3" fill="${lv.bg}"${cclk} ` +
        `stroke="${rksel ? "var(--ink)" : items.length ? lv.col : "var(--line)"}" stroke-width="${rksel ? 3 : items.length ? 2 : 1}"><title>${esc(tip)}</title></rect>`;
      g += items.length
        ? `<text x="${x + (cell - 3) / 2}" y="${y + (cell - 3) / 2 + 6}" text-anchor="middle" font-size="17" font-weight="700" fill="${lv.col}">${items.length}</text>`
        : `<text x="${x + (cell - 3) / 2}" y="${y + (cell - 3) / 2 + 4}" text-anchor="middle" font-size="9" fill="var(--faint)">${n}</text>`;
    }
  }
  for(let p = 1; p <= 5; p++) g += `<text x="${padL + (p - 1) * cell + (cell - 3) / 2}" y="${padT + 5 * cell + 14}" text-anchor="middle" font-size="10" fill="var(--muted)">${p}</text>`;
  for(let gr = 5; gr >= 1; gr--) g += `<text x="${padL - 8}" y="${padT + (5 - gr) * cell + (cell - 3) / 2 + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${gr}</text>`;
  g += `<text x="${padL + 5 * cell / 2}" y="${H - 3}" text-anchor="middle" font-size="9.5" fill="var(--faint)">Probabilité →</text>`;
  const my = padT + 5 * cell / 2;
  g += `<text x="13" y="${my}" text-anchor="middle" font-size="9.5" fill="var(--faint)" transform="rotate(-90 13 ${my})">Gravité →</text>`;
  g += `</svg></div><div class="legend">` +
    `<span><i class="sq" style="background:#dcfce7;border-color:#16a34a"></i>faible</span>` +
    `<span><i class="sq" style="background:#fef9c3;border-color:#ca8a04"></i>moyen</span>` +
    `<span><i class="sq" style="background:#ffedd5;border-color:#ea580c"></i>élevé</span>` +
    `<span><i class="sq" style="background:#fee2e2;border-color:#dc2626"></i>critique</span></div>`;
  return g;
}

function catRows(risks){
  // agrège par clé canonique (accents/casse repliés) et marque « hors catalogue » (⚠) si absente de RISK_CATS
  const m = {};
  risks.forEach(r => {
    const k = rkCanon(r.categorie) || "(sans)";
    if(!m[k]) m[k] = {canon: k, label: r.categorie || "—", value: 0, off: !rkInCatalog(r.categorie)};
    m[k].value++;
  });
  return Object.values(m).sort((a, b) => b.value - a.value).map(o => ({
    label: (o.off ? "⚠ " : "") + o.label, value: o.value,
    color: o.off ? "#ea580c" : "var(--blue)",
    onclick: `rkFilt('categorie','${jqs(o.canon)}')`, active: RK_FILT.categorie === o.canon}));
}

function renderRisques(){
  const all = allRisques();
  const active = all.filter(riskActive);
  const critN = active.filter(r => crit(r) >= 15).length;
  const avere = active.filter(r => r.statut === "avere").length;
  const noResp = active.filter(r => !r.responsable).length;
  const noRev = active.filter(r => !r.echeance_revue).length;
  let h = `<div class="ch-h">Cartographie des risques — ${active.length} actif(s) sur ${all.length}</div>`;
  h += `<div class="kpis">` +
    kpi("Risques actifs", String(active.length), "ouverts + avérés") +
    kpi("Critiques", String(critN), "criticité ≥ 15", critN ? "bad" : "good") +
    kpi("Avérés", String(avere), "déjà survenus", avere ? "bad" : "") +
    kpi("Sans pilote", String(noResp), "responsable manquant", noResp ? "bad" : "good") +
    kpi("Sans date de revue", String(noRev), "revue non planifiée", noRev ? "bad" : "good") +
    kpi("Neutralisés", String(all.length - active.length), "maîtrisés / clos") + `</div>`;
  h += `<div class="dash-row">` +
    chartBox("Matrice de criticité (proba × gravité) — risques actifs", active.length ? riskMatrix(active) : `<div class="empty">Aucun risque actif.</div>`) +
    chartBox("Risques actifs par catégorie", active.length ? hbar(catRows(active), {labelW: 150, barW: 170}) : `<div class="empty">—</div>`) + `</div>`;
  if(!all.length){ $("risques").innerHTML = h + `<div class="empty">Aucun risque. Ouvre un chantier et utilise « + risque » pour en ajouter.</div>`; return; }
  // barre de filtres (statut / catégorie / chantier / responsable) sur allRisques()
  const cats = {}; all.forEach(r => { const k = rkCanon(r.categorie); if(k && !cats[k]) cats[k] = r.categorie; });
  const chs = {}; all.forEach(r => chs[r._c.id] = r._c.titre);
  const resp = [...new Set(all.map(r => r.responsable).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const fsel = (k, cur, opts) => `<select class="rk-fsel" onchange="rkSetFilt('${k}',this.value)">${opts.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  h += `<div class="rk-filters">` +
    fsel("statut", RK_FILT.statut, [["", "Tous statuts"], ...Object.entries(RISK)]) +
    fsel("categorie", RK_FILT.categorie, [["", "Toutes catégories"], ...Object.entries(cats)]) +
    fsel("chantier", RK_FILT.chantier, [["", "Tous chantiers"], ...Object.entries(chs)]) +
    fsel("responsable", RK_FILT.responsable, [["", "Tous responsables"], ...resp.map(x => [x, x])]) +
    (RK_FILT.cell ? `<span class="rk-fchip">proba×gravité ${RK_FILT.cell.replace("_", "×")} <a onclick="rkFilt('cell','${RK_FILT.cell}')">×</a></span>` : "") +
    (rkAnyFilt() ? `<a class="lnk" onclick="rkClearFilt()">Réinitialiser</a>` : "") + `</div>`;
  const rows = all.filter(rkPass).sort((a, b) => {
    const va = rkSortVal(a, RK_SORT.key), vb = rkSortVal(b, RK_SORT.key);
    return (va < vb ? -1 : va > vb ? 1 : 0) * RK_SORT.dir;
  });
  h += `<div class="ch-h">Registre — ${rows.length} risque(s)${rkAnyFilt() ? " (filtré)" : ""}</div>`;
  h += `<table class="ptable rk-table"><thead><tr>` +
    rkTh("crit", "Criticité") + `<th>Risque</th>` + rkTh("chantier", "Chantier") + rkTh("categorie", "Catégorie") +
    rkTh("responsable", "Responsable") + rkTh("revue", "Revue") + rkTh("statut", "Statut") + `</tr></thead><tbody>`;
  if(!rows.length) h += `<tr><td colspan="7" class="empty">Aucun risque ne correspond aux filtres.</td></tr>`;
  const people = knownPeople();
  rows.forEach(r => {
    const n = crit(r), lv = critLevel(n), late = riskActive(r) && isLate(r.echeance_revue);
    const incomplet = riskActive(r) && (!r.responsable || !r.echeance_revue);
    const off = !rkInCatalog(r.categorie);
    const u = extra => `mutate({op:'update_risque',chantier_id:'${r._c.id}',risque_id:'${r.id}',${extra}})`;
    const psel = `<select class="rk-cell-sel" onclick="event.stopPropagation()" onchange="event.stopPropagation();${u("responsable:this.value")}"><option value="">— pilote —</option>` +
      people.map(p => `<option value="${esc(p.nom)}" ${p.nom === (r.responsable || "") ? "selected" : ""}>${esc(p.nom)}</option>`).join("") + `</select>`;
    const dinp = `<input type="date" class="rk-cell-d" value="${r.echeance_revue || ""}" onclick="event.stopPropagation()" onchange="event.stopPropagation();${u("echeance_revue:this.value")}">`;
    h += `<tr class="${riskActive(r) ? "" : "rk-off"}" onclick="openChantier('${r._c.id}')">` +
      `<td><span class="rk-crit" style="color:${lv.col};background:${lv.bg}">${n} · ${lv.lbl}</span></td>` +
      `<td>${incomplet ? `<span class="rk-warn" title="Responsable ou date de revue manquant">⚠</span> ` : ""}<b>${esc(r.libelle)}</b>${r.parade ? `<div class="muted small">parade : ${esc(r.parade)}</div>` : ""}</td>` +
      `<td>${esc(r._c.titre)}</td>` +
      `<td>${esc(r.categorie || "—")}${off ? ` <span class="rk-warn" title="Hors catalogue">⚠</span>` : ""}</td>` +
      `<td class="rk-cell">${psel}</td>` +
      `<td class="rk-cell ${late ? "bad-t" : ""}">${dinp}</td>` +
      `<td>${RISK[r.statut]}</td></tr>`;
  });
  h += `</tbody></table>`;
  $("risques").innerHTML = h;
}

// Création de risque en 2 panneaux. Gauche : catégorie (en haut) → risques de cette
// catégorie (en dessous, sans niveau, pas de scroll). Droite : détail + niveau + ajout.
function riskBrowseHtml(cid, ci){
  const cats = Object.keys(RISK_CATALOG);
  let h = `<div class="rk-cats">`;
  cats.forEach((cat, i) => { h += `<button class="rk-cat ${i === ci ? "sel" : ""}" onclick="riskCat('${cid}',${i})">${esc(cat)}</button>`; });
  h += `</div><div class="rk-cat-risks">`;
  RISK_CATALOG[cats[ci]].forEach((it, ii) => {
    h += `<button class="rk-opt" id="rkopt_${cid}_${ci}_${ii}" onclick="riskFill('${cid}',${ci},${ii})"><span class="rk-opt-l">${esc(it.l)}</span></button>`;
  });
  h += `</div>`;
  return h;
}
function riskCat(cid, ci){ const el = $("rkbrowse_" + cid); if(el) el.innerHTML = riskBrowseHtml(cid, ci); }
function showAddRisque(cid){
  let h = `<div class="miniform rk-pick">`;
  h += `<div class="rk-step">1 · Choisis la catégorie, puis le risque — il se détaille à droite.</div>`;
  h += `<div class="rk-2pane"><div class="rk-browse" id="rkbrowse_${cid}">${riskBrowseHtml(cid, 0)}</div>`;
  // formulaire (panneau droit) : détail + niveau + un seul bouton de soumission
  const lv0 = critLevel(9);
  h += `<div class="rk-form"><div class="rk-step">2 · Le risque à ajouter :</div>`;
  h += `<input id="rkl" placeholder="Libellé du risque (ou choisis-en un ci-dessus)">`;
  h += `<div class="row">` +
    `<span class="fld"><span class="fl">Probabilité</span><select id="rkp" onchange="riskCritPreview('${cid}')">${proba5(3)}</select></span>` +
    `<span class="fld"><span class="fl">Gravité (impact)</span><select id="rkg" onchange="riskCritPreview('${cid}')">${grav5(3)}</select></span>` +
    `<span class="rk-crit-live" id="rkcrit_${cid}" style="color:${lv0.col};background:${lv0.bg}">9 · ${lv0.lbl}</span></div>`;
  h += `<div class="row">` +
    `<span class="fld"><span class="fl">Catégorie</span><select id="rkc">${RISK_CATS.map(x => `<option ${x === "Autre" ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></span>` +
    `<span class="fld"><span class="fl">Revue</span><input id="rke" type="date"></span>` +
    `<span class="fld"><span class="fl">Responsable</span><select id="rkr"><option value="">—</option>` +
      knownPeople().map(p => `<option value="${esc(p.nom)}">${esc(p.nom)}</option>`).join("") + `</select></span></div>`;
  h += `<textarea id="rkpa" rows="2" placeholder="Parade / mitigation"></textarea></div>`;   // rk-form
  h += `</div>`;   // rk-2pane
  h += `<div class="actions"><button class="btn sm" onclick="hide('addRisque_${cid}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addRisque('${cid}')">Ajouter le risque</button></div></div>`;
  $("addRisque_" + cid).innerHTML = h;
}
// remplit un select + notifie (change) pour rafraîchir le bouton stylé
function setSel(id, v){ const s = $(id); if(!s) return; s.value = String(v); s.dispatchEvent(new Event("change", {bubbles: true})); }
// clic sur un risque du catalogue : remplit le formulaire (pas de changement d'écran)
function riskFill(cid, ci, ii){
  const cat = Object.keys(RISK_CATALOG)[ci], it = RISK_CATALOG[cat][ii];
  $("rkl").value = it.l;
  $("rkpa").value = it.m || "";
  setSel("rkp", it.p); setSel("rkg", it.g); setSel("rkc", cat);
  riskCritPreview(cid);
  document.querySelectorAll(".rk-opt.sel").forEach(e => e.classList.remove("sel"));
  const el = $("rkopt_" + cid + "_" + ci + "_" + ii); if(el) el.classList.add("sel");
}
function riskCritPreview(cid){
  const n = (+$("rkp").value) * (+$("rkg").value), lv = critLevel(n), el = $("rkcrit_" + cid);
  if(el){ el.textContent = n + " · " + lv.lbl; el.style.color = lv.col; el.style.background = lv.bg; }
}
function addRisque(cid){
  const lib = $("rkl").value.trim(); if(!lib){ alert("Décris le risque."); $("rkl").focus(); return; }
  mutate({op: "add_risque", chantier_id: cid, libelle: lib, probabilite: $("rkp").value, gravite: $("rkg").value,
          categorie: $("rkc").value, responsable: $("rkr").value, parade: $("rkpa").value.trim(),
          echeance_revue: $("rke").value || null});
}

// ======================================================================== //
//  Suivi du temps (chrono) — sessions horodatées + récap "Ma journée"
// ======================================================================== //
let DAY_OPEN = false;   // état déplié/replié de la section "Ma journée" (mémorisé entre rendus)
const TIMELOG = () => STORE.timelog || [];
const activeSession = () => TIMELOG().find(s => !s.fin) || null;
const sessionsOn = d => TIMELOG().filter(s => s.date === d).slice().sort((a, b) => a.debut < b.debut ? -1 : a.debut > b.debut ? 1 : 0);
function nowHM(){ const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function todayISO(){ const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }   // vraie date locale (≠ TODAY en cache)
const hmToMin = h => { const p = (h || "0:0").split(":"); return (+p[0]) * 60 + (+p[1] || 0); };
const isFriday = d => !!d && dparse(d).getUTCDay() === 5;
function dayEnd(d){ return isFriday(d) ? (SETTINGS.vendredi_fin || "13:30") : (SETTINGS.jour_fin || "17:51"); }
function lunchOverlap(debut, fin, d){   // minutes de pause déjeuner à exclure (aucune le vendredi)
  if(isFriday(d)) return 0;
  const pd = SETTINGS.pause_debut, pf = SETTINGS.pause_fin;
  if(!pd || !pf || pf <= pd) return 0;
  let s = hmToMin(debut), e = hmToMin(fin); if(e < s) e += 1440;
  const lo = Math.max(s, hmToMin(pd)), hi = Math.min(e, hmToMin(pf));
  return Math.max(0, hi - lo);
}
function sessMin(s){
  let e = s.fin || nowHM();
  if(!s.fin && s.date && s.date < todayISO()){
    // Chrono oublié un jour passé : borné à la fin de journée de SA date, mais
    // jamais avant son début. Un chrono en cours AUJOURD'HUI court jusqu'à
    // maintenant, sans plafond : la fin de journée réglée ne tronque pas du
    // travail réel (18:24 → 18:30 fait 6 min, pas 23 h 27).
    const de = dayEnd(s.date);
    e = de > s.debut ? de : s.debut;
  }
  let m = hmToMin(e) - hmToMin(s.debut); if(m < 0) m += 1440;                  // +1440 : à cheval sur minuit (plage manuelle)
  return Math.max(0, m - lunchOverlap(s.debut, e, s.date));                    // déduit la pause déjeuner (pas le vendredi)
}
function fmtDur(min){ min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return h ? `${h} h${m ? " " + String(m).padStart(2, "0") : ""}` : `${m} min`; }
const activeForTache  = tid => { const a = activeSession(); return a && a.tache_id  === tid ? a : null; };
const tacheMin = tid => TIMELOG().filter(s => s.tache_id === tid).reduce((a, s) => a + sessMin(s), 0);
const chantierMin = cid => TIMELOG().filter(s => s.chantier_id === cid).reduce((a, s) => a + sessMin(s), 0);
const recetteMin = cid => TIMELOG().filter(s => s.kind === "recette" && (!cid || s.chantier_id === cid)).reduce((a, s) => a + sessMin(s), 0);

// Reprise du chrono : relancer le dernier travail chronométré (ou une plage précise) sans
// re-saisir chantier + tâche. clock_start ferme d'abord tout chrono actif (un seul à la fois),
// et son filtre de refs ignore les champs nuls — on peut donc tout passer tel quel.
function lastEndedSession(){
  const done = TIMELOG().filter(s => s.fin);
  if(!done.length) return null;
  return done.slice().sort((a, b) => (a.date + a.fin) < (b.date + b.fin) ? -1 : 1).pop();   // fin la plus récente
}
function resumeSessOp(s){
  return {op: "clock_start", kind: s.kind, label: s.label,
          chantier_id: s.chantier_id, tache_id: s.tache_id,
          action_id: s.action_id, iteration_id: s.iteration_id,
          theme_id: s.theme_id};
}
function resumeLast(){ const s = lastEndedSession(); if(s) mutate(resumeSessOp(s)); }
function resumeSess(id){ const s = TIMELOG().find(x => x.id === id); if(s) mutate(resumeSessOp(s)); }

// ===== EVM (valeur acquise / Earned Value Management) =====================
// PV & EV = budget (BAC) pondéré par la durée planifiée des tâches.
//   PV = part planifiée qui DEVRAIT être faite à aujourd'hui (lissée sur la fenêtre planifiée).
//   EV = avancement RÉEL valorisé (fait = 100 %, en cours = sous-tâches ou 50 % [règle 50/50]).
//   AC = coût réel main-d'œuvre = jours-personnes chronométrés × taux journalier.
function evm(c, S){
  S = S || computeSchedule(c);
  const BAC = (c.budget != null && c.budget !== "") ? +c.budget : null;
  const tasks = c.taches.filter(t => !t.is_milestone);          // un jalon (durée 0) ne porte pas de valeur
  const Wtot = tasks.reduce((a, t) => a + Math.max(1, t.duree || 1), 0) || 1;
  let pvFrac = 0, evFrac = 0;
  tasks.forEach(t => {
    const w = Math.max(1, t.duree || 1) / Wtot, sc = S.sched[t.id];
    if(sc){
      let frac = 0;
      if(TODAY >= sc.endDate) frac = 1;
      else if(TODAY > sc.startDate){ const tot = Math.max(1, daysBetween(sc.startDate, sc.endDate)); frac = Math.min(1, daysBetween(sc.startDate, TODAY) / tot); }
      pvFrac += w * frac;
    }
    let prog = 0;
    if(t.done) prog = 1;
    else if(t.start_date){ const subs = t.subtasks || []; prog = subs.length ? subs.filter(x => x.done).length / subs.length : 0.5; }
    evFrac += w * prog;
  });
  const PV = BAC != null ? BAC * pvFrac : null;
  const EV = BAC != null ? BAC * evFrac : null;
  const hj = +SETTINGS.heures_jour || 7, taux = +SETTINGS.taux_jour || 0;
  const pjours = chantierMin(c.id) / (hj * 60);                 // jours-personnes chronométrés sur le chantier
  const AC = taux ? pjours * taux : null;
  const SPI = (PV && EV != null) ? EV / PV : null;              // indice de performance délai
  const CPI = (AC && EV != null) ? EV / AC : null;             // indice de performance coût
  const SV = (PV != null && EV != null) ? EV - PV : null;       // écart délai (€)
  const CV = (AC != null && EV != null) ? EV - AC : null;       // écart coût (€)
  const EAC = (BAC != null && CPI) ? BAC / CPI : null;          // coût final estimé
  const ETC = (EAC != null && AC != null) ? EAC - AC : null;    // reste à dépenser
  const VAC = (BAC != null && EAC != null) ? BAC - EAC : null;  // écart à l'achèvement
  return {BAC, PV, EV, AC, SPI, CPI, SV, CV, EAC, ETC, VAC, pvFrac, evFrac, pjours, taux};
}
const fmtEur = v => v == null ? "—" : Math.round(v).toLocaleString("fr-FR") + " €";
// Taux horaire = taux journalier / heures facturables. Repli sur 15 €/h tant que
// le taux journalier n'est pas configuré, pour que la valorisation reste lisible.
const TAUX_H_DEFAUT = 15;
function tauxHeure(){
  const t = +SETTINGS.taux_jour || 0, hj = +SETTINGS.heures_jour || 7;
  return t ? t / hj : TAUX_H_DEFAUT;
}
const eurMin = m => m / 60 * tauxHeure();   // minutes chronométrées -> €

// Mode d'affichage de la vue Activité : "temps" (heures en avant — lecture équipe)
// ou "argent" (valorisation en avant — lecture pilotage/manager). Persisté entre
// sessions ; la page étant reconstruite à chaque rendu, un booléen mémoire ne suffit pas.
function actMode(){
  try { return localStorage.getItem("act_mode") === "argent" ? "argent" : "temps"; }
  catch(e){ return "temps"; }
}
function setActMode(m){
  try { localStorage.setItem("act_mode", m); } catch(e){}
  renderActivite();
}
function actToggle(){   // interrupteur segmenté Temps / Argent
  const m = actMode();
  return `<div class="disptog" role="group" aria-label="Afficher le temps ou sa valeur en argent">` +
    `<button type="button" class="${m === "temps" ? "on" : ""}" onclick="setActMode('temps')" title="Vue équipe : les heures en avant">⏱ Temps</button>` +
    `<button type="button" class="${m === "argent" ? "on" : ""}" onclick="setActMode('argent')" title="Vue pilotage : la valorisation € en avant">€ Argent</button>` +
    `</div>`;
}
const fmtIdx = v => v == null ? "—" : v.toFixed(2);
const fmtPctw = v => v == null ? "—" : Math.round(v * 100) + " %";
const idxCls = v => v == null ? "" : v >= 1 ? "good" : v >= 0.9 ? "warn" : "bad";   // ≥1 bon · ≥.9 vigilance · <.9 mauvais
const KIND_ICON = {tache: "🗂", action: "🔁", recette: "🧪", libre: "•"};

function tlSyncTaches(){   // peuple la liste des tâches selon le chantier choisi (jalons exclus : pas de temps)
  const sel = $("tl_tache"); if(!sel) return;
  const c = $("tl_chantier").value ? chById($("tl_chantier").value) : null;
  const taches = c ? c.taches.filter(t => !t.is_milestone) : [];
  if(!taches.length){ sel.style.display = "none"; sel.innerHTML = ""; return; }
  sel.style.display = "";
  sel.innerHTML = `<option value="">— le chantier seul —</option>` +
    taches.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
}
function addManualSession(){
  const debut = $("tl_debut").value, fin = $("tl_fin").value;
  const cid = $("tl_chantier") ? $("tl_chantier").value : "";
  const tid = (cid && $("tl_tache")) ? $("tl_tache").value : "";
  let label = $("tl_label").value.trim();
  if(!label && tid){ const t = chById(cid).taches.find(x => x.id === tid); if(t) label = t.label; }   // tâche choisie sans libellé : reprend son nom
  if(!label){ $("tl_label").focus(); return; }
  if(!debut || !fin){ alert("Indique l'heure de début ET de fin (plage terminée)."); return; }
  const thSel = document.querySelector(".tl_theme_sel");   // themeSelect() pose une classe, pas un id
  const th = thSel ? thSel.value : "";
  mutate({op: "clock_add", label, debut, fin,
          kind: tid ? "tache" : "libre", chantier_id: cid || null, tache_id: tid || null,
          theme_id: th || null});
}

function maJourneeSection(){
  const sess = sessionsOn(TODAY);
  const act = activeSession();
  if(act && act.date !== TODAY && !sess.includes(act)) sess.unshift(act);   // chrono ouvert depuis la veille : reste visible/arrêtable
  const total = sess.reduce((a, s) => a + sessMin(s), 0);
  // section repliable : le total + le "en cours" restent lisibles dans l'en-tête même repliée
  let h = `<details class="day-sect" ${DAY_OPEN ? "open" : ""} ontoggle="DAY_OPEN=this.open">`;
  h += `<summary class="day-sum">Ma journée — ${fmt(TODAY)} · <b>${fmtDur(total)}</b>${act ? ` · <span class="run">⏱ en cours</span>` : ""}</summary>`;
  h += `<div class="day-log">`;
  if(!sess.length){
    h += `<div class="empty">Aucune plage enregistrée aujourd'hui. Démarre une tâche ou une routine, ou ajoute une plage ci-dessous.</div>`;
  } else {
    sess.forEach(s => {
      const running = !s.fin;
      h += `<div class="dl-row${running ? " running" : ""}">` +
        `<span class="dl-ic" title="${s.kind}">${KIND_ICON[s.kind] || "•"}</span>` +
        `<input type="time" class="dl-t" value="${s.debut}" title="Début" onchange="mutate({op:'clock_edit',id:'${s.id}',debut:this.value})">` +
        `<span class="dl-sep">→</span>` +
        (running
          ? `<button class="dl-stopbtn" title="Arrêter" onclick="mutate({op:'clock_stop',id:'${s.id}'})">⏹ en cours</button>`
          : `<input type="time" class="dl-t" value="${s.fin}" title="Fin" onchange="mutate({op:'clock_edit',id:'${s.id}',fin:this.value})">`) +
        `<span class="dl-dur" title="${lunchOverlap(s.debut, s.fin || nowHM(), s.date) ? "Pause déjeuner déduite (" + fmtDur(lunchOverlap(s.debut, s.fin || nowHM(), s.date)) + ")" : ""}">${fmtDur(sessMin(s))}${lunchOverlap(s.debut, s.fin || nowHM(), s.date) ? ` <span class="dl-pause">⏸ déj.</span>` : ""}</span>` +
        `<input class="dl-lib" value="${esc(s.label)}" onblur="if(this.value.trim()&&this.value!=='${jqs(s.label)}')mutate({op:'clock_edit',id:'${s.id}',label:this.value.trim()})">` +
        (s.chantier_id && chById(s.chantier_id)
          ? `<span class="dl-asg" title="Temps compté pour ce chantier${s.tache_id ? " / cette tâche" : ""}">🗂 ${esc(chById(s.chantier_id).titre)}</span>`
          : themeSelect(s.theme_id, `mutate({op:'clock_edit',id:'${s.id}',theme_id:this.value||null})`, "dl-th")) +
        (running ? "" : `<button class="dl-resume" title="Reprendre cette activité (relance le chrono)" onclick="resumeSess('${s.id}')">▶</button>`) +
        `<span class="del" title="Supprimer cette plage" onclick="if(confirm('Supprimer cette plage ?'))mutate({op:'clock_delete',id:'${s.id}'})">×</span>` +
        `</div>`;
    });
  }
  // saisie manuelle d'une plage (chose faite hors de l'appli) — rattachable à un chantier / une tâche
  h += `<div class="dl-add">` +
    `<input id="tl_label" placeholder="Ajouter une plage (ex. Appel fournisseur)" onkeydown="if(event.key==='Enter')addManualSession()">` +
    `<input id="tl_debut" type="time" title="Début">` +
    `<span class="dl-sep">→</span>` +
    `<input id="tl_fin" type="time" title="Fin (requise)">` +
    `<select id="tl_chantier" title="Rattacher à un chantier (son temps y sera compté)" onchange="tlSyncTaches()"><option value="">— sans chantier —</option>` +
      LIVE().map(c => `<option value="${c.id}">${esc(c.titre)}</option>`).join("") + `</select>` +
    `<select id="tl_tache" title="Rattacher à une tâche précise (sinon : chantier seul)" style="display:none"></select>` +
    themeSelect("", "", "tl_theme_sel") +
    `<button class="btn sm primary" onclick="addManualSession()">Ajouter</button>` +
    `</div>`;
  h += `</div></details>`;
  return h;
}

// ======================================================================== //
//  Actions — tâches libres ET routines dans UNE seule liste.
//  Une routine est une action avec une `recurrence` ; une tâche libre en est
//  une sans. Un seul endroit où regarder ce qu'il y a à faire.
//
//  Le point clé : une routine ratée ne disparaît plus. Elle engendre des
//  OCCURRENCES statuées (fait / sauté / raté) — donc un historique honnête et
//  un taux de tenue, au lieu d'une case qui s'évapore le lendemain.
// ======================================================================== //
const ACTIONS = () => (STORE.actions || []);
const acById = id => ACTIONS().find(a => a.id === id) || null;
const AFREQ = {jour: "Chaque jour", semaine: "Chaque semaine", mois: "Chaque mois"};
const JSEM = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];   // 0 = lundi
const weekdayIdx = ds => (dparse(ds).getUTCDay() + 6) % 7;        // 0=lundi .. 6=dimanche
const OCC_LBL = {fait: "fait", saute: "sauté", rate: "raté"};

function lastDayOfMonth(ds){
  const y = +ds.slice(0, 4), m = +ds.slice(5, 7);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();       // jour 0 du mois suivant = dernier du mois
}
const occOf = (a, d) => (a.occurrences || []).find(o => o.date === d) || null;
const occStat = (a, d) => { const o = occOf(a, d); return o ? o.statut : null; };

// Une occurrence est-elle ATTENDUE ce jour-là ? (indépendant de son statut)
function occAttendue(a, d){
  const r = a.recurrence;
  if(!r) return false;
  if(r.freq === "jour") return true;
  if(r.freq === "semaine"){
    if(r.jours && r.jours.length) return r.jours.includes(weekdayIdx(d));
    return weekdayIdx(d) === 0;                          // sans jour précis : rendez-vous le lundi
  }
  if(r.freq === "mois"){
    const jour = +d.slice(8, 10);
    if(r.jour_mois === "fin") return jour === lastDayOfMonth(d);
    return jour === (r.jour_mois || 1);
  }
  return false;
}
// Occurrences attendues entre deux dates (bornes incluses), plafonnées.
function occAttendues(a, debut, fin){
  const out = [];
  let d = debut, guard = 0;
  while(d <= fin && guard++ < 800){
    if(occAttendue(a, d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
// Occurrences passées encore SANS statut : ni faites, ni sautées, ni actées ratées.
// C'est la dette réelle d'une routine — ce que l'ancien système effaçait en silence.
function occEnSouffrance(a, jusqua){
  if(!a.recurrence || !a.actif) return [];
  const depuis = a.occurrences && a.occurrences.length
    ? a.occurrences[0].date : (a.cree_le || addDays(jusqua, -60));
  const borne = depuis < addDays(jusqua, -180) ? addDays(jusqua, -180) : depuis;   // 6 mois de recul max
  return occAttendues(a, borne, addDays(jusqua, -1)).filter(d => !occStat(a, d));
}
// Début d'observation d'une routine : jamais avant sa création, sinon on lui
// reprocherait des semaines où elle n'existait pas (et tout afficherait 0 %).
function acDepuis(a, jours){
  const fenetre = addDays(TODAY, -(jours || 56));
  const naissance = a.cree_le || fenetre;
  return naissance > fenetre ? naissance : fenetre;
}
// Taux de tenue : la seule question qu'on se pose sur une routine. Les occurrences
// sautées volontairement sortent du dénominateur — sauter n'est pas rater.
function tenue(a, jours){
  if(!a.recurrence) return null;
  const dus = occAttendues(a, acDepuis(a, jours), TODAY).filter(d => occStat(a, d) !== "saute");
  const faits = dus.filter(d => occStat(a, d) === "fait").length;
  return {faits, total: dus.length, pct: dus.length ? Math.round(100 * faits / dus.length) : null};
}
// Série en cours (chaîne de Seinfeld) : occurrences tenues d'affilée en remontant.
function serie(a){
  if(!a.recurrence) return 0;
  const dus = occAttendues(a, acDepuis(a, 365), TODAY).reverse();
  let n = 0;
  for(const d of dus){
    const st = occStat(a, d);
    if(st === "saute") continue;                         // sauté volontairement : ne casse pas la série
    if(st === "fait"){ n++; continue; }
    if(d === TODAY) continue;                            // aujourd'hui pas encore fait : la série tient
    break;
  }
  return n;
}

// --- État "à faire" d'une action à une date --------------------------------
const acFaite = (a, d) => a.recurrence ? occStat(a, d) === "fait" : !!a.done;
function acDue(a, d){                                    // doit-elle apparaître dans la liste du jour ?
  if(!a.actif) return false;
  if(a.recurrence) return occAttendue(a, d);
  if(a.done) return false;
  // Une action SANS échéance n'est pas « due » : elle attend dans son seau et se
  // revoit à la revue hebdo. Sinon elle réclamerait l'attention tous les jours,
  // la liste du jour deviendrait ingérable et on cesserait de la regarder.
  return !!a.echeance && a.echeance <= d;
}
const acRetard = a => !a.recurrence && !a.done && a.echeance && isLate(a.echeance);
const acMeta = a => {
  const m = [];
  if(a.recurrence){
    m.push(AFREQ[a.recurrence.freq] || a.recurrence.freq);
    if(a.recurrence.freq === "semaine" && a.recurrence.jours.length)
      m.push(a.recurrence.jours.map(j => JSEM[j]).join(", "));
    if(a.recurrence.freq === "mois")
      m.push(a.recurrence.jour_mois === "fin" ? "dernier jour du mois" : "le " + (a.recurrence.jour_mois || 1));
  } else if(a.echeance) m.push("échéance " + fmt(a.echeance));
  else m.push("sans échéance");
  if(a.heure) m.push(a.heure);
  if(a.estimation_min) m.push(fmtDur(a.estimation_min));
  return m.join(" · ");
};
const acMin = aid => TIMELOG().filter(s => s.action_id === aid).reduce((a, s) => a + sessMin(s), 0);
const activeForAction = aid => { const a = activeSession(); return a && a.action_id === aid ? a : null; };

// Priorité × urgence (Eisenhower) : ce qui est prioritaire ET dû aujourd'hui
// passe devant. Sert au tri, pas à une matrice décorative en quatre cases.
const PRIO_RANG = {h: 0, m: 1, b: 2};
function acUrgence(a){
  if(acRetard(a)) return 0;
  if(a.echeance === TODAY) return 1;
  if(a.echeance && a.echeance <= addDays(TODAY, 7)) return 2;
  if(!a.echeance) return 4;
  return 3;
}
function acSort(list){
  return list.slice().sort((x, y) => {
    const u = acUrgence(x) - acUrgence(y); if(u) return u;
    const p = PRIO_RANG[x.prio] - PRIO_RANG[y.prio]; if(p) return p;
    return (x.ordre || 0) - (y.ordre || 0);
  });
}

// --- Regroupement de la vue Actions ----------------------------------------
// Les seaux sont temporels : c'est ainsi qu'on décide quoi faire, pas par projet.
function acBuckets(){
  const ouvertes = ACTIONS().filter(a => a.actif && !a.recurrence && !a.done);
  const sem = addDays(TODAY, 7);
  return [
    {k: "retard",  titre: "En retard",       cls: "bad",  items: acSort(ouvertes.filter(a => acRetard(a)))},
    {k: "jour",    titre: "Aujourd'hui",     cls: "now",  items: acSort(ouvertes.filter(a => a.echeance === TODAY))},
    {k: "semaine", titre: "Cette semaine",   cls: "",     items: acSort(ouvertes.filter(a => a.echeance && a.echeance > TODAY && a.echeance <= sem))},
    {k: "plus",    titre: "Plus tard",       cls: "",     items: acSort(ouvertes.filter(a => a.echeance && a.echeance > sem))},
    {k: "sansdate",titre: "Sans échéance",   cls: "soft", items: acSort(ouvertes.filter(a => !a.echeance))},
  ];
}
const acRoutines = () => ACTIONS().filter(a => a.recurrence);
const acDuJour = () => ACTIONS().filter(a => acDue(a, TODAY) && !acFaite(a, TODAY));

// ======================================================================== //
//  Vue Actions
// ======================================================================== //
let ACT_F = {theme: "", chantier: "", q: "", faites: false};
let ACT_TAB = "todo";                        // todo | routines | faites
function acSetTab(t){ ACT_TAB = t; renderActions(); }
function acFiltre(k, v){ ACT_F[k] = v; renderActions(); }
function acFiltreClear(){ ACT_F = {theme: "", chantier: "", q: "", faites: false}; renderActions(); }
function acMatch(a){
  if(ACT_F.theme && a.theme_id !== ACT_F.theme) return false;
  if(ACT_F.chantier && a.chantier_id !== ACT_F.chantier) return false;
  if(ACT_F.q && !(a.label + " " + (a.desc || "")).toLowerCase().includes(ACT_F.q.toLowerCase())) return false;
  return true;
}

function renderActions(){
  const dus = acDuJour().filter(acMatch);
  const dette = acRoutines().filter(a => acMatch(a))
    .map(a => ({a, occ: occEnSouffrance(a, TODAY)})).filter(x => x.occ.length);
  let h = "";

  // --- Bandeau : capture immédiate. C'est la fonction la plus utilisée de la vue.
  h += acCaptureBar();

  // --- Filtres transverses
  h += `<div class="ac-filters">` +
    `<input class="ac-q" placeholder="Filtrer…" value="${esc(ACT_F.q)}" oninput="acFiltre('q',this.value)">` +
    `<span class="th-filter">` +
      `<button class="th-fb ${ACT_F.theme ? "" : "on"}" onclick="acFiltre('theme','')">Tous</button>` +
      THEMES_ON().map(t => `<button class="th-fb ${ACT_F.theme === t.id ? "on" : ""}" style="--th:${t.couleur}" ` +
        `onclick="acFiltre('theme','${t.id}')" title="${esc(t.nom)}">${t.icone} ${esc(t.nom)}</button>`).join("") +
    `</span>` +
    ((ACT_F.q || ACT_F.theme || ACT_F.chantier) ? `<button class="btn sm" onclick="acFiltreClear()">Effacer</button>` : "") +
    `</div>`;

  // --- Onglets
  const nTodo = acBuckets().reduce((n, b) => n + b.items.filter(acMatch).length, 0);
  h += `<div class="ac-tabs">` +
    `<button class="${ACT_TAB === "todo" ? "on" : ""}" onclick="acSetTab('todo')">À faire <b>${nTodo}</b></button>` +
    `<button class="${ACT_TAB === "routines" ? "on" : ""}" onclick="acSetTab('routines')">Routines <b>${acRoutines().length}</b></button>` +
    `<button class="${ACT_TAB === "faites" ? "on" : ""}" onclick="acSetTab('faites')">Faites</button>` +
    `</div>`;

  if(ACT_TAB === "todo"){
    // Le jour d'abord : routines dues + actions à échéance du jour, chronométrables.
    h += `<div class="ch-h">Aujourd'hui — ${fmt(TODAY)}</div>`;
    h += dus.length
      ? `<div class="ac-list">` + acSort(dus).map(a => acRow(a, TODAY)).join("") + `</div>`
      : `<div class="ok-note">Rien de dû aujourd'hui. Tout est à jour.</div>`;
    h += acCapaciteNote(dus);

    // La dette de routines : ce qui a été raté et qu'on doit acter.
    if(dette.length) h += acDetteBloc(dette);

    // Puis le reste, par horizon.
    acBuckets().forEach(b => {
      const items = b.items.filter(acMatch);
      if(!items.length) return;
      if(b.k === "jour") return;                        // déjà couvert par « Aujourd'hui »
      h += `<div class="ch-h ${b.cls}">${b.titre} <span class="muted">(${items.length})</span></div>`;
      h += `<div class="ac-list">` + items.map(a => acRow(a, TODAY)).join("") + `</div>`;
    });
  }

  if(ACT_TAB === "routines") h += acRoutinesTab();
  if(ACT_TAB === "faites")   h += acFaitesTab();

  $("actions").innerHTML = h;
  const q = $("ac_q_keep");
  if(q) q.focus();
}

// --- Capture : un champ, une ligne, zéro friction --------------------------
// La saisie accepte des raccourcis : #thème, @chantier, !h/!m/!b, une date, 15m.
function acCaptureBar(){
  return `<div class="ac-capture">` +
    `<input id="ac_new" placeholder="Ajouter une action… (ex. Relancer Karim export FAFE #ERP !h vendredi 15m)" ` +
      `onkeydown="if(event.key==='Enter')acQuickAdd()">` +
    `<button class="btn primary" onclick="acQuickAdd()">Ajouter</button>` +
    `<button class="btn" onclick="acShowFull()" title="Formulaire complet : routine, chantier, estimation…">Détaillé…</button>` +
    `<div class="ac-hint">` +
      `<code>#thème</code> classe · <code>!h</code> priorité · <code>demain</code>, <code>vendredi</code>, <code>12/08</code> échéance · <code>20m</code> estimation` +
    `</div>` +
    `<div id="ac_full"></div>` +
    `</div>`;
}

// Analyse de la saisie rapide. Tout est optionnel ; ce qui n'est pas reconnu
// reste dans le libellé — on ne perd jamais ce que l'utilisateur a tapé.
function acParse(txt){
  const out = {label: txt, theme_id: null, prio: "m", echeance: null, estimation_min: 0, chantier_id: null};
  let s = " " + txt + " ";
  // #thème (correspondance sur le début du nom, insensible à la casse/accents)
  const norm = x => x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/\s#([^\s#@!]+)/g, (m, tag) => {
    const t = THEMES_ON().find(t => norm(t.nom).startsWith(norm(tag)));
    if(t){ out.theme_id = t.id; return " "; }
    return m;
  });
  // @chantier
  s = s.replace(/\s@([^\s#@!]+)/g, (m, q) => {
    const c = LIVE().find(c => norm(c.titre).includes(norm(q)));
    if(c){ out.chantier_id = c.id; return " "; }
    return m;
  });
  // !h / !m / !b
  s = s.replace(/\s!([hmb])\b/i, (m, p) => { out.prio = p.toLowerCase(); return " "; });
  // estimation : 20m / 2h / 1h30
  s = s.replace(/\s(\d+)h(\d{1,2})?\b/i, (m, hh, mm) => { out.estimation_min = +hh * 60 + (+mm || 0); return " "; });
  if(!out.estimation_min) s = s.replace(/\s(\d+)\s?m(in)?\b/i, (m, mi) => { out.estimation_min = +mi; return " "; });
  // dates : aujourd'hui / demain / jour de semaine / JJ-MM / JJ/MM
  const jours = {lundi: 0, mardi: 1, mercredi: 2, jeudi: 3, vendredi: 4, samedi: 5, dimanche: 6};
  s = s.replace(/\s(aujourd'?hui|demain|apr[eè]s-demain)\b/i, (m, w) => {
    const k = norm(w);
    out.echeance = addDays(TODAY, k.startsWith("aujourd") ? 0 : k.startsWith("demain") ? 1 : 2);
    return " ";
  });
  if(!out.echeance) s = s.replace(/\s(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i, (m, w) => {
    const cible = jours[norm(w)], cur = weekdayIdx(TODAY);
    out.echeance = addDays(TODAY, ((cible - cur) + 7) % 7 || 7);   // la PROCHAINE occurrence
    return " ";
  });
  if(!out.echeance) s = s.replace(/\s(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/, (m, dd, mm, yy) => {
    const y = yy ? (yy.length === 2 ? "20" + yy : yy) : TODAY.slice(0, 4);
    const iso = `${y}-${String(+mm).padStart(2, "0")}-${String(+dd).padStart(2, "0")}`;
    // une date sans année déjà passée vise l'an prochain
    out.echeance = (!yy && iso < TODAY) ? `${+y + 1}-${iso.slice(5)}` : iso;
    return " ";
  });
  out.label = s.replace(/\s+/g, " ").trim();
  return out;
}
function acQuickAdd(){
  const el = $("ac_new"), txt = (el.value || "").trim();
  if(!txt){ el.focus(); return; }
  const p = acParse(txt);
  if(!p.label){ alert("Il ne reste rien comme libellé une fois les raccourcis retirés."); return; }
  el.value = "";
  mutate({op: "action_add", ...p});
}
// Formulaire complet : routine, chantier, estimation — pour ce que la ligne rapide ne couvre pas.
function acShowFull(){
  const box = $("ac_full");
  if(!box) return;
  if(box.innerHTML){ box.innerHTML = ""; return; }
  box.innerHTML = `<div class="ac-form">` +
    `<input id="acf_label" placeholder="Libellé de l'action / de la routine">` +
    `<textarea id="acf_desc" placeholder="Description (optionnel)"></textarea>` +
    `<div class="ac-frow">` +
      `<label>Type <select id="acf_type" onchange="acFormUI()">` +
        `<option value="once">Action ponctuelle</option><option value="rec">Routine récurrente</option></select></label>` +
      `<label>Priorité <select id="acf_prio"><option value="h">Haute</option>` +
        `<option value="m" selected>Moyenne</option><option value="b">Basse</option></select></label>` +
      `<label>Thème ${themeSelect("", "", "acf_theme_sel")}</label>` +
      `<label>Chantier <select id="acf_ch"><option value="">— sans chantier —</option>` +
        LIVE().map(c => `<option value="${c.id}">${esc(c.titre)}</option>`).join("") + `</select></label>` +
    `</div>` +
    `<div class="ac-frow" id="acf_once">` +
      `<label>Échéance <input id="acf_ech" type="date"></label>` +
      `<label>Estimation (min) <input id="acf_est" type="number" min="0" step="5" class="rp-num"></label>` +
      `<label>Heure <input id="acf_heure" type="time"></label>` +
    `</div>` +
    `<div class="ac-frow" id="acf_rec" style="display:none">` +
      `<label>Fréquence <select id="acf_freq" onchange="acFormUI()">` +
        Object.entries(AFREQ).map(([k, v]) => `<option value="${k}">${v}</option>`).join("") + `</select></label>` +
      `<span id="acf_jours" class="rp-days" style="display:none">` +
        JSEM.map((j, i) => `<label><input type="checkbox" class="acf-day" value="${i}">${j}</label>`).join("") + `</span>` +
      `<label id="acf_jmwrap" style="display:none">Jour du mois <select id="acf_jm">` +
        Array.from({length: 31}, (_, i) => `<option value="${i + 1}">le ${i + 1}</option>`).join("") +
        `<option value="fin">dernier jour du mois</option></select></label>` +
      `<label>Heure <input id="acf_heure2" type="time"></label>` +
    `</div>` +
    `<div class="ac-frow"><button class="btn primary" onclick="acAddFull()">Créer</button>` +
      `<button class="btn" onclick="acShowFull()">Annuler</button></div>` +
    `</div>`;
  // le <select> de thème produit par themeSelect() n'a pas d'id : on le lui pose
  const sel = box.querySelector(".acf_theme_sel");
  if(sel){ sel.id = "acf_theme"; sel.removeAttribute("onchange"); }
  $("acf_label").focus();
}
function acFormUI(){
  const rec = $("acf_type").value === "rec";
  $("acf_once").style.display = rec ? "none" : "flex";
  $("acf_rec").style.display  = rec ? "flex" : "none";
  if(rec){
    const f = $("acf_freq").value;
    $("acf_jours").style.display  = f === "semaine" ? "inline-flex" : "none";
    $("acf_jmwrap").style.display = f === "mois" ? "block" : "none";
  }
}
function acAddFull(){
  const label = $("acf_label").value.trim();
  if(!label){ $("acf_label").focus(); return; }
  const rec = $("acf_type").value === "rec";
  const op = {op: "action_add", label, desc: $("acf_desc").value.trim(),
              prio: $("acf_prio").value, theme_id: $("acf_theme").value || null,
              chantier_id: $("acf_ch").value || null};
  if(rec){
    const jm = $("acf_jm").value;
    op.recurrence = {freq: $("acf_freq").value,
                     jours: [...document.querySelectorAll(".acf-day:checked")].map(x => +x.value),
                     jour_mois: jm === "fin" ? "fin" : +jm};
    op.heure = $("acf_heure2").value || null;
  } else {
    op.echeance = $("acf_ech").value || null;
    op.estimation_min = +$("acf_est").value || 0;
    op.heure = $("acf_heure").value || null;
  }
  mutate(op);
}

// --- Une ligne d'action ----------------------------------------------------
function acRow(a, d){
  const fait = acFaite(a, d);
  const rec = !!a.recurrence;
  const sess = activeForAction(a.id);
  const mins = acMin(a.id);
  const ch = a.chantier_id ? chById(a.chantier_id) : null;
  const st = rec ? occStat(a, d) : null;
  const deuxMin = a.estimation_min && a.estimation_min <= 2 && !fait;

  let ctrl;
  if(sess) ctrl = `<button class="tstart stop" title="Terminer (arrête le chrono et coche)" onclick="acStop('${a.id}')">⏹ Terminer</button>` +
                  `<span class="tstate inprog" title="Depuis ${sess.debut}">⏱ ${sess.debut}</span>`;
  else ctrl = `<button class="tstart" title="Démarrer le chrono sur cette action" onclick="acStart('${a.id}')">${fait ? "▶" : "▶ Démarrer"}</button>`;

  const st_serie = rec ? serie(a) : 0;
  return `<div class="ac-row${fait ? " done" : ""}${st === "saute" ? " skipped" : ""}${acRetard(a) ? " late" : ""}">` +
    `<span class="box ${fait ? "ok" : ""}" title="${fait ? "Décocher" : "Marquer fait"}" ` +
      `onclick="mutate({op:'action_done',id:'${a.id}',date:'${d}'})"></span>` +
    `<div class="ac-body">` +
      `<div class="ac-lib">${themeDot(a.theme_id)}<span class="ac-txt">${esc(a.label)}</span>` +
        `<span class="prio p-${a.prio}" title="Priorité">${a.prio === "h" ? "haute" : a.prio === "b" ? "basse" : "moy."}</span>` +
        (rec ? `<span class="bdg b-rec" title="Routine récurrente">🔁</span>` : ``) +
        (acRetard(a) ? ` <span class="bdg b-late">⏰ en retard</span>` : ``) +
        (deuxMin ? ` <span class="bdg b-2min" title="Moins de 2 minutes : à faire maintenant plutôt qu'à replanifier">⚡ 2 min</span>` : ``) +
        (st === "saute" ? ` <span class="bdg b-skip">sauté</span>` : ``) +
        (st_serie >= 3 ? ` <span class="bdg b-streak" title="${st_serie} occurrences tenues d'affilée">🔥 ${st_serie}</span>` : ``) +
        (mins ? ` <span class="ac-dur">${fmtDur(mins)}</span>` : ``) +
      `</div>` +
      `<div class="ac-meta">${esc(acMeta(a))}` +
        (ch ? ` · <span class="ac-ch" onclick="openChantier('${ch.id}')">🗂 ${esc(ch.titre)}</span>` : ``) +
      `</div>` +
      (a.desc ? `<div class="ac-desc">${esc(a.desc)}</div>` : ``) +
    `</div>` +
    ctrl +
    (rec
      ? `<button class="ac-skip" title="Sauter cette occurrence (volontairement — ne compte pas comme ratée)" onclick="mutate({op:'action_skip',id:'${a.id}',date:'${d}'})">⤳</button>`
      : `<button class="ac-skip" title="Reporter à demain" onclick="mutate({op:'action_defer',id:'${a.id}',jours:1})">→1j</button>`) +
    `<span class="del" title="Supprimer" onclick="if(confirm('Supprimer « ${jqs(a.label)} » ?'))mutate({op:'action_remove',id:'${a.id}'})">×</span>` +
    `</div>`;
}
function acStart(aid){
  const a = acById(aid); if(!a) return;
  mutate({op: "clock_start", kind: "action", label: a.label, action_id: aid,
          chantier_id: a.chantier_id || null, tache_id: a.tache_id || null,
          theme_id: a.theme_id || null});
}
async function acStop(aid){          // terminer : arrête le chrono ET coche
  await mutate({op: "clock_stop"});
  const a = acById(aid);
  if(a && !acFaite(a, TODAY)) await mutate({op: "action_done", id: aid, date: TODAY});
}

// --- Capacité du jour : la limite déjà réglée sert aussi aux actions --------
function acCapaciteNote(dus){
  const cap = +SETTINGS.capacite_jour || 0;
  if(!cap || dus.length <= cap) return "";
  return `<div class="ac-warn">⚠ ${dus.length} actions dues aujourd'hui pour une capacité réglée à <b>${cap}</b>. ` +
         `Reporte ou saute ce qui peut attendre — une liste qu'on ne finit jamais cesse d'être un plan.</div>`;
}

// --- Dette de routines : ce que l'ancien système effaçait -------------------
function acDetteBloc(dette){
  const n = dette.reduce((s, x) => s + x.occ.length, 0);
  let h = `<div class="ch-h bad">Routines non tenues <span class="muted">(${n} occurrences en souffrance)</span></div>`;
  h += `<div class="muted small" style="margin-bottom:8px">Ces échéances sont passées sans être cochées. ` +
       `Acte-les — <b>rattrapé</b> si tu l'as fait après coup, <b>sauté</b> si tu as décidé de ne pas le faire, ` +
       `<b>raté</b> sinon. Un raté reste dans l'historique et pèse sur le taux de tenue.</div>`;
  h += `<div class="ac-list">`;
  dette.forEach(({a, occ}) => {
    occ.slice(-8).forEach(d => {
      h += `<div class="ac-row dette">` +
        `<span class="ac-dette-d">${fmt(d)}</span>` +
        `<div class="ac-body"><div class="ac-lib">${themeDot(a.theme_id)}<span class="ac-txt">${esc(a.label)}</span></div>` +
          `<div class="ac-meta">${esc(acMeta(a))}</div></div>` +
        `<button class="btn sm" title="Je l'ai fait ce jour-là" onclick="mutate({op:'action_done',id:'${a.id}',date:'${d}'})">✓ Rattrapé</button>` +
        `<button class="btn sm" title="Décidé volontairement de ne pas le faire" onclick="mutate({op:'action_skip',id:'${a.id}',date:'${d}'})">⤳ Sauté</button>` +
        `<button class="btn sm bad" title="Acte le raté : reste dans l'historique et pèse sur le taux de tenue" onclick="mutate({op:'action_miss',id:'${a.id}',date:'${d}'})">✕ Raté</button>` +
        `</div>`;
    });
    if(occ.length > 8) h += `<div class="muted small">… et ${occ.length - 8} occurrences plus anciennes de « ${esc(a.label)} ».</div>`;
  });
  return h + `</div>`;
}

// --- Onglet Routines : le taux de tenue, seule métrique qui compte ----------
function acRoutinesTab(){
  const rs = acRoutines().filter(acMatch);
  if(!rs.length) return `<div class="empty">Aucune routine. Crée-en une avec « Détaillé… » → Routine récurrente.</div>`;
  let h = `<div class="ch-h">Tenue des routines <span class="muted">— 8 dernières semaines</span></div>`;
  h += `<div class="rt-mlist">`;
  rs.forEach(a => {
    const t = tenue(a, 56), s = serie(a);
    const cls = t.pct == null ? "" : t.pct >= 80 ? "good" : t.pct >= 50 ? "warn" : "bad";
    const ch = a.chantier_id ? chById(a.chantier_id) : null;
    h += `<div class="rt-mrow${a.actif ? "" : " off"}">` +
      `<div class="rt-mhead">` +
        `<label class="rt-toggle" title="${a.actif ? "Active — décocher pour mettre en sommeil" : "En sommeil — cocher pour réactiver"}">` +
          `<input type="checkbox" ${a.actif ? "checked" : ""} onchange="mutate({op:'action_update',id:'${a.id}',actif:this.checked})"></label>` +
        `<input class="rt-mlib" value="${esc(a.label)}" ` +
          `onblur="if(this.value.trim()&&this.value!=='${jqs(a.label)}')mutate({op:'action_update',id:'${a.id}',label:this.value.trim()})">` +
        themeSelect(a.theme_id, `mutate({op:'action_update',id:'${a.id}',theme_id:this.value||null})`) +
        `<select class="rt-mch" title="Chantier rattaché (le temps chronométré y sera compté)" ` +
          `onchange="mutate({op:'action_update',id:'${a.id}',chantier_id:this.value||null,tache_id:null})">` +
          `<option value="">— sans chantier —</option>` +
          LIVE().map(c => `<option value="${c.id}" ${a.chantier_id === c.id ? "selected" : ""}>${esc(c.titre)}</option>`).join("") + `</select>` +
        `<span class="rt-mmeta">${esc(acMeta(a))}</span>` +
        `<span class="tenue ${cls}" title="Occurrences tenues sur celles attendues (les sautées volontairement sont exclues)">` +
          (t.pct == null ? "—" : `${t.pct} % · ${t.faits}/${t.total}`) + `</span>` +
        (s >= 3 ? `<span class="bdg b-streak" title="${s} d'affilée">🔥 ${s}</span>` : ``) +
        `<span class="del" title="Supprimer" onclick="if(confirm('Supprimer « ${jqs(a.label)} » ?'))mutate({op:'action_remove',id:'${a.id}'})">×</span>` +
      `</div>` +
      acSparkline(a) +
      `<input class="rt-mdesc" value="${esc(a.desc || "")}" placeholder="+ description / notes…" ` +
        `onblur="if(this.value!==this.defaultValue)mutate({op:'action_update',id:'${a.id}',desc:this.value})">` +
      `</div>`;
  });
  return h + `</div>`;
}
// Frise des 8 dernières semaines : une pastille par occurrence attendue.
function acSparkline(a){
  const dates = occAttendues(a, acDepuis(a, 56), TODAY).slice(-40);
  if(!dates.length) return "";
  return `<div class="ac-spark">` + dates.map(d => {
    const st = occStat(a, d);
    const cls = st === "fait" ? "ok" : st === "saute" ? "skip" : st === "rate" ? "miss"
              : (d < TODAY ? "open" : "todo");
    const lbl = st ? OCC_LBL[st] : (d < TODAY ? "non acté" : "à venir");
    return `<i class="sp ${cls}" title="${fmt(d)} — ${lbl}"></i>`;
  }).join("") + `</div>`;
}

// --- Onglet Faites : la trace de ce qui a été abattu ------------------------
function acFaitesTab(){
  const faites = ACTIONS().filter(a => !a.recurrence && a.done && acMatch(a))
    .sort((x, y) => (y.done_date || "").localeCompare(x.done_date || ""));
  const occ = [];
  acRoutines().filter(acMatch).forEach(a => (a.occurrences || [])
    .filter(o => o.statut === "fait").forEach(o => occ.push({a, d: o.date})));
  occ.sort((x, y) => y.d.localeCompare(x.d));
  const parJour = {};
  faites.forEach(a => (parJour[a.done_date || "?"] = parJour[a.done_date || "?"] || []).push({label: a.label, theme_id: a.theme_id}));
  occ.slice(0, 120).forEach(({a, d}) => (parJour[d] = parJour[d] || []).push({label: a.label, theme_id: a.theme_id, rec: true}));
  const jours = Object.keys(parJour).sort().reverse().slice(0, 30);
  if(!jours.length) return `<div class="empty">Rien de terminé pour l'instant.</div>`;
  let h = `<div class="ch-h">Ce qui a été fait <span class="muted">— 30 derniers jours d'activité</span></div>`;
  jours.forEach(d => {
    h += `<div class="ac-day"><div class="ac-day-h">${fmt(d)} <span class="muted">· ${parJour[d].length}</span></div>`;
    h += parJour[d].map(x => `<div class="ac-done-row">${themeDot(x.theme_id)}${x.rec ? "🔁 " : "✓ "}${esc(x.label)}</div>`).join("");
    h += `</div>`;
  });
  return h;
}

// --- Bloc « à faire aujourd'hui » réutilisé dans la vue Planning ------------
function actionsDuJourSection(){
  const dus = acDuJour();
  let h = `<div class="ch-h">Mes actions du jour — ${fmt(TODAY)} ` +
          `<span class="add" onclick="setView('actions')">tout voir</span></div>`;
  h += dus.length
    ? `<div class="ac-list">` + acSort(dus).map(a => acRow(a, TODAY)).join("") + `</div>`
    : `<div class="ok-note">Aucune action ni routine due aujourd'hui.</div>`;
  const dette = acRoutines().map(a => occEnSouffrance(a, TODAY).length).reduce((s, n) => s + n, 0);
  if(dette) h += `<div class="ac-warn">⏰ ${dette} occurrence${dette > 1 ? "s" : ""} de routine non actée${dette > 1 ? "s" : ""}. ` +
                 `<span class="add" onclick="setView('actions')">Régler ça</span></div>`;
  return h;
}

// ======================================================================== //
//  Bloc-notes — journal horodaté.
//  Le besoin : « j'ai écrit quoi et quand ». Donc pas un wiki, mais un
//  journal en append : la date ET l'heure sont posées d'office à la saisie,
//  et une réécriture laisse sa propre trace (maj_le).
// ======================================================================== //
const NOTES = () => (STORE.notes || []);
const ntById = id => NOTES().find(n => n.id === id) || null;
const NT_TYPE = {note: {lbl: "Note", ic: "📝"}, reunion: {lbl: "Réunion", ic: "👥"},
                 decision: {lbl: "Décision", ic: "⚖"}, idee: {lbl: "Idée", ic: "💡"}};
const notesOf = cid => NOTES().filter(n => n.chantier_id === cid)
  .sort((a, b) => (b.date + (b.heure || "")).localeCompare(a.date + (a.heure || "")));

let NT_F = {theme: "", chantier: "", type: "", q: ""};
let NT_EDIT = null;                       // id de la note en cours d'édition
function ntFiltre(k, v){ NT_F[k] = v; renderNotes(); }
function ntFiltreClear(){ NT_F = {theme: "", chantier: "", type: "", q: ""}; renderNotes(); }
function ntEdit(id){ NT_EDIT = (NT_EDIT === id) ? null : id; renderNotes(); }
function ntMatch(n){
  if(NT_F.theme && n.theme_id !== NT_F.theme) return false;
  if(NT_F.chantier && n.chantier_id !== NT_F.chantier) return false;
  if(NT_F.type && n.type !== NT_F.type) return false;
  if(NT_F.q){
    const q = NT_F.q.toLowerCase();
    if(!((n.titre || "") + " " + (n.corps || "")).toLowerCase().includes(q)) return false;
  }
  return true;
}

// ---- Brouillons ---------------------------------------------------------
// La vue se reconstruit ENTIÈREMENT à chaque mutate() (épingler, supprimer,
// filtrer…). Une saisie qui vit dans le DOM disparaît donc au premier clic.
// Le texte en cours vit ici, hors du DOM, et dans localStorage : il survit au
// clic, au changement de vue, à la fermeture de l'onglet et au rechargement.
const NT_DK = "note_draft", NT_EDK = "note_edits";
const NT_D0 = {type: "note", titre: "", theme_id: "", chantier_id: "", corps: ""};
function ntJson(k, def){ try { return JSON.parse(localStorage.getItem(k) || "null") || def; } catch(e){ return def; } }
let NT_DRAFT = {...NT_D0, ...ntJson(NT_DK, {})};   // note en cours de rédaction
let NT_ED = ntJson(NT_EDK, {});                    // {id_note: corps} — réécritures non validées
const ntDraftVide = () => !NT_DRAFT.corps.trim() && !NT_DRAFT.titre.trim();
function ntDraftSave(){ try { localStorage.setItem(NT_DK, JSON.stringify(NT_DRAFT)); } catch(e){} }
function ntDraftClear(){ NT_DRAFT = {...NT_D0}; try { localStorage.removeItem(NT_DK); } catch(e){} }
function ntEdSaveAll(){ try { localStorage.setItem(NT_EDK, JSON.stringify(NT_ED)); } catch(e){} }

// À chaque frappe : on mémorise, on NE re-rend PAS — un rendu ici tuerait le curseur.
function ntD(k, v){ NT_DRAFT[k] = v; ntDraftSave(); ntDraftBadge(); }
function ntEd(id, v){ NT_ED[id] = v; ntEdSaveAll(); }
// Fin de réécriture d'une note existante : on valide côté serveur et on lâche le brouillon.
function ntEdSave(id, v){
  const n = ntById(id);
  if(!n || !v.trim()) return;                            // note disparue, ou vidée : on garde ce qui est écrit
  delete NT_ED[id]; ntEdSaveAll();
  if(v !== n.corps) mutate({op: "note_update", id, corps: v});
}
function ntDraftBadge(){
  const el = $("nt_draft_st"); if(!el) return;
  el.style.display = ntDraftVide() ? "none" : "";
  el.textContent = ntDraftVide() ? "" : "Brouillon conservé — rien n'est perdu si tu cliques ailleurs ou fermes l'onglet.";
}
function ntDraftJeter(){
  if(!ntDraftVide() && !confirm("Vider le brouillon en cours ?\n\nLe texte non enregistré sera perdu.")) return;
  ntDraftClear(); renderNotes(); const t = $("nt_corps"); if(t) t.focus();
}
// Un long texte ne doit pas se lire par une lucarne de quatre lignes.
function ntGrow(el){
  if(!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(Math.max(el.scrollHeight + 2, 92), 640) + "px";
}
// Point de sortie unique du rendu : le brouillon est toujours restitué après coup.
function ntPaint(h){
  $("notes").innerHTML = h;
  ntDraftBadge();
  ntGrow($("nt_corps"));
  document.querySelectorAll("#notes .nt-card.editing textarea").forEach(ntGrow);
}

function renderNotes(){
  Object.keys(NT_ED).forEach(id => { if(!ntById(id)) delete NT_ED[id]; });   // brouillons orphelins
  const all = NOTES().filter(ntMatch)
    .sort((a, b) => (b.date + (b.heure || "")).localeCompare(a.date + (a.heure || "")));
  const pin = all.filter(n => n.epingle);
  let h = "";

  // --- Capture : le champ est en haut, toujours au même endroit, focalisable au clavier (n).
  h += `<div class="nt-capture">` +
    `<div class="nt-crow">` +
      `<select id="nt_type" title="Type de note" onchange="ntD('type',this.value)">` +
        Object.entries(NT_TYPE).map(([k, v]) => `<option value="${k}" ${NT_DRAFT.type === k ? "selected" : ""}>${v.ic} ${v.lbl}</option>`).join("") + `</select>` +
      `<input id="nt_titre" placeholder="Titre (optionnel)" value="${esc(NT_DRAFT.titre)}" oninput="ntD('titre',this.value)">` +
      themeSelect(NT_DRAFT.theme_id, "ntD('theme_id',this.value)", "nt_theme_sel") +
      `<select id="nt_ch" title="Rattacher à un chantier — la note devient son historique" onchange="ntD('chantier_id',this.value)">` +
        `<option value="">— sans chantier —</option>` +
        LIVE().map(c => `<option value="${c.id}" ${NT_DRAFT.chantier_id === c.id ? "selected" : ""}>${esc(c.titre)}</option>`).join("") + `</select>` +
    `</div>` +
    `<textarea id="nt_corps" placeholder="Écris ici. La date et l'heure sont enregistrées automatiquement — c'est tout l'intérêt par rapport au papier. (Ctrl+Entrée pour enregistrer)" ` +
      `oninput="ntD('corps',this.value);ntGrow(this)" ` +
      `onkeydown="if(event.key==='Enter'&&(event.ctrlKey||event.metaKey))ntAdd()">${esc(NT_DRAFT.corps)}</textarea>` +
    `<div class="nt-crow"><button class="btn primary" onclick="ntAdd()">Enregistrer</button>` +
      `<button class="btn sm" onclick="ntDraftJeter()">Vider</button>` +
      `<span class="muted small">Horodatée au ${fmt(TODAY)} à l'heure de saisie.</span>` +
      `<span class="grow"></span><span id="nt_draft_st" class="nt-draft-st"></span></div>` +
    `</div>`;

  // --- Filtres
  h += `<div class="ac-filters">` +
    `<input class="ac-q" placeholder="Rechercher dans les notes…" value="${esc(NT_F.q)}" oninput="ntFiltre('q',this.value)">` +
    `<span class="th-filter">` +
      `<button class="th-fb ${NT_F.theme ? "" : "on"}" onclick="ntFiltre('theme','')">Tous</button>` +
      THEMES_ON().map(t => `<button class="th-fb ${NT_F.theme === t.id ? "on" : ""}" style="--th:${t.couleur}" ` +
        `onclick="ntFiltre('theme','${t.id}')">${t.icone} ${esc(t.nom)}</button>`).join("") +
    `</span>` +
    `<select onchange="ntFiltre('type',this.value)"><option value="">Tous types</option>` +
      Object.entries(NT_TYPE).map(([k, v]) => `<option value="${k}" ${NT_F.type === k ? "selected" : ""}>${v.ic} ${v.lbl}</option>`).join("") + `</select>` +
    ((NT_F.q || NT_F.theme || NT_F.type || NT_F.chantier) ? `<button class="btn sm" onclick="ntFiltreClear()">Effacer</button>` : "") +
    `</div>`;

  if(!NOTES().length){
    h += `<div class="empty">Aucune note. Écris la première ci-dessus — elle sera horodatée, ` +
         `classée par thème, et retrouvable à la recherche.</div>`;
    ntPaint(h); return;
  }
  if(!all.length){
    h += `<div class="empty">Aucune note ne correspond au filtre.</div>`;
    ntPaint(h); return;
  }

  if(pin.length){
    h += `<div class="ch-h">📌 Épinglées</div><div class="nt-list">` + pin.map(ntCard).join("") + `</div>`;
  }
  // Journal : regroupé par jour, du plus récent au plus ancien.
  const parJour = {};
  all.filter(n => !n.epingle).forEach(n => (parJour[n.date] = parJour[n.date] || []).push(n));
  const jours = Object.keys(parJour).sort().reverse();
  h += `<div class="ch-h">Journal <span class="muted">(${all.length} note${all.length > 1 ? "s" : ""})</span></div>`;
  jours.forEach(d => {
    h += `<div class="nt-day"><div class="nt-day-h">${fmt(d)}` +
         (d === TODAY ? ` <span class="bdg b-2min">aujourd'hui</span>` : ``) +
         ` <span class="muted">· ${parJour[d].length}</span></div>`;
    h += `<div class="nt-list">` + parJour[d].map(ntCard).join("") + `</div></div>`;
  });
  ntPaint(h);
}

function ntCard(n){
  const t = NT_TYPE[n.type] || NT_TYPE.note;
  const ch = n.chantier_id ? chById(n.chantier_id) : null;
  if(NT_EDIT === n.id){
    return `<div class="nt-card editing">` +
      `<div class="nt-crow">` +
        `<select onchange="mutate({op:'note_update',id:'${n.id}',type:this.value})">` +
          Object.entries(NT_TYPE).map(([k, v]) => `<option value="${k}" ${n.type === k ? "selected" : ""}>${v.ic} ${v.lbl}</option>`).join("") + `</select>` +
        `<input value="${esc(n.titre)}" placeholder="Titre" onblur="mutate({op:'note_update',id:'${n.id}',titre:this.value})">` +
        themeSelect(n.theme_id, `mutate({op:'note_update',id:'${n.id}',theme_id:this.value||null})`) +
        `<select onchange="mutate({op:'note_update',id:'${n.id}',chantier_id:this.value||null})">` +
          `<option value="">— sans chantier —</option>` +
          LIVE().map(c => `<option value="${c.id}" ${n.chantier_id === c.id ? "selected" : ""}>${esc(c.titre)}</option>`).join("") + `</select>` +
        `<input type="date" value="${n.date}" title="Date de la note" onchange="mutate({op:'note_update',id:'${n.id}',date:this.value})">` +
      `</div>` +
      `<textarea oninput="ntEd('${n.id}',this.value);ntGrow(this)" ` +
        `onblur="ntEdSave('${n.id}',this.value)">${esc(NT_ED[n.id] !== undefined ? NT_ED[n.id] : n.corps)}</textarea>` +
      `<div class="nt-crow"><button class="btn sm primary" onclick="ntEdit('${n.id}')">Fermer</button></div>` +
      `</div>`;
  }
  return `<div class="nt-card">` +
    `<div class="nt-head">` +
      `<span class="nt-ic" title="${t.lbl}">${t.ic}</span>` +
      `<span class="nt-h">${n.heure ? n.heure : ""}</span>` +
      (n.titre ? `<b class="nt-titre">${esc(n.titre)}</b>` : ``) +
      themeChip(n.theme_id) +
      (ch ? `<span class="ac-ch" onclick="openChantier('${ch.id}')">🗂 ${esc(ch.titre)}</span>` : ``) +
      `<span class="grow"></span>` +
      (n.maj_le ? `<span class="muted small" title="Note réécrite le ${fmt(n.maj_le)}">modifiée ${fmt(n.maj_le)}</span>` : ``) +
      (NT_ED[n.id] !== undefined && NT_ED[n.id] !== n.corps
        ? `<span class="nt-draft-st" title="Réécriture commencée, pas encore enregistrée — rouvre avec ✎">✎ brouillon</span>` : ``) +
      `<button class="nt-b" title="${n.epingle ? "Désépingler" : "Épingler en haut"}" onclick="mutate({op:'note_pin',id:'${n.id}'})">${n.epingle ? "📌" : "📍"}</button>` +
      `<button class="nt-b" title="Transformer en action" onclick="ntToAction('${n.id}')">➜ action</button>` +
      `<button class="nt-b" title="Modifier" onclick="ntEdit('${n.id}')">✎</button>` +
      `<span class="del" title="Supprimer" onclick="if(confirm('Supprimer cette note ?'))mutate({op:'note_remove',id:'${n.id}'})">×</span>` +
    `</div>` +
    `<div class="nt-corps">${esc(n.corps).replace(/\n/g, "<br>")}</div>` +
    `</div>`;
}

async function ntAdd(){
  const t = $("nt_corps");
  if(t) ntD("corps", t.value);                           // filet : ce qui est à l'écran fait foi
  const corps = NT_DRAFT.corps.trim(), titre = NT_DRAFT.titre.trim();
  if(!corps && !titre){ if(t) t.focus(); return; }
  const ok = await mutate({op: "note_add", corps, titre, type: NT_DRAFT.type,
                           theme_id: NT_DRAFT.theme_id || null,
                           chantier_id: NT_DRAFT.chantier_id || null});
  if(!ok) return;                                        // échec : le brouillon reste intact, rien à retaper
  ntDraftClear(); renderNotes();
  const c = $("nt_corps"); if(c) c.focus();
}
// Note -> action : le flux compte-rendu de réunion -> décisions à suivre.
function ntToAction(id){
  const n = ntById(id); if(!n) return;
  const suggestion = (n.titre || (n.corps || "").split("\n")[0] || "").slice(0, 90);
  const label = prompt("Libellé de l'action à créer depuis cette note :", suggestion);
  if(label && label.trim()) mutate({op: "note_to_action", id, label: label.trim()});
}

// ======================================================================== //
//  Vue Thèmes — la liste fermée, et ce qu'elle donne à voir en transverse.
//  10 au maximum : la contrainte est la fonctionnalité. Elle force l'arbitrage
//  et c'est ce qui garde le classement utile.
// ======================================================================== //
function renderThemes(){
  const ths = THEMES();
  const actifs = THEMES_ON();
  let h = `<div class="ch-h">Thèmes <span class="muted">— ${actifs.length}/${THEMES_MAX} actifs</span></div>`;
  h += `<div class="muted small" style="margin-bottom:10px">` +
    `Liste <b>fermée</b> : un thème se choisit dans un menu, jamais en saisie libre — c'est ce qui évite ` +
    `les doublons et les fautes de frappe. Un élément porte <b>un seul</b> thème, ` +
    `donc la répartition du temps fait 100 %.</div>`;

  // Répartition transverse : c'est le vrai intérêt du thème.
  const stats = {};
  const bump = (id, k, n) => { const s = stats[id || ""] = stats[id || ""] || {ch: 0, ac: 0, nt: 0, min: 0}; s[k] += (n || 1); };
  STORE.chantiers.forEach(c => bump(c.theme_id, "ch"));
  ACTIONS().forEach(a => bump(a.theme_id, "ac"));
  NOTES().forEach(n => bump(n.theme_id, "nt"));
  TIMELOG().forEach(s => { const t = themeOfSession(s); bump(t ? t.id : "", "min", sessMin(s)); });
  const totMin = Object.values(stats).reduce((a, s) => a + s.min, 0) || 1;

  h += `<div class="th-list">`;
  ths.forEach((t, i) => {
    const s = stats[t.id] || {ch: 0, ac: 0, nt: 0, min: 0};
    const part = Math.round(100 * s.min / totMin);
    h += `<div class="th-row${t.archive ? " off" : ""}" style="--th:${t.couleur}">` +
      `<span class="th-grip">` +
        `<button class="th-mv" title="Monter" onclick="mutate({op:'theme_move',id:'${t.id}',sens:'haut'})" ${i === 0 ? "disabled" : ""}>▲</button>` +
        `<button class="th-mv" title="Descendre" onclick="mutate({op:'theme_move',id:'${t.id}',sens:'bas'})" ${i === ths.length - 1 ? "disabled" : ""}>▼</button>` +
      `</span>` +
      `<input class="th-ic" value="${esc(t.icone)}" maxlength="4" title="Icône" ` +
        `onblur="if(this.value!==this.defaultValue)mutate({op:'theme_update',id:'${t.id}',icone:this.value})">` +
      `<input class="th-nom" value="${esc(t.nom)}" ` +
        `onblur="if(this.value.trim()&&this.value!==this.defaultValue)mutate({op:'theme_update',id:'${t.id}',nom:this.value.trim()})">` +
      `<input class="th-col" type="color" value="${t.couleur}" title="Couleur" ` +
        `onchange="mutate({op:'theme_update',id:'${t.id}',couleur:this.value})">` +
      `<span class="th-stats">` +
        `<b>${s.ch}</b> chantiers · <b>${s.ac}</b> actions · <b>${s.nt}</b> notes` +
        (s.min ? ` · <b>${fmtDur(s.min)}</b> (${part} %)` : ` · <span class="muted">aucun temps</span>`) +
      `</span>` +
      `<label class="rt-toggle" title="${t.archive ? "Archivé — cocher pour réactiver" : "Actif — décocher pour archiver"}">` +
        `<input type="checkbox" ${t.archive ? "" : "checked"} onchange="mutate({op:'theme_update',id:'${t.id}',archive:!this.checked})"></label>` +
      `<span class="del" title="Supprimer ce thème (les éléments repassent sans thème, rien n'est effacé)" ` +
        `onclick="if(confirm('Supprimer « ${jqs(t.nom)} » ?\\n\\nLes ${s.ch} chantiers, ${s.ac} actions et ${s.nt} notes concernés repasseront « sans thème ». Rien n\\'est supprimé.'))mutate({op:'theme_remove',id:'${t.id}'})">×</span>` +
      `</div>`;
  });
  h += `</div>`;

  // Sans thème : ce qui reste à classer.
  const sans = stats[""] || {ch: 0, ac: 0, nt: 0, min: 0};
  if(sans.ch || sans.ac || sans.nt){
    h += `<div class="th-row none"><span class="th-nom">○ Sans thème</span>` +
      `<span class="th-stats"><b>${sans.ch}</b> chantiers · <b>${sans.ac}</b> actions · <b>${sans.nt}</b> notes` +
      (sans.min ? ` · <b>${fmtDur(sans.min)}</b>` : ``) + `</span></div>`;
  }

  // Création — refusée au-delà de 10, volontairement.
  if(actifs.length < THEMES_MAX){
    h += `<div class="th-add">` +
      `<input id="th_ic" class="th-ic" placeholder="🏷" maxlength="4" title="Icône">` +
      `<input id="th_nom" placeholder="Nom du nouveau thème" onkeydown="if(event.key==='Enter')themeAdd()">` +
      `<button class="btn sm primary" onclick="themeAdd()">Créer</button>` +
      `<span class="muted small">${THEMES_MAX - actifs.length} place${THEMES_MAX - actifs.length > 1 ? "s" : ""} restante${THEMES_MAX - actifs.length > 1 ? "s" : ""}</span>` +
      `</div>`;
  } else {
    h += `<div class="ac-warn">Les ${THEMES_MAX} thèmes sont pris. Pour en créer un autre, archive-en un d'abord — ` +
         `c'est cette limite qui empêche la liste de redevenir un fourre-tout.</div>`;
  }

  // Chantiers par thème : réaffectation en un clic après la migration.
  h += `<div class="ch-h">Affectation des chantiers</div>`;
  h += `<div class="th-assign">`;
  sortColumn(LIVE(), "echeance").forEach(c => {
    h += `<div class="th-arow">${themeDot(c.theme_id)}<span class="th-atit" onclick="openChantier('${c.id}')">${esc(c.titre)}</span>` +
      themeSelect(c.theme_id, `mutate({op:'set_theme',chantier_id:'${c.id}',theme_id:this.value||null})`) + `</div>`;
  });
  h += `</div>`;
  $("themes").innerHTML = h;
}
function themeAdd(){
  const nom = $("th_nom").value.trim();
  if(!nom){ $("th_nom").focus(); return; }
  mutate({op: "theme_add", nom, icone: $("th_ic").value.trim() || "•"});
}

// ======================================================================== //
//  Planning : tâches du jour (ordonnées) + Gantt portefeuille (tous chantiers)
// ======================================================================== //
let PLAN_OPEN = new Set();   // ids des tâches du planning dont la checklist d'étapes est dépliée (mémorisé entre rendus)
function planToggleSub(id){
  if(PLAN_OPEN.has(id)) PLAN_OPEN.delete(id); else PLAN_OPEN.add(id);
  renderPlanning();
}
function planningTasks(){
  // Tâches sur lesquelles travailler aujourd'hui : non finies, dont le créneau
  // prévisionnel a déjà commencé (en cours ou en retard) — pas les jalons ni le futur.
  const items = [];
  STORE.chantiers.forEach(c => {
    if(colOf(c) === "done" || c.hold) return;   // chantier en pause : pas dans "à faire"
    const S = computeSchedule(c);
    c.taches.forEach(t => {
      if(t.done || t.is_milestone) return;
      const f = S.fc[t.id], s = S.sched[t.id];
      if(!f || f.fsDate > TODAY) return;                 // commence plus tard → pas aujourd'hui
      const gated = (S.gateInfo[t.id] || []).some(l => l.statut !== "recu");   // attend un livrable
      const late = taskLate(c, S, t.id);                  // retard vs référence/échéance
      items.push({c, t, due: f.ffDate, planEnd: s ? s.endDate : f.ffDate, late, gated,
                  slack: s ? s.slack : 0, critical: !!s && s.critical});
    });
  });
  const pr = {h: 0, m: 1, b: 2};
  items.sort((a, b) =>
    (b.late - a.late) ||                 // en retard d'abord
    (b.critical - a.critical) ||         // puis chemin critique
    (pr[a.c.prio] - pr[b.c.prio]) ||     // puis priorité du chantier
    (a.planEnd < b.planEnd ? -1 : a.planEnd > b.planEnd ? 1 : 0) ||   // échéance la plus proche
    (a.slack - b.slack));
  return items;
}

function portfolioGantt(){
  const rows = LIVE().map(c => ({c, S: computeSchedule(c)}))
    .filter(r => r.S.order.length || r.c.echeance);
  if(!rows.length) return `<div class="empty">Aucun chantier planifiable (ajoute des tâches ou une échéance).</div>`;
  rows.sort((a, b) => {
    const ea = a.c.echeance || a.S.fend, eb = b.c.echeance || b.S.fend;
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });
  let mn = TODAY, mx = TODAY;
  rows.forEach(({c, S}) => {
    const st = c.date_debut || S.start; if(st < mn) mn = st;
    if(S.fend > mx) mx = S.fend; if(c.echeance && c.echeance > mx) mx = c.echeance;
  });
  const span = Math.max(1, daysBetween(mn, mx));
  const labelW = 200, plotW = Math.max(440, Math.min(1000, span * 6)), rowH = 26, top = 30;
  const W = labelW + plotW + 24, H = top + rows.length * rowH + 14;
  const x = d => labelW + (daysBetween(mn, d) / span) * plotW;
  let g = `<div class="scrollx"><svg width="${W}" height="${H}" class="gantt">`;
  // repères de début de mois
  for(let k = 0; k <= span; k++){
    const cur = addDays(mn, k);
    if(k === 0 || cur.slice(8, 10) === "01"){
      const gx = x(cur);
      g += `<line x1="${gx}" y1="${top}" x2="${gx}" y2="${H - 10}" stroke="var(--line-soft)"/>`;
      g += `<text x="${gx + 2}" y="${top - 6}" font-size="9" fill="var(--faint)">${cur.slice(5, 7)}/${cur.slice(2, 4)}</text>`;
    }
  }
  const tx = x(TODAY);
  if(TODAY >= mn && TODAY <= mx){
    g += `<line x1="${tx}" y1="${top}" x2="${tx}" y2="${H - 10}" stroke="var(--red)" stroke-dasharray="3 3"/>`;
    g += `<text x="${tx}" y="${top - 18}" font-size="9" fill="var(--red)" text-anchor="middle">auj.</text>`;
  }
  rows.forEach((r, i) => {
    const c = r.c, S = r.S, y = top + i * rowH + 5;
    const st = c.date_debut || S.start, en = S.fend;
    const blocked = colOf(c) === "block";
    const col = c.statut === "done" ? "var(--green)" : blocked ? "var(--red)"
              : c.statut === "recette" ? "#8b5cf6" : "var(--blue)";
    g += `<text x="${labelW - 8}" y="${y + 11}" font-size="11" text-anchor="end" fill="var(--ink)" ` +
         `style="cursor:pointer" onclick="openChantier('${c.id}')">${esc(c.titre.slice(0, 30))}</text>`;
    const bx = x(st), bw = Math.max(3, x(en) - bx);
    g += `<rect x="${bx}" y="${y}" width="${bw}" height="14" rx="3" fill="${col}" opacity="${c.statut === "done" ? .7 : 1}" ` +
         `style="cursor:pointer" onclick="openChantier('${c.id}')"><title>${esc(c.titre)} : ${fmt(st)} → ${fmt(en)} (${PRIO[c.prio]})</title></rect>`;
    if(c.echeance){
      const ex = x(c.echeance), over = S.fend > c.echeance && c.statut !== "done";
      g += `<path d="M${ex},${y - 3} L${ex + 5},${y + 7} L${ex},${y + 17} L${ex - 5},${y + 7} Z" ` +
           `fill="${over ? "var(--red)" : "var(--ink)"}"><title>échéance ${fmt(c.echeance)}${over ? " — dépassée" : ""}</title></path>`;
    }
  });
  g += `</svg></div><div class="legend">` +
    `<span><i class="sq blue"></i>en cours</span><span><i class="sq red"></i>bloqué</span>` +
    `<span><i class="sq" style="background:#8b5cf6;border-color:#8b5cf6"></i>recette</span>` +
    `<span><i class="sq green"></i>terminé</span><span><i class="dia"></i>échéance (rouge = dépassée)</span></div>`;
  return g;
}

function renderPlanning(){
  const items = planningTasks();
  let h = actionsDuJourSection();
  h += `<div class="ch-h">À faire aujourd'hui — ${fmt(TODAY)} · ${items.length} tâche(s)</div>`;
  if(!items.length){
    h += `<div class="ok-note">Rien d'actif aujourd'hui — aucune tâche en cours ni en retard.</div>`;
  } else {
    h += `<div class="today-list">`;
    items.forEach(it => {
      const c = it.c, t = it.t, tags = [];
      if(t.start_date) tags.push(`<span class="bdg b-inprog">● en cours</span>`);
      if(it.late) tags.push(`<span class="bdg b-late">⏰ en retard</span>`);
      if(it.gated) tags.push(`<span class="bdg b-wait">⌛ attend un livrable</span>`);
      if(it.critical) tags.push(`<span class="bdg red">critique</span>`);
      else if(it.slack > 0) tags.push(`<span class="muted small">marge ${it.slack} j</span>`);
      // Tâche démarrée : case « fait » + un toggle chrono (reprendre / arrêter selon l'état actif).
      // Tâche non démarrée : bouton ▶ démarrer (ou bloqué si plafond WIP atteint).
      const lead = t.start_date
        ? `<span class="box ${t.done ? "ok" : ""}" title="Marquer fait" onclick="event.stopPropagation();mutate({op:'toggle_tache',chantier_id:'${c.id}',tache_id:'${t.id}'})"></span>` +
          (t.done ? "" : (activeForTache(t.id)
            ? `<button class="tstart stop" title="Chrono en cours sur cette tâche — arrêter" onclick="event.stopPropagation();mutate({op:'clock_stop'})">⏹</button>`
            : `<button class="tstart" title="Reprendre le chrono sur cette tâche" onclick="event.stopPropagation();mutate({op:'clock_start',kind:'tache',chantier_id:'${c.id}',tache_id:'${t.id}'})">▶</button>`))
        : startBlocked(c)
        ? `<button class="tstart blocked" title="Limite de ${SETTINGS.wip_max || 3} chantiers « En cours » atteinte" onclick="event.stopPropagation();alert('${wipFullMsg()}')">▶</button>`
        : `<button class="tstart" title="Démarrer cette tâche" onclick="event.stopPropagation();mutate({op:'start_tache',chantier_id:'${c.id}',tache_id:'${t.id}'})">▶</button>`;
      // (7) Écart estimation ↔ réel — uniquement pour une tâche démarrée (non démarrée / jalon ignorés).
      if(t.start_date && !t.is_milestone && t.duree > 0){
        const hj = +SETTINGS.heures_jour || 7, prev = t.duree * hj * 60, tmin = tacheMin(t.id), r = prev ? tmin / prev : 0;
        const ecl = r <= 1 ? "ecart-ok" : r <= 1.5 ? "ecart-warn" : "ecart-bad";   // logique INVERSE d'idxCls : plus le ratio est haut, pire c'est
        tags.push(`<span class="bdg ${ecl}" title="Temps réel vs estimé (${t.duree} j × ${hj} h/j)">⏱ ${fmtDur(tmin)} / ${fmtDur(prev)} prévu</span>`);
      }
      // (3) Étapes cochables : compteur + chevron qui déplie la checklist (état dans PLAN_OPEN).
      const subs = t.subtasks || [], sdone = subs.filter(x => x.done).length, subOpen = PLAN_OPEN.has(t.id);
      const subTog = subs.length
        ? ` · <span class="td-sub-tog" title="Afficher / masquer les étapes" onclick="event.stopPropagation();planToggleSub('${t.id}')">${subOpen ? "▾" : "▸"} ${sdone}/${subs.length} étapes</span>`
        : "";
      h += `<div class="td-row">` + lead +
        `<div class="td-body" onclick="openChantier('${c.id}')">` +
          `<div class="td-lib">${esc(t.label)}</div>` +
          `<div class="td-meta"><span class="pr-${c.prio}">${PRIO[c.prio]}</span> · <b>${esc(c.titre)}</b> · ` +
          `<span class="${it.late ? "bad-t" : ""}">fin prévue ${fmt(it.planEnd)}</span> ${tags.join(" ")}${subTog}</div>` +
          (subOpen && subs.length ? `<div class="subtasks" onclick="event.stopPropagation()">` + subs.map(st =>
            `<div class="strow${st.done ? " done" : ""}">` +
            `<span class="sbox ${st.done ? "ok" : ""}" title="Fait / à faire" onclick="event.stopPropagation();mutate({op:'toggle_subtask',chantier_id:'${c.id}',tache_id:'${t.id}',subtask_id:'${st.id}'})"></span>` +
            `<span class="slabel${st.done ? " done" : ""}">${esc(st.label)}</span></div>`).join("") + `</div>` : "") +
        `</div></div>`;
    });
    h += `</div>`;
  }
  h += `<div class="ch-h">Planning général — tous les chantiers (triés par échéance)</div>`;
  h += portfolioGantt();
  h += maJourneeSection();   // récap du temps : tout en bas, repliable
  $("planning").innerHTML = h;
}

// ======================================================================== //
//  Activité : progression hebdo (journal auto + métriques dérivées des dates)
// ======================================================================== //
function weekStart(ds){   // lundi de la semaine de `ds` (YYYY-MM-DD)
  const dt = dparse(ds), day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day);
  return dstr(dt);
}
// ======================================================================== //
//  Analyse du temps (chrono) — agrégats et visuels pour la vue Activité.
//  Toutes les durées passent par sessMin() : pause déjeuner déduite, journée
//  bornée à l'heure de fin réglée (mêmes règles que « Ma journée »).
// ======================================================================== //
const KIND_LABEL = {tache: "Tâches", recette: "Recette", libre: "Libre / divers", action: "Actions & routines"};
const KIND_COLOR = {tache: "var(--blue)", recette: "var(--violet)", libre: "var(--gray)", action: "var(--amber)"};
const DOW_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

function timeStats(){
  const tl = TIMELOG();
  const byKind = {}, byChantier = {}, byWeek = {}, byHour = {}, byDay = {}, byDow = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  tl.forEach(s => {
    const m = sessMin(s);
    total += m;
    byKind[s.kind] = (byKind[s.kind] || 0) + m;
    const ch = s.chantier_id ? chById(s.chantier_id) : null;
    const name = ch ? ch.titre : "Sans chantier / libre";
    byChantier[name] = (byChantier[name] || 0) + m;
    if(s.date){
      byDay[s.date] = (byDay[s.date] || 0) + m;
      const ws = weekStart(s.date); byWeek[ws] = (byWeek[ws] || 0) + m;
      byDow[(dparse(s.date).getUTCDay() + 6) % 7] += m;   // 0 = lundi
    }
    const hh = (s.debut || "00:00").slice(0, 2); byHour[hh] = (byHour[hh] || 0) + m;
  });
  const daysWorked = Object.values(byDay).filter(v => v > 0).length;
  return {tl, total, byKind, byChantier, byWeek, byHour, byDay, byDow, daysWorked};
}

function timeInsights(){
  const st = timeStats();
  if(!st.total){
    return dsection("Temps passé — chrono") +
      `<div class="muted small">Aucune plage chronométrée pour l'instant. Démarre une tâche ou une routine (bouton ▶), ou ajoute une plage dans « Ma journée » — la répartition par type, par chantier, par semaine et par heure s'affichera ici automatiquement.</div>`;
  }
  const hj = +SETTINGS.heures_jour || 7;
  const jp = st.total / (hj * 60);
  const moy = st.daysWorked ? st.total / st.daysWorked : 0;
  const thisMon = weekStart(TODAY), semaine = st.byWeek[thisMon] || 0;
  const rec = st.byKind.recette || 0;

  const th = tauxHeure(), tauxSet = !!(+SETTINGS.taux_jour);
  const money = actMode() === "argent";
  // Une seule unité à la fois : V = temps OU argent selon le mode. Pas de second
  // affichage — l'interrupteur choisit lequel des deux on regarde.
  const V = m => money ? fmtEur(eurMin(m)) : fmtDur(m);

  // — En-tête avec l'interrupteur Temps / Argent —
  let h = `<div class="ch-h act-head"><span>Temps passé — chrono</span>${actToggle()}</div>`;
  h += `<div class="kband">`;
  h += dkpi("Temps total", V(st.total), st.tl.length + " sessions · " + st.daysWorked + " j travaillés", "", "",
            "Temps total chronométré, toutes activités confondues. " +
            "Pause déjeuner déduite ; journée bornée à l'heure de fin réglée dans Charge." +
            (money ? " Valorisé à " + fmtEur(th) + "/h" + (tauxSet ? " (taux journalier / heures facturables)." : " — taux par défaut, aucun taux journalier réglé dans Charge.") : ""));
  h += dkpi("En jours-personne", jp.toFixed(1).replace(".", ",") + " j", "à " + hj + " h/jour", "", "", "Temps total converti en jours-personnes (heures facturables/jour, réglable dans Charge). Base du coût réel (AC) de l'EVM.");
  h += dkpi("Moyenne / jour", V(moy), "sur jours travaillés", "", "", "Moyenne par jour effectivement travaillé, dans l'unité choisie (temps ou argent).");
  h += dkpi("Cette semaine", V(semaine), "depuis le " + fmtShort(thisMon), "", "", "Cumul depuis lundi de la semaine en cours, dans l'unité choisie.");
  h += dkpi("Part recette", Math.round(rec / st.total * 100) + " %", fmtDur(rec) + " de test", rec / st.total > 0.25 ? "warn" : "", "", "Part du temps passée en recette (tests, itérations). Un ratio élevé peut signaler des allers-retours qualité.");
  h += `</div>`;

  // — Grands graphes : type / semaine / chantiers —
  const kindOrder = ["tache", "action", "recette", "libre"];   // ordre = bleu et violet non adjacents (lisible en daltonisme)
  const kindRows = kindOrder.filter(k => st.byKind[k] > 0)
    .map(k => ({label: KIND_LABEL[k] || k, value: Math.round(st.byKind[k]), color: KIND_COLOR[k] || "var(--gray)"}));
  const weekRows = Object.keys(st.byWeek).sort()
    .map(k => ({label: fmtShort(k), value: st.byWeek[k], disp: V(st.byWeek[k])}));
  const chRows = Object.entries(st.byChantier).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([n, v]) => ({label: n, value: v, disp: V(v),
                       color: n === "Sans chantier / libre" ? "var(--gray)" : "var(--blue)"}));
  const donutTitle = money ? "Valeur par type" : "Répartition par type";
  const weekTitle = money ? "Valorisation par semaine" : "Temps par semaine";
  h += `<div class="dash-row">` +
    chartBox(donutTitle, donutChart(kindRows, {fmt: V, center: {big: V(st.total), small: "total"}})) +
    chartBox(weekTitle, vbar(weekRows, {barW: 34, color: "var(--blue)"})) +
    chartBox("Top chantiers", hbar(chRows, {labelW: 150, barW: 150})) + `</div>`;

  // — Grille dense : rythme (jour de semaine / heure de début) —
  const dowRows = [];
  for(let i = 0; i < 7; i++) if(st.byDow[i] > 0)
    dowRows.push({label: DOW_NAMES[i], value: st.byDow[i], disp: V(st.byDow[i]), color: "var(--blue)"});
  const hourRows = Object.keys(st.byHour).sort()
    .map(hh => ({label: hh + "h", value: st.byHour[hh], disp: V(st.byHour[hh])}));
  h += `<div class="dgrid">`;
  h += chartBox("Par jour de la semaine", hbar(dowRows, {labelW: 82, barW: 150}));
  h += chartBox("Quand tu travailles (heure de début)", vbar(hourRows, {barW: 22, gap: 6, color: "var(--blue)"}));
  h += `</div>`;

  // — Répartition par THÈME —
  // C'est la vue qui manquait : le temps hors chantier n'est plus un unique bloc
  // gris « Libre / divers », il se ventile sur les 10 thèmes. Chaque plage compte
  // une seule fois (mono-thème), donc le total fait bien 100 %.
  const byTheme = {};
  st.tl.forEach(s => {
    const t = themeOfSession(s);
    const k = t ? t.id : "";
    byTheme[k] = (byTheme[k] || 0) + sessMin(s);
  });
  const thRows = Object.entries(byTheme).sort((a, b) => b[1] - a[1]).map(([id, m]) => {
    const t = id ? thById(id) : null;
    return {label: t ? `${t.icone} ${t.nom}` : "○ sans thème", value: Math.round(m),
            disp: V(m), color: t ? t.couleur : "var(--gray)"};
  });
  if(thRows.length){
    h += `<div class="dash-row">` +
      chartBox(money ? "Valeur par thème" : "Répartition par thème",
               donutChart(thRows, {fmt: V, center: {big: V(st.total), small: "total"}})) +
      chartBox("Temps par thème", hbar(thRows, {labelW: 190, barW: 190})) + `</div>`;
    const sansTh = byTheme[""] || 0;
    if(sansTh > st.total * 0.15)
      h += `<div class="ac-warn">${Math.round(100 * sansTh / st.total)} % du temps chronométré n'est rattaché à aucun thème. ` +
           `Classe les plages concernées dans « Ma journée » — sinon cette répartition ne dit rien.</div>`;
  }
  return h;
}

function weeklyActivity(){
  const wk = {};
  const ensure = k => (wk[k] = wk[k] || {taches: 0, jalons: 0, notes: 0, retours: 0, relances: 0, actions: 0, events: []});
  LIVE().forEach(c => {
    (c.taches || []).forEach(t => { if(t.done && t.done_date){ const w = ensure(weekStart(t.done_date)); w.taches++; if(t.is_milestone) w.jalons++; } });
    notesOf(c.id).forEach(n => { if(n.date) ensure(weekStart(n.date)).notes++; });
    (c.livrables || []).forEach(l => { if(l.derniere) ensure(weekStart(l.derniere)).relances++; });
    recPoints(c).forEach(p => { if(p.verifie_le) ensure(weekStart(p.verifie_le)).retours++; });
  });
  (STORE.journal || []).forEach(j => { if(j.date){ const w = ensure(weekStart(j.date)); w.actions++; w.events.push(j); } });
  return wk;
}
function actKpi(label, c, p){
  const d = c - p, arrow = d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : "= 0";
  return kpi(label, String(c), `S-1 : ${p}  (${arrow})`, d > 0 ? "good" : "");
}
function renderActivite(){
  const wk = weeklyActivity();
  const z = {taches: 0, jalons: 0, notes: 0, retours: 0, relances: 0, actions: 0, events: []};
  const thisMon = weekStart(TODAY), lastMon = weekStart(addDays(thisMon, -1));
  const cur = wk[thisMon] || z, prev = wk[lastMon] || z;
  let h = timeInsights();                     // en tête : où part mon temps (chrono)
  h += dsection(`Cette semaine — du ${fmt(thisMon)}`);
  h += `<div class="kpis">` +
    actKpi("Tâches terminées", cur.taches, prev.taches) +
    actKpi("Jalons franchis", cur.jalons, prev.jalons) +
    actKpi("Actions tracées", cur.actions, prev.actions) +
    actKpi("Notes + points vérifiés", cur.notes + cur.retours, prev.notes + prev.retours) + `</div>`;
  // 8 dernières semaines
  const wTaches = [], wActions = [];
  for(let i = 7; i >= 0; i--){
    const k = weekStart(addDays(thisMon, -7 * i)), w = wk[k] || z;
    wTaches.push({label: fmtShort(k), value: w.taches});
    wActions.push({label: fmtShort(k), value: w.actions});
  }
  h += `<div class="dash-row">` +
    chartBox("Tâches terminées / semaine", vbar(wTaches)) +
    chartBox("Actions tracées / semaine", vbar(wActions)) + `</div>`;
  // Journal détaillé par semaine (récent d'abord)
  h += dsection("Journal — ce que tu as fait, par semaine");
  const keys = Object.keys(wk).filter(k => (wk[k].events || []).length).sort().reverse();
  if(!keys.length){
    h += `<div class="muted small">Le journal se remplit automatiquement au fil de tes actions (tâche cochée, chantier déplacé, livrable mis à jour, risque ajouté, note…). Reviens après quelques jours d'usage — l'export Excel (menu « Excel ▾ ») contient déjà les feuilles « Journal » et « Synthèse hebdo ».</div>`;
  }
  keys.forEach(k => {
    const w = wk[k];
    h += `<div class="ch-h">Semaine du ${fmt(k)} · ${w.events.length} action(s)</div><div class="jrnl">`;
    w.events.slice().sort((a, b) => (a.ts < b.ts ? 1 : -1)).forEach(e => {
      h += `<div class="jr"><span class="jr-d">${fmtShort(e.date)}</span>` +
        (e.chantier ? `<b>${esc(e.chantier)}</b> · ` : "") + `${esc(e.msg)}</div>`;
    });
    h += `</div>`;
  });
  $("activite").innerHTML = h;
}

// ======================================================================== //
//  Rapport hebdomadaire — bilan de la semaine, programme à venir, REX.
//  Les FAITS (tâches finies, notes, temps, échéances…) sont calculés par le
//  serveur (op rapport_generate) et recalculables tant que le rapport est en
//  brouillon ; la RÉDACTION (synthèse, avancement, REX par point, REX général,
//  priorités) est saisie ici et n'est jamais écrasée par un recalcul.
// ======================================================================== //
let RAPPORT_MON = null;   // lundi (YYYY-MM-DD) de la semaine affichée
const RAP_ST_LBL = {todo: "À faire", doing: "En cours", block: "Bloqué", recette: "En recette", done: "Terminé"};
function isoWeekStr(ds){  // "2026-W30" — numéro de semaine ISO (règle du jeudi)
  const dt = dparse(ds);
  dt.setUTCDate(dt.getUTCDate() + 3 - (dt.getUTCDay() + 6) % 7);
  const y = dt.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((dt - jan4) / 86400000 - 3 + (jan4.getUTCDay() + 6) % 7) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
const rapports = () => STORE.rapports || [];
function rapShift(d){ RAPPORT_MON = addDays(RAPPORT_MON || weekStart(TODAY), d); renderRapport(); }
function rapGoto(mon){ RAPPORT_MON = mon; showView("rapport"); window.scrollTo(0, 0); }
function rapField(rid, field, val){ mutate({op: "rapport_update", rapport_id: rid, [field]: val}); }
function rapPointField(rid, cid, field, val){ mutate({op: "rapport_point_update", rapport_id: rid, chantier_id: cid, [field]: val}); }
// Zone de rédaction : n'enregistre qu'en cas de changement réel (sinon blur = rien)
function rapTA(ph, val, handler, dis){
  return `<textarea class="rap-ta" placeholder="${esc(ph)}"` +
    (dis ? " disabled" : ` onblur="if(this.value!==this.defaultValue)${handler}"`) +
    `>${esc(val || "")}</textarea>`;
}

// Brouillon d'avancement composé depuis les faits calculés — premier étage de
// l'automatisation de la rédaction (à retoucher ensuite, puis enregistré).
function rapDraft(p){
  const a = p.auto || {}, L = [];
  (a.taches || []).forEach(t => L.push(`${t.jalon ? "★ Jalon franchi" : "✔ Terminé"} : ${t.label} (${fmtShort(t.date)})`));
  // Une note est un compte rendu : on reprend son type et son titre, pas son corps
  // entier (souvent long et multi-lignes) — la rédaction reste à l'auteur.
  (a.notes || []).forEach(n => L.push(`— ${fmtShort(n.d)} · ${ntKind(n).lbl}${n.titre ? " « " + n.titre + " »" : ""} : ` +
    (n.titre ? ntResume(n.t, 160) : (n.t || "").trim())));
  (a.recette || []).forEach(r => L.push(r.statut === "ok"
    ? `Recette : « ${r.quoi} » vérifié.`
    : `Recette : « ${r.quoi} » en problème${r.qui ? " (" + r.qui + ")" : ""}.`));
  if(a.temps_min) L.push(`Temps passé : ${fmtDur(a.temps_min)}.`);
  if(a.relances) L.push(`${a.relances} relance(s) envoyée(s).`);
  return L.join("\n");
}
function rapPrefill(rid, cid){
  const r = rapports().find(x => x.id === rid), p = r && (r.points || []).find(x => x.chantier_id === cid);
  if(!p) return;
  const draft = rapDraft(p);
  if(!draft){ alert("Aucun fait détecté cette semaine pour ce chantier — rien à pré-remplir."); return; }
  if((p.avancement || "").trim() && !confirm("Remplacer le commentaire d'avancement existant par le pré-remplissage ?")) return;
  rapPointField(rid, cid, "avancement", draft);
}
function rapRetardField(rid, cid, val){ mutate({op: "rapport_retard_update", rapport_id: rid, chantier_id: cid, justification: val}); }
function rapFinalize(rid){
  const r = rapports().find(x => x.id === rid);
  const manq = ((r && r.retards) || []).filter(x => !(x.justification || "").trim());
  if(manq.length){
    alert(`Impossible de finaliser : ${manq.length} retard(s) sans justification.\nLa justification des retards est obligatoire (section « Retards à justifier »).`);
    return;
  }
  if(confirm("Finaliser ce rapport ?\nLes données calculées sont figées (plus d'actualisation) et le rapport est visé à ton nom. Tu pourras le rouvrir si besoin."))
    mutate({op: "rapport_finalize", rapport_id: rid});
}
function rapDelete(rid){
  if(confirm("Supprimer définitivement ce rapport hebdomadaire ?")) mutate({op: "rapport_delete", rapport_id: rid});
}

// Rendu d'une note DANS le rapport : type + titre + corps sur plusieurs lignes.
// Sans ça une note remontait comme une ligne de plus dans la liste des tâches
// terminées — même gabarit, retours à la ligne écrasés, titre perdu.
function ntKind(n){ return NT_TYPE[n && n.type] || NT_TYPE.note; }
function ntResume(txt, max){
  const t = (txt || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
// Tolère les deux formes : note de chantier {d,h,t} et note libre {date,heure,corps}.
function rapNoteHTML(n, del){
  const k = ntKind(n);
  const corps = ((n.t != null ? n.t : n.corps) || "").trim();
  const d = n.d || n.date || "", hh = n.h || n.heure || "";
  return `<div class="rap-note"><div class="rap-note-h">` +
    `<span class="rap-note-k">${k.ic} ${k.lbl}</span>` +
    (n.titre ? `<b class="rap-note-t">${esc(n.titre)}</b>` : ``) +
    themeChip(n.theme_id) +
    `<span class="rap-note-d">${d ? fmtShort(d) : ""}${hh ? " · " + hh : ""}</span>` +
    (del || ``) + `</div>` +
    (corps ? `<div class="rap-note-b">${esc(corps)}</div>` : ``) + `</div>`;
}

// Le travail qui n'appartient à aucun chantier : temps hors chantier, actions
// ponctuelles terminées, tenue des routines, notes non rattachées. Ces faits
// étaient calculés et comptés dans les KPI, mais rangés nulle part.
// Croix de retrait d'une ligne calculée : elle n'efface RIEN (la note, l'action
// et le temps restent), elle écarte la ligne de ce rapport-ci — durablement,
// l'exclusion étant rejouée après chaque « Actualiser les données ».
// Clé d'exclusion — MÊME règle que _hc_cle côté serveur : l'id quand il existe,
// sinon le contenu (les rapports établis avant l'ajout des ids n'en portent pas,
// et une croix qui ne retire rien est pire que pas de croix du tout).
function hcCle(fam, o){
  if(o.id) return fam + ":" + o.id;
  if(fam === "note") return "note#" + ((o.d || o.date || "") + "|" + (o.titre || ""));
  return fam + "#" + (o.label || "");
}
function rapHcDel(rid, fam, o, quoi){
  return `<span class="del rap-hc-del" title="Retirer ${quoi} de ce rapport (l'élément n'est pas supprimé)" ` +
    `onclick="mutate({op:'rapport_hc_remove',rapport_id:'${rid}',cle:'${jqs(hcCle(fam, o))}'})">×</span>`;
}

function rapHorsChantier(r, dis){
  const hc = r.hors_chantier || [], af = r.actions_faites || [],
        rt = r.routines_tenue || [], nl = r.notes_libres || [];
  const ecartes = (r.exclus_hc || []).length;
  if(!hc.length && !af.length && !rt.length && !nl.length && !ecartes) return "";
  const box = (titre, chips, body) => `<div class="cardx"><div class="cardx-h">${titre}` +
    (chips ? `<span class="rap-chips">${chips}</span>` : ``) + `</div><div class="cardx-b">${body}</div></div>`;
  const del = (fam, o, quoi) => dis ? "" : rapHcDel(r.id, fam, o, quoi);
  let h = dsection(`Hors chantier <span class="muted small">· actions, routines, réunions et notes non rattachées</span>` +
    (ecartes ? ` <span class="add rap-hc-reset" title="Réafficher tout ce qui a été retiré de ce rapport"` +
      (dis ? "" : ` onclick="mutate({op:'rapport_hc_reset',rapport_id:'${r.id}'})"`) +
      `>${ecartes} élément(s) retiré(s) — tout réafficher</span>` : ``));
  h += `<div class="avenir-grid">`;
  if(hc.length){
    const tot = hc.reduce((a, x) => a + (x.temps_min || 0), 0);
    h += box("Temps hors chantier", `<span class="chip">⏱ ${fmtDur(tot)}</span>`,
      `<div class="rap-facts">` + hc.map(x =>
        `<div class="rap-fact"><span class="rap-fact-d">${fmtDur(x.temps_min)}</span>` +
        `<span><b>${esc(x.label)}</b>${x.kind === "action" ? ` <span class="muted">· action</span>` : ""}` +
        ` <span class="muted">(${(x.jours || []).map(fmtShort).join(", ")})</span></span>` +
        del("temps", x, "ce temps") + `</div>`).join("") + `</div>`);
  }
  if(af.length)
    h += box("Actions terminées", `<span class="chip ok">✔ ${af.length}</span>`,
      `<div class="rap-facts">` + af.map(x => {
        const c = x.chantier_id ? chById(x.chantier_id) : null;
        return `<div class="rap-fact"><span class="rap-fact-d">${fmtShort(x.date)}</span>` +
          `<span>✔ ${esc(x.label)} ${themeChip(x.theme_id)}` +
          (c ? ` <span class="muted">· ${esc(c.titre)}</span>` : ``) + `</span>` +
          del("action", x, "cette action") + `</div>`;
      }).join("") + `</div>`);
  if(rt.length){
    const ok = rt.reduce((a, x) => a + x.faits, 0), du = rt.reduce((a, x) => a + x.total, 0);
    h += box("Tenue des routines",
      `<span class="chip${ok === du ? " ok" : " late"}">${ok}/${du}</span>`,
      `<div class="rap-facts">` + rt.map(x => {
        const pc = x.total ? Math.round(100 * x.faits / x.total) : 0;
        return `<div class="rap-fact"><span class="rap-fact-d${x.faits < x.total ? " bad-t" : ""}">${x.faits}/${x.total}</span>` +
          `<span>${esc(x.label)} ${themeChip(x.theme_id)}` +
          `<span class="rt-jauge" title="${pc} % tenu"><i style="width:${pc}%"></i></span>` +
          (x.rates ? ` <span class="muted">${x.rates} manquée(s)</span>` : ``) + `</span>` +
          del("routine", x, "cette routine") + `</div>`;
      }).join("") + `</div>`);
  }
  if(nl.length)
    h += box("Notes non rattachées", `<span class="chip">🗒 ${nl.length}</span>`,
      `<div class="rap-notes">${nl.map(n => rapNoteHTML(n, dis ? "" : rapHcDel(r.id, "note", n, "cette note"))).join("")}</div>`);
  h += `</div>`;
  return h;
}

function rapPointCard(r, p, dis){
  const a = p.auto || {}, c = chById(p.chantier_id);
  const nj = (a.taches || []).filter(t => t.jalon).length;
  const enc = a.en_cours || [];
  const fini = (r.termines || []).some(x => x.chantier_id === p.chantier_id);
  // livré (recette) ou terminé = pas « en retard », même échéance dépassée
  const late = !fini && a.statut !== "recette" && a.statut !== "done" && a.echeance && a.echeance < TODAY;
  const chips = [];
  if(fini) chips.push(`<span class="chip done">🏁 terminé cette semaine</span>`);
  if(late) chips.push(`<span class="chip late">⏰ en retard</span>`);
  if((a.taches || []).length) chips.push(`<span class="chip ok">✔ ${a.taches.length} tâche${a.taches.length > 1 ? "s" : ""}</span>`);
  if(nj) chips.push(`<span class="chip star">★ ${nj} jalon${nj > 1 ? "s" : ""}</span>`);
  if(enc.length) chips.push(`<span class="chip run">▶ ${enc.length} en cours</span>`);
  if(a.temps_min) chips.push(`<span class="chip">⏱ ${fmtDur(a.temps_min)}</span>`);
  if((a.notes || []).length) chips.push(`<span class="chip">🗒 ${a.notes.length} note${a.notes.length > 1 ? "s" : ""}</span>`);
  if(a.relances) chips.push(`<span class="chip">✉ ${a.relances} relance${a.relances > 1 ? "s" : ""}</span>`);
  if((a.recette || []).length) chips.push(`<span class="chip vio">🧪 ${a.recette.length} point${a.recette.length > 1 ? "s" : ""} de recette</span>`);
  if(!chips.length) chips.push(`<span class="chip off">aucun fait détecté</span>`);
  let h = `<div class="cardx rap-point"><div class="cardx-h">` +
    `<span class="rap-pt-title"${c ? ` onclick="openChantier('${p.chantier_id}')" title="Ouvrir le chantier"` : ""}>${esc(p.chantier)}</span>` +
    (a.pct != null ? `<span class="rap-avlbl">avancement</span><span class="rap-prog" title="Avancement ${a.pct} %"><i style="width:${a.pct}%"></i></span><span class="rap-pct">${a.pct} %</span>` : "") +
    `<span class="muted rap-pt-meta">${RAP_ST_LBL[a.statut] || ""}` +
    `${a.echeance ? ` · échéance <b class="${late ? "bad-t" : ""}">${fmtShort(a.echeance)}</b>` : ""}</span>` +
    `<span class="rap-chips">${chips.join("")}</span>` +
    (dis ? "" : `<span class="del" title="Retirer ce chantier du rapport" onclick="mutate({op:'rapport_point_remove',rapport_id:'${r.id}',chantier_id:'${p.chantier_id}'})">×</span>`) +
    `</div><div class="cardx-b">`;
  const faits = [];
  enc.forEach(t => faits.push(`<div class="rap-fact run"><span class="rap-fact-d">▶</span><span><b>${esc(t.label)}</b> — en cours${t.depuis ? ` <span class="muted">depuis le ${fmtShort(t.depuis)}</span>` : ""}</span></div>`));
  (a.taches || []).forEach(t => faits.push(`<div class="rap-fact"><span class="rap-fact-d">${fmtShort(t.date)}</span><span>${t.jalon ? "★" : "✔"} ${esc(t.label)}</span></div>`));
  (a.recette || []).forEach(x => faits.push(`<div class="rap-fact"><span class="rap-fact-d"></span><span>🧪 ${esc(x.quoi)} <span class="muted">(${x.statut === "ok" ? "vérifié" : "problème"})</span></span></div>`));
  if(faits.length) h += `<div class="lab lab-s">Réalisé cette semaine</div><div class="rap-facts">${faits.join("")}</div>`;
  if((a.notes || []).length)
    h += `<div class="lab lab-s">Notes &amp; comptes rendus <span class="muted">· ce que tu as consigné, repris tel quel dans le PDF</span></div>` +
         `<div class="rap-notes">${a.notes.map(n =>
            rapNoteHTML(n, dis ? "" : rapHcDel(r.id, "note", n, "cette note"))).join("")}</div>`;
  h += `<div class="rap-cols">`;
  h += `<div><div class="lab">Avancement — commentaire` +
    (dis ? "" : ` <span class="add" title="Pré-remplit depuis les faits ci-dessus (tâches, notes, temps) — à retoucher ensuite" onclick="rapPrefill('${r.id}','${p.chantier_id}')">⚡ pré-remplir</span>`) +
    `</div>` + rapTA("Où en est ce chantier, ce qui a avancé, ce qui bloque…", p.avancement,
                     `rapPointField('${r.id}','${p.chantier_id}','avancement',this.value)`, dis) + `</div>`;
  h += `<div><div class="lab">REX du point</div>` +
    rapTA("Leçon apprise sur CE chantier : ce qu'on referait, ce qu'on éviterait…", p.rex,
          `rapPointField('${r.id}','${p.chantier_id}','rex',this.value)`, dis) + `</div>`;
  h += `</div></div></div>`;
  return h;
}

function rapAvenir(r){
  const av = r.avenir || {};
  const box = (title, rows, empty) => `<div class="cardx"><div class="cardx-h">${title}</div><div class="cardx-b">` +
    (rows.length ? rows.join("") : `<div class="empty">${empty}</div>`) + `</div></div>`;
  const line = (d, txt, late) => `<div class="rap-fact"><span class="rap-fact-d${late ? " bad-t" : ""}">${d}</span><span>${txt}</span></div>`;
  const ech = (av.echeances || []).map(x => line(fmtShort(x.date), `<b>${esc(x.chantier)}</b>${x.late ? ` <span class="bad-t">en retard</span>` : ""}`, x.late));
  const jal = (av.jalons || []).map(x => line("★", `${esc(x.label)} <span class="muted">· ${esc(x.chantier)}</span>`));
  const liv = (av.livrables || []).map(x => line(fmtShort(x.date), `${esc(x.quoi)} <span class="muted">· ${esc(x.personne)} · ${esc(x.chantier)}</span>${x.late ? ` <span class="bad-t">en retard</span>` : ""}`, x.late));
  const pro = (av.prochaines || []).map(x => line("", `<b>${esc(x.chantier)}</b> : ${(x.taches || []).map(esc).join(" · ")}`));
  const ris = (av.risques || []).map(x => line(fmtShort(x.date), `${esc(x.libelle)} <span class="muted">· ${esc(x.chantier)}</span>`));
  const rec = (av.recette || []).map(x => line("🧪", `<b>${esc(x.chantier)}</b> <span class="muted">en attente de recette</span>` +
    (x.depasse_j ? ` · <span class="bad-t">échéance dépassée depuis ${x.depasse_j} j</span>` : "") +
    (x.points ? ` · ${x.verifies}/${x.points} points vérifiés` : ` · <span class="bad-t">aucun point à vérifier</span>`) +
    (x.problemes ? ` · <span class="bad-t">${x.problemes} problème(s)</span>` : "")));
  const rap2 = (av.rappels || []).map(x => line(fmtShort(x.date), esc(x.label)));
  let h = `<div class="avenir-grid">`;
  h += box("Échéances de chantiers", ech, "Aucune échéance sous 3 semaines.");
  h += box("Jalons à franchir", jal, "Aucun jalon en attente.");
  h += box("Livrables attendus des autres", liv, "Rien d'attendu sous 3 semaines.");
  h += box("Prochaines tâches prêtes", pro, "Rien de prêt à démarrer.");
  if(rec.length) h += box("En attente de recette", rec, "");
  if(ris.length) h += box("Risques à revoir", ris, "");
  if(rap2.length) h += box("Rappels à échéance", rap2, "");
  h += `</div>`;
  return h;
}

function rapArchive(curSem){
  const list = rapports().slice().sort((a, b) => a.semaine < b.semaine ? 1 : -1);
  if(!list.length) return "";
  let h = dsection("Rapports archivés");
  h += `<table class="ptable"><thead><tr><th>Semaine</th><th>Période</th><th>Statut</th><th>Visa</th><th>Tâches</th><th>Retards</th><th>Temps</th><th></th></tr></thead><tbody>`;
  list.forEach(x => {
    const s = x.stats || {};
    h += `<tr${x.semaine === curSem ? ` class="rap-cur"` : ""}><td><b>${esc(x.semaine)}</b></td>` +
      `<td>${fmtShort(x.debut)} → ${fmtShort(x.fin)}</td>` +
      `<td><span class="rap-badge sm${x.statut === "finalise" ? " ok" : ""}">${x.statut === "finalise" ? "Finalisé" : "Brouillon"}</span></td>` +
      `<td>${x.statut === "finalise" && x.vise_par ? esc(x.vise_par) : `<span class="muted">—</span>`}</td>` +
      `<td>${s.taches || 0}</td>` +
      `<td>${s.retards ? `<b class="bad-t">${s.retards}</b>` : "0"}</td>` +
      `<td>${s.temps_min ? fmtDur(s.temps_min) : "—"}</td>` +
      `<td class="pacts"><a onclick="rapGoto('${x.debut}')">Ouvrir</a></td></tr>`;
  });
  h += `</tbody></table>`;
  return h;
}

function renderRapport(){
  if(!RAPPORT_MON) RAPPORT_MON = weekStart(TODAY);
  const mon = RAPPORT_MON, dim = addDays(mon, 6), sem = isoWeekStr(mon);
  const r = rapports().find(x => x.semaine === sem);
  const curMon = weekStart(TODAY);

  let h = `<div class="rap-top">`;
  h += `<div class="rap-nav"><button class="ghost" onclick="rapShift(-7)" title="Semaine précédente">‹</button>` +
       `<button class="ghost"${mon === curMon ? " disabled" : ""} onclick="RAPPORT_MON=null;renderRapport()">Cette semaine</button>` +
       `<button class="ghost" onclick="rapShift(7)" title="Semaine suivante">›</button></div>`;
  h += `<div><div class="d-status">Rapport hebdomadaire${mon === curMon ? "" : (mon < curMon ? " · semaine passée" : " · semaine future")}</div>` +
       `<h2 class="pg-title">Semaine ${+sem.split("-W")[1]} · du ${fmt(mon)} au ${fmt(dim)}</h2></div>`;
  h += `<div class="grow"></div>`;
  if(r){
    const fin = r.statut === "finalise";
    h += `<span class="rap-badge${fin ? " ok" : ""}">${fin ? "Finalisé" : "Brouillon"}</span>`;
    if(!fin) h += `<button class="ghost" title="Recalcule les faits (tâches, temps, notes, à venir…) sans toucher à ta rédaction" onclick="mutate({op:'rapport_generate',semaine:'${sem}'})">↻ Actualiser les données</button>`;
    h += fin ? `<button class="ghost" onclick="mutate({op:'rapport_reopen',rapport_id:'${r.id}'})">Rouvrir</button>`
             : `<button class="ghost primary" onclick="rapFinalize('${r.id}')">Finaliser</button>`;
    h += `<button class="ghost" onclick="rapportPrint('${r.id}')">Imprimer / PDF</button>`;
    if(fin) h += `<button class="ghost primary" onclick="rapportMail('${r.id}')" title="Génère le PDF et ouvre un brouillon Outlook avec la pièce jointe">✉ Envoyer par mail</button>`;
    h += `<span class="danger-link" onclick="rapDelete('${r.id}')">Supprimer</span>`;
  }
  h += `</div>`;

  if(!r){
    const vendredi = addDays(mon, 4), ouvert = TODAY >= vendredi;
    h += `<div class="cardx rap-emptycard"><div class="cardx-b">` +
      `<p><b>Aucun rapport pour cette semaine.</b></p>` +
      `<p class="muted">« Générer » construit le bilan automatiquement à partir de ce que l'appli sait déjà : tâches terminées, jalons franchis, notes de chantier, temps chronométré, relances, points de recette — plus le programme à venir (échéances, jalons, livrables attendus, risques à revoir, prochaines tâches). Il ne reste qu'à rédiger : synthèse, commentaire d'avancement par chantier, REX par point et REX général.</p>` +
      `<p class="muted">💡 Écris tes <b>notes</b> au fil de la semaine (bloc-notes, ou page chantier → « + note ») : rattachées à un chantier elles remontent dans son bilan, sans chantier elles figurent en « hors chantier ». Dans les deux cas elles gardent leur type et leur titre — ce sont des comptes rendus, pas des tâches.</p>` +
      (ouvert
        ? `<button class="btn primary" onclick="mutate({op:'rapport_generate',semaine:'${sem}'})">Générer le rapport de cette semaine</button>`
        : `<button class="btn" disabled title="Rituel du vendredi : le bilan s'établit en fin de semaine">Générer le rapport de cette semaine</button>` +
          `<div class="rap-verrou">🔒 Le bilan d'une semaine s'établit à partir de son <b>vendredi</b> — celui-ci s'ouvrira le ${fmt(vendredi)}. Les semaines passées restent générables (rattrapage).</div>`) +
      `</div></div>`;
    h += rapArchive(sem);
    $("rapport").innerHTML = h;
    return;
  }

  const dis = r.statut === "finalise";
  const st = r.stats || {};
  const retards = r.retards || [];
  const manq = retards.filter(x => !(x.justification || "").trim()).length;
  // Rapport d'une version précédente (avant Gantt / en cours / retards) : inviter à recalculer
  if(!dis && (st.en_cours == null || !(r.gantt || []).length || r.actions_faites == null))
    h += `<div class="rap-warnbanner">⚠ Ce rapport a été calculé avec une version précédente — clique <b>« ↻ Actualiser les données »</b> pour compléter : chantiers en cours, avancement global, Gantt, retards à justifier, actions et routines, notes non rattachées. Ta rédaction est conservée.</div>`;
  h += `<div class="kpis">` +
    kpi("Chantiers en cours", String(st.en_cours != null ? st.en_cours : "—"),
        `avancement global ${st.avancement != null ? st.avancement + " %" : "—"} · ${st.termines || 0} terminé(s) cette semaine${st.termines ? " 🏁" : ""}`, st.termines ? "good" : "") +
    kpi("Tâches terminées", String(st.taches || 0), `${st.jalons || 0} jalon(s) franchi(s)`, st.taches ? "good" : "") +
    kpi("Temps chronométré", st.temps_min ? fmtDur(st.temps_min) : "—",
        `${st.notes || 0} note(s) consignée(s) · ${st.journal != null ? st.journal : (st.actions || 0)} mouvement(s) journalisé(s)`) +
    kpi("Retards à justifier", String(retards.length), retards.length ? (manq ? `${manq} justification(s) manquante(s)` : "tout est justifié ✓") : "aucun retard 🎉", retards.length ? (manq ? "bad" : "good") : "good") + `</div>`;
  h += `<div class="muted small rap-maj">${r.cree_par ? `Établi par <b>${esc(r.cree_par)}</b>${r.cree_le ? ` le ${fmtDT(r.cree_le)}` : ""} · ` : ""}` +
       `${r.maj_le ? `données calculées le ${fmtDT(r.maj_le)} · ` : ""}` +
       (dis ? `<b>visé par ${esc(r.vise_par || "—")}</b> le ${fmtDT(r.finalise_le)} — données figées, rédaction verrouillée (« Rouvrir » pour modifier).`
            : `« ↻ Actualiser » recalcule les faits ; ta rédaction (synthèse, avancements, REX, justifications) n'est jamais écrasée.`) + `</div>`;

  if(retards.length){
    h += dsection(`Retards à justifier <span class="muted small">· obligatoire avant finalisation</span>`);
    retards.forEach(x => {
      const ok = (x.justification || "").trim();
      h += `<div class="cardx rap-late"><div class="cardx-h">` +
        `<span class="rap-pt-title"${chById(x.chantier_id) ? ` onclick="openChantier('${x.chantier_id}')"` : ""}>${esc(x.chantier)}</span>` +
        `<span class="muted rap-pt-meta">échéance ${fmt(x.echeance)} · <b class="bad-t">${x.jours} j de retard</b></span>` +
        `<span class="rap-chips">${ok ? `<span class="chip ok">✔ justifié</span>` : `<span class="chip late">à justifier</span>`}</span></div>` +
        `<div class="cardx-b">` +
        rapTA("Justification obligatoire : cause du retard, impact, plan de rattrapage, nouvelle date visée…",
              x.justification, `rapRetardField('${r.id}','${x.chantier_id}',this.value)`, dis) +
        `</div></div>`;
    });
  }

  h += dsection("Synthèse de la semaine");
  h += rapTA("Deux ou trois phrases pour la direction : l'essentiel de la semaine, les décisions prises, les alertes…",
             r.synthese, `rapField('${r.id}','synthese',this.value)`, dis);

  h += dsection(`Bilan par chantier <span class="muted small">· ${(r.points || []).length} point(s)</span>`);
  if(!(r.points || []).length)
    h += `<div class="empty">Aucune activité détectée cette semaine (tâche terminée, note, temps chronométré, relance ou retour de recette).</div>`;
  (r.points || []).forEach(p => { h += rapPointCard(r, p, dis); });
  if(!dis){
    const dans = new Set((r.points || []).map(p => p.chantier_id));
    const dispo = STORE.chantiers.filter(c => !dans.has(c.id));
    if(dispo.length){
      h += `<div class="rap-add"><select id="rapAddSel" class="sel">` +
        dispo.map(c => `<option value="${c.id}">${esc(c.titre)}</option>`).join("") +
        `</select> <button class="btn sm" onclick="mutate({op:'rapport_point_add',rapport_id:'${r.id}',chantier_id:document.getElementById('rapAddSel').value})">+ Ajouter ce chantier au rapport</button></div>`;
    }
  }

  h += rapHorsChantier(r, dis);

  h += dsection(`Programmé pour la suite <span class="muted small">· jusqu'au ${fmt(addDays(dim, 14))}</span>`);
  h += rapAvenir(r);
  h += `<div class="cardx rap-blk"><div class="cardx-h">Priorités de la semaine prochaine</div><div class="cardx-b">` +
       rapTA("Les 3 à 5 priorités que tu annonces pour la semaine à venir…", r.priorites,
             `rapField('${r.id}','priorites',this.value)`, dis) + `</div></div>`;

  h += dsection("REX général de la semaine");
  const rg = r.rex_general || {};
  h += `<div class="rex-grid">` +
    `<div class="cardx"><div class="cardx-h rex-plus">✚ Ce qui a bien fonctionné</div><div class="cardx-b">` +
      rapTA("Pratiques à garder, réussites, bonnes surprises…", rg.positif, `rapField('${r.id}','rex_positif',this.value)`, dis) + `</div></div>` +
    `<div class="cardx"><div class="cardx-h rex-minus">− Ce qui a coincé</div><div class="cardx-b">` +
      rapTA("Frictions, pertes de temps, blocages, mauvaises surprises…", rg.negatif, `rapField('${r.id}','rex_negatif',this.value)`, dis) + `</div></div>` +
    `<div class="cardx"><div class="cardx-h rex-act">➜ Actions d'amélioration</div><div class="cardx-b">` +
      rapTA("Ce qu'on change dès lundi : qui, quoi, quand…", rg.actions, `rapField('${r.id}','rex_actions',this.value)`, dis) + `</div></div>` +
    `</div>`;

  h += rapArchive(sem);
  $("rapport").innerHTML = h;
}

// ---- Document imprimable (→ PDF via le navigateur) : le livrable à envoyer.
const GANTT_COL = {doing: "#2563eb", recette: "#7c3aed", todo: "#94a3b8", done: "#10b981"};
const MOIS_C = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
function moisSuivant(iso){   // 1er jour du mois suivant "YYYY-MM-DD"
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
// Gantt global CSS pur (imprimable) : chaque chantier = une barre datée, la
// semaine du rapport est surlignée, les retards sont cerclés de rouge.
function rapGanttHTML(r){
  const rows = r.gantt || [];
  if(!rows.length) return "";
  let lo = r.debut, hi = addDays(r.fin, 14);
  rows.forEach(g => { if(g.debut < lo) lo = g.debut; if(g.fin > hi) hi = g.fin; });
  const capLo = addDays(r.debut, -70), capHi = addDays(r.fin, 70);   // borne l'axe (~5 mois max)
  if(lo < capLo) lo = capLo;
  if(hi > capHi) hi = capHi;
  const span = Math.max(1, daysBetween(lo, hi));
  const pos = d => Math.max(0, Math.min(100, daysBetween(lo, d < lo ? lo : d) / span * 100));
  const weekL = pos(r.debut), weekW = Math.max(0.5, pos(addDays(r.fin, 1)) - weekL);
  // axe : un repère au 1er de chaque mois
  let ticks = "", mt = moisSuivant(lo.slice(0, 8) + "01");
  if(lo.slice(8, 10) === "01") mt = lo;
  for(; mt <= hi; mt = moisSuivant(mt))
    ticks += `<span class="gtick" style="left:${pos(mt)}%">${MOIS_C[+mt.slice(5, 7) - 1]}</span>`;
  let h = `<div class="grow2"><span class="gname"></span><div class="gaxis">${ticks}</div><span class="gpct"></span></div>`;
  rows.forEach(g => {
    const l = pos(g.debut), w = Math.max(1, pos(g.fin) - l);
    const col = GANTT_COL[g.statut] || "#94a3b8";
    h += `<div class="grow2"><span class="gname" title="${esc(g.chantier)}">${esc(g.chantier)}</span>` +
      `<div class="gtrack"><span class="gweek" style="left:${weekL}%;width:${weekW}%"></span>` +
      `<span class="gbar${g.late ? " glate" : ""}" style="left:${l}%;width:${w}%;background:${col}"></span></div>` +
      `<span class="gpct">${g.pct != null ? g.pct + " %" : ""}${g.late ? ` <b class="lt2">retard</b>` : ""}${g.sans_echeance ? " (sans éch.)" : ""}</span></div>`;
  });
  h += `<div class="gleg"><span><i style="background:${GANTT_COL.doing}"></i> en cours</span>` +
    `<span><i style="background:${GANTT_COL.recette}"></i> en recette</span>` +
    `<span><i style="background:${GANTT_COL.todo}"></i> à faire</span>` +
    `<span><i style="background:${GANTT_COL.done}"></i> terminé</span>` +
    `<span><i class="gleg-late"></i> en retard</span>` +
    `<span><i class="gleg-week"></i> semaine du rapport</span></div>`;
  return h;
}
// Barres « part du temps de la semaine par chantier » — en POURCENTAGE du temps
// total chronométré (le reste — réunions, RDV, divers — apparaît en « hors chantier »).
function rapTempsHTML(r){
  const total = (r.stats || {}).temps_min || 0;
  if(!total) return "";
  const tp = (r.points || []).map(p => ({n: p.chantier, m: (p.auto || {}).temps_min || 0}))
    .filter(x => x.m > 0).sort((a, b) => b.m - a.m).slice(0, 10);
  if(!tp.length) return "";
  const reste = total - tp.reduce((a, x) => a + x.m, 0);
  if(reste > total * 0.02) tp.push({n: "Hors chantier (réunions, RDV, divers)", m: reste, off: true});
  const mx = Math.max(...tp.map(x => x.m));
  const pc = m => Math.round(100 * m / total);
  return tp.map(x =>
    `<div class="grow2"><span class="gname" title="${esc(x.n)}">${esc(x.n)}</span>` +
    `<div class="gtrack tbar"><span class="gbar" style="left:0;width:${Math.max(1.5, x.m / mx * 100)}%;background:${x.off ? "#94a3b8" : "#2563eb"}"></span></div>` +
    `<span class="gpct"><b>${pc(x.m)} %</b> du temps</span></div>`).join("");
}
// Donut « répartition du temps par type » (conic-gradient, imprimable) :
// tâches planifiées / routines / recette / libre (réunions, RDV ajoutés à la main).
const RAP_KIND_LBL = {tache: "Tâches des chantiers", action: "Actions & routines", recette: "Recette / tests", libre: "Libre (réunions, RDV…)"};
const RAP_KIND_COL = {tache: "#2563eb", action: "#d97706", recette: "#7c3aed", libre: "#94a3b8"};
function rapDonutHTML(r){
  const st = r.stats || {}, kinds = st.temps_kinds || {}, total = st.temps_min || 0;
  const rows = ["tache", "action", "recette", "libre"].map(k => ({k, m: kinds[k] || 0})).filter(x => x.m > 0);
  if(!total || !rows.length) return "";
  rows.sort((a, b) => b.m - a.m);
  let acc = 0;
  const stops = rows.map(x => {
    const from = acc / total * 100, to = (acc + x.m) / total * 100;
    acc += x.m;
    return `${RAP_KIND_COL[x.k]} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
  }).join(", ");
  const leg = rows.map(x =>
    `<div class="dlegrow"><i style="background:${RAP_KIND_COL[x.k]}"></i>${RAP_KIND_LBL[x.k] || x.k}` +
    `<b>${Math.round(100 * x.m / total)} %</b></div>`).join("");
  return `<div class="donutwrap"><div class="donut" style="background:conic-gradient(${stops})"><i>${fmtDur(total)}</i></div>` +
    `<div class="dleg">${leg}</div></div>`;
}
// Bloc « compte rendu » du document imprimable : un encadré, pas une puce de liste.
function docNote(n){
  const k = ntKind(n);
  const corps = ((n.t != null ? n.t : n.corps) || "").trim();
  const d = n.d || n.date || "", hh = n.h || n.heure || "";
  return `<div class="note"><div class="noteh"><span class="fk fkn">${esc(k.lbl)}</span>` +
    (n.titre ? `<b>${esc(n.titre)}</b>` : "") +
    `<span class="d">${d ? fmt(d) : ""}${hh ? " · " + hh : ""}</span></div>` +
    (corps ? `<div class="notec">${esc(corps)}</div>` : "") + `</div>`;
}

function rapportDocHTML(r){
  const st = r.stats || {}, rg = r.rex_general || {}, av = r.avenir || {};
  const para = t => `<div class="txt">${esc(t).replace(/\n/g, "<br>")}</div>`;
  const num = +r.semaine.split("-W")[1];
  const finalise = r.statut === "finalise";
  const termineIds = new Set((r.termines || []).map(x => x.chantier_id));

  // — bilan par chantier : avancement/durée bien visibles dans l'en-tête —
  let pts = "";
  (r.points || []).forEach(p => {
    const a = p.auto || {}, enc = a.en_cours || [];
    const late = !termineIds.has(p.chantier_id) && a.statut !== "recette" && a.statut !== "done"
                 && a.echeance && a.echeance < TODAY;
    const faits = [
      ...(a.taches || []).map(t => `<li><span class="fk${t.jalon ? " fkj" : ""}">${t.jalon ? "Jalon" : "Tâche"}</span>${esc(t.label)} <span class="d">${fmtShort(t.date)}</span></li>`),
      ...(a.recette || []).map(x => `<li><span class="fk fkr">Recette</span>${esc(x.quoi)} <span class="d">${x.statut === "ok" ? "vérifié" : "problème"}</span></li>`),
    ].join("");
    // Les notes ne sont pas des lignes de « fait » : un compte rendu garde son
    // type, son titre et ses paragraphes.
    const notes = (a.notes || []).map(docNote).join("");
    const badge = termineIds.has(p.chantier_id) ? `<span class="tag tdone">Terminé cette semaine</span>`
                : late ? `<span class="tag tlate">En retard</span>` : "";
    pts += `<div class="pt"><h2><span class="ptitle">${esc(p.chantier)}</span>${badge}` +
      `<span class="plab">avancement</span><span class="pbar"><i style="width:${a.pct || 0}%"></i></span><span class="ppct">${a.pct != null ? a.pct + " %" : ""}</span></h2>` +
      `<div class="pmeta">${[RAP_ST_LBL[a.statut] || "",
                            a.temps_min ? `${fmtDur(a.temps_min)} passées cette semaine` : "",
                            a.echeance ? `échéance ${fmt(a.echeance)}` : ""].filter(Boolean).join(" · ")}</div>` +
      (enc.length ? `<div class="enc"><b>En ce moment&nbsp;:</b> ${enc.map(t => `${esc(t.label)}${t.depuis ? ` <span class="d">(depuis le ${fmtShort(t.depuis)})</span>` : ""}`).join(" · ")}</div>` : "") +
      (faits ? `<ul class="faits">${faits}</ul>` : "") +
      (notes ? `<div class="sub4">Notes &amp; comptes rendus</div>${notes}` : "") +
      ((p.avancement || "").trim() ? `<div class="blk"><b>Avancement</b>${para(p.avancement)}</div>` : "") +
      ((p.rex || "").trim() ? `<div class="blk rex"><b>REX</b>${para(p.rex)}</div>` : "") + `</div>`;
  });

  // — retards : tableau justifications (obligatoires) —
  const retards = r.retards || [];
  const retH = retards.length
    ? `<table class="rtable"><thead><tr><th>Chantier</th><th>Échéance</th><th>Retard</th><th>Justification</th></tr></thead><tbody>` +
      retards.map(x => `<tr><td><b>${esc(x.chantier)}</b></td><td>${fmt(x.echeance)}</td>` +
        `<td class="lt">${x.jours} j</td><td>${(x.justification || "").trim() ? esc(x.justification).replace(/\n/g, "<br>") : `<i class="mq">à justifier</i>`}</td></tr>`).join("") +
      `</tbody></table>` : "";

  const termH = (r.termines || []).length
    ? `<ul>${r.termines.map(x => `<li><b>${esc(x.chantier)}</b> — terminé le ${fmt(x.date)}</li>`).join("")}</ul>` : "";

  // chaque famille a son sous-titre (échéances, jalons, attentes, recettes…)
  const avSec = (titre, rows) => rows.length ? `<div class="sub4">${titre}</div><ul>${rows.join("")}</ul>` : "";
  const avH = [
    avSec("Échéances de chantiers", (av.echeances || []).map(x => `<li>${fmt(x.date)} — <b>${esc(x.chantier)}</b>${x.late ? ` <span class="lt2">en retard</span>` : ""}</li>`)),
    avSec("Jalons à franchir", (av.jalons || []).map(x => `<li><span class="fk fkj">Jalon</span>${esc(x.label)} — <b>${esc(x.chantier)}</b></li>`)),
    avSec("Livrables attendus des autres", (av.livrables || []).map(x => `<li>${fmt(x.date)} — ${esc(x.quoi)} <span class="d">(${esc(x.personne)} · ${esc(x.chantier)})</span>${x.late ? ` <span class="lt2">en retard</span>` : ""}</li>`)),
    avSec("Prochaines tâches prêtes à démarrer", (av.prochaines || []).map(x => `<li><b>${esc(x.chantier)}</b> : ${(x.taches || []).map(esc).join(" · ")}</li>`)),
    avSec("En attente de recette", (av.recette || []).map(x => `<li><b>${esc(x.chantier)}</b>` +
      (x.depasse_j ? ` — <span class="lt2">échéance dépassée depuis ${x.depasse_j} j</span>` : "") +
      (x.points ? ` — ${x.verifies}/${x.points} points vérifiés` : "") +
      (x.problemes ? ` — <span class="lt2">${x.problemes} problème(s)</span>` : "") + `</li>`)),
    avSec("Risques à revoir", (av.risques || []).map(x => `<li>${fmt(x.date)} — ${esc(x.libelle)} <span class="d">(${esc(x.chantier)})</span></li>`)),
  ].filter(Boolean).join("");
  const rexG = [["Points positifs — ce qui a bien fonctionné", rg.positif],
                ["Points de friction — ce qui a coincé", rg.negatif],
                ["Actions d'amélioration", rg.actions]]
    .filter(([, v]) => (v || "").trim())
    .map(([t, v]) => `<div class="blk"><b>${t}</b>${para(v)}</div>`).join("");
  // — hors chantier : temps, actions terminées, routines tenues, notes libres —
  const hc = r.hors_chantier || [], af = r.actions_faites || [],
        rt = r.routines_tenue || [], nl = r.notes_libres || [];
  const horsH = (hc.length || af.length || rt.length || nl.length)
    ? `<h3 class="sec">Hors chantier — actions, routines, réunions, notes</h3>` +
      (af.length ? `<div class="sub4">Actions terminées</div><ul class="faits">` +
        af.map(x => `<li><span class="fk">Action</span>${esc(x.label)} <span class="d">${fmt(x.date)}</span></li>`).join("") + `</ul>` : "") +
      (rt.length ? `<div class="sub4">Tenue des routines</div><ul class="faits">` +
        rt.map(x => `<li><span class="fk${x.faits < x.total ? " fkl" : ""}">${x.faits}/${x.total}</span>${esc(x.label)}` +
          (x.rates ? ` <span class="lt2">${x.rates} manquée(s)</span>` : "") + `</li>`).join("") + `</ul>` : "") +
      (hc.length ? `<div class="sub4">Temps hors chantier</div><ul class="faits">` +
        hc.map(x => `<li><span class="fk">${x.kind === "action" ? "Action" : "Libre"}</span>${esc(x.label)}` +
          ` <span class="d">${fmtDur(x.temps_min)} · ${(x.jours || []).map(fmtShort).join(", ")}</span></li>`).join("") + `</ul>` : "") +
      (nl.length ? `<div class="sub4">Notes non rattachées à un chantier</div>` + nl.map(docNote).join("") : "")
    : "";
  const gantt = rapGanttHTML(r), temps = rapTempsHTML(r), donut = rapDonutHTML(r);
  const tempsSec = (donut || temps)
    ? `<h3 class="sec">Répartition du temps de la semaine</h3><div class="tflex">` +
      (donut ? `<div class="tcol tcol-d"><div class="sub4">Par type d'activité</div>${donut}</div>` : "") +
      (temps ? `<div class="tcol"><div class="sub4">Par chantier — part du temps total</div>${temps}</div>` : "") +
      `</div>` : "";

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Rapport hebdomadaire — S${num}</title>` +
    `<style>@page{margin:1.8cm}` +
    `body{font-family:Inter,"Segoe UI",Arial,sans-serif;color:#111;line-height:1.5;max-width:880px;margin:0 auto;padding:24px;` +
    `-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    `h1{font-size:22px;margin:0 0 2px;letter-spacing:-.02em}` +
    `.hdr{display:flex;align-items:flex-start;gap:16px;margin-bottom:8px}` +
    `.hdr>div:first-child{flex:1}` +
    `.ovl{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:#666;margin-bottom:4px}` +
    `.sub1{font-size:12.5px;color:#444;font-weight:600}` +
    `.hst{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:6px 14px;` +
    `border:2px solid;border-radius:6px;margin-top:6px}` +
    `.hst.hok{color:#065f46;border-color:#065f46;background:#ecfdf5}` +
    `.hst.hdr2{color:#92400e;border-color:#b45309;background:#fffbeb}` +
    `.meta0{color:#555;font-size:11.5px;margin-bottom:14px;border-bottom:2px solid #111;padding-bottom:10px}` +
    `.fk{display:inline-block;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;` +
    `color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:3px;padding:1px 6px;` +
    `margin-right:7px;vertical-align:1px;min-width:36px;text-align:center}` +
    `.fk.fkj{color:#92400e;background:#fef3c7;border-color:#fde68a}` +
    `.fk.fkn{color:#1e40af;background:#eff6ff;border-color:#bfdbfe}` +
    `.fk.fkr{color:#5b21b6;background:#f5f3ff;border-color:#ddd6fe}` +
    `.fk.fkl{color:#991b1b;background:#fef2f2;border-color:#fecaca}` +
    `.note{border-left:3px solid #bfdbfe;background:#f8fafc;padding:5px 10px;margin:4px 0 6px;page-break-inside:avoid}` +
    `.noteh{display:flex;align-items:baseline;gap:7px;font-size:12px}` +
    `.noteh .d{margin-left:auto;white-space:nowrap}` +
    `.notec{white-space:pre-wrap;font-size:11.5px;color:#333;line-height:1.45;margin-top:3px}` +
    `.foot{margin-top:14px;font-size:10px;color:#999;text-align:center}` +
    `.kband{display:flex;gap:8px;margin:12px 0 18px}` +
    `.kband>span{flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;font-size:11px;color:#555}` +
    `.kband b{font-size:18px;display:block;color:#111;font-variant-numeric:tabular-nums}` +
    `.kband .warn b{color:#dc2626}` +
    `h2{font-size:14px;margin:14px 0 2px;border-bottom:1px solid #e5e7eb;padding-bottom:3px;display:flex;align-items:center;gap:8px}` +
    `h2 .ptitle{flex-shrink:1}` +
    `h3.sec{font-size:11.5px;text-transform:uppercase;letter-spacing:.6px;margin:20px 0 6px;color:#333;` +
    `border-left:3px solid #111;padding-left:8px}` +
    `.plab{font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:#888;font-weight:600;margin-left:auto}` +
    `.pbar{flex:1;min-width:60px;max-width:160px;height:7px;background:#eef2f7;border-radius:4px;overflow:hidden}` +
    `.pbar i{display:block;height:100%;background:#10b981}` +
    `.ppct{font-size:11px;color:#333;font-weight:600;min-width:34px;text-align:right}` +
    `.sub4{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#374151;margin:10px 0 3px}` +
    `.lt2{color:#dc2626;font-weight:700;font-size:11px}` +
    `.tflex{display:flex;gap:26px;align-items:flex-start}` +
    `.tcol{flex:1;min-width:0}.tcol-d{flex:0 0 300px}` +
    `.donutwrap{display:flex;gap:14px;align-items:center;margin-top:6px}` +
    `.donut{position:relative;width:120px;height:120px;border-radius:50%;flex-shrink:0}` +
    `.donut i{position:absolute;inset:26px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;` +
    `font-style:normal;font-size:12px;font-weight:700;color:#333}` +
    `.dleg{font-size:11px;color:#333}` +
    `.dlegrow{display:flex;align-items:center;gap:6px;margin:3px 0;white-space:nowrap}` +
    `.dlegrow i{width:10px;height:10px;border-radius:3px;flex-shrink:0}` +
    `.dlegrow b{margin-left:6px;font-variant-numeric:tabular-nums}` +
    `.pmeta{font-size:11.5px;color:#555;margin:2px 0 4px;font-weight:600}` +
    `.enc{font-size:12px;background:#eff6ff;border-left:3px solid #2563eb;padding:5px 9px;margin:4px 0}` +
    `.tag{font-size:10px;font-weight:700;padding:2px 7px;border-radius:9px;white-space:nowrap}` +
    `.tag.tdone{background:#d1fae5;color:#065f46}.tag.tlate{background:#fee2e2;color:#991b1b}` +
    `.txt{white-space:pre-wrap;font-size:12.5px;margin:2px 0 6px}.blk{margin:6px 0}` +
    `.blk.rex .txt{background:#f6f6f4;padding:6px 10px;border-left:3px solid #bbb}` +
    `ul{margin:4px 0 8px;padding-left:20px;font-size:12px}ul.faits{list-style:none;padding-left:4px}` +
    `.d{color:#888;font-size:10.5px}.pt{page-break-inside:avoid}` +
    `.grow2{display:flex;align-items:center;gap:7px;margin:2.5px 0}` +
    `.gname{width:200px;font-size:10px;text-align:right;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}` +
    `.gtrack{position:relative;flex:1;height:12px;background:#f1f5f9;border-radius:3px}` +
    `.gtrack.tbar{background:#f8fafc}` +
    `.gweek{position:absolute;top:-2px;bottom:-2px;background:rgba(37,99,235,.09);border-left:1px solid rgba(37,99,235,.35);border-right:1px solid rgba(37,99,235,.35)}` +
    `.gbar{position:absolute;top:2px;bottom:2px;border-radius:3px;min-width:2px}` +
    `.gbar.glate{box-shadow:0 0 0 1.5px #dc2626}` +
    `.gpct{width:68px;font-size:9.5px;color:#555;flex-shrink:0}` +
    `.gaxis{position:relative;flex:1;height:13px}` +
    `.gtick{position:absolute;top:0;font-size:9px;color:#999;border-left:1px solid #ddd;padding-left:3px;height:13px}` +
    `.gleg{display:flex;gap:14px;font-size:10px;color:#555;margin:8px 0 0 207px;flex-wrap:wrap}` +
    `.gleg i{display:inline-block;width:14px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}` +
    `.gleg-late{box-shadow:0 0 0 1.5px #dc2626;background:#fff!important}` +
    `.gleg-week{background:rgba(37,99,235,.15)!important;border:1px solid rgba(37,99,235,.4)}` +
    `.rtable{border-collapse:collapse;width:100%;font-size:11.5px;margin:4px 0 8px}` +
    `.rtable th{text-align:left;background:#f8fafc;border:1px solid #e2e8f0;padding:5px 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:#334155}` +
    `.rtable td{border:1px solid #e5e7eb;padding:5px 8px;vertical-align:top}` +
    `.rtable .lt{color:#dc2626;font-weight:700;white-space:nowrap}.mq{color:#dc2626}` +
    `.visa{display:flex;gap:24px;margin-top:26px;padding-top:12px;border-top:2px solid #111;font-size:12px}` +
    `.visa>div{flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;min-height:58px}` +
    `.visa .vt{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#666;margin-bottom:4px}` +
    `.draft{color:#b45309;font-weight:700}` +
    `</style></head><body>` +
    `<div class="hdr"><div>` +
    `<div class="ovl">Suivi des chantiers · Pilotage hebdomadaire</div>` +
    `<h1>Rapport hebdomadaire — Semaine ${num}</h1>` +
    `<div class="sub1">Du ${fmt(r.debut)} au ${fmt(r.fin)}</div></div>` +
    `<div class="hst ${finalise ? "hok" : "hdr2"}">${finalise ? "Finalisé" : "Brouillon"}</div></div>` +
    `<div class="meta0">${r.cree_par ? `Établi par ${esc(r.cree_par)}${r.cree_le ? ` le ${fmtDT(r.cree_le)}` : ""}` : ""}` +
    `${r.maj_le ? ` · données du ${fmtDT(r.maj_le)}` : ""}` +
    `${finalise && r.vise_par ? ` · <b>visé par ${esc(r.vise_par)} le ${fmtDT(r.finalise_le)}</b>` : ""}</div>` +
    `<div class="kband">` +
    `<span><b>${st.en_cours != null ? st.en_cours : "—"}</b>chantiers en cours</span>` +
    `<span><b>${st.avancement != null ? st.avancement + " %" : "—"}</b>avancement global (en cours)</span>` +
    `<span><b>${st.termines || 0}</b>terminés cette semaine</span>` +
    `<span><b>${st.taches || 0}</b>tâches finies · ${st.jalons || 0} jalon(s)</span>` +
    `<span><b>${st.temps_min ? fmtDur(st.temps_min) : "—"}</b>temps chronométré</span>` +
    `<span${retards.length ? ` class="warn"` : ""}><b>${retards.length}</b>retard(s) justifié(s)</span>` +
    `</div>` +
    ((r.synthese || "").trim() ? `<h3 class="sec">Synthèse</h3>${para(r.synthese)}` : "") +
    (gantt ? `<h3 class="sec">Vue d'ensemble du portefeuille — Gantt</h3>${gantt}` : "") +
    tempsSec +
    (termH ? `<h3 class="sec">Chantiers terminés cette semaine</h3>${termH}` : "") +
    (retH ? `<h3 class="sec">Retards et justifications</h3>${retH}` : "") +
    `<h3 class="sec">Bilan par chantier</h3>` + (pts || `<div class="txt">Aucune activité détectée cette semaine.</div>`) +
    horsH +
    (avH ? `<h3 class="sec">Programmé pour la suite</h3>${avH}` : "") +
    ((r.priorites || "").trim() ? `<h3 class="sec">Priorités de la semaine prochaine</h3>${para(r.priorites)}` : "") +
    (rexG ? `<h3 class="sec">REX général</h3>${rexG}` : "") +
    `<div class="visa">` +
    `<div><div class="vt">Établi par</div>${r.cree_par ? `<b>${esc(r.cree_par)}</b>` : "________________"}` +
    `${r.cree_le ? `<br><span class="d">le ${fmtDT(r.cree_le)}</span>` : ""}</div>` +
    `<div><div class="vt">Visé (finalisé) par</div>${finalise && r.vise_par ? `<b>${esc(r.vise_par)}</b>` : "________________"}` +
    `${finalise && r.finalise_le ? `<br><span class="d">le ${fmtDT(r.finalise_le)}</span>` : ""}</div>` +
    `</div>` +
    `<div class="foot">Rapport généré depuis l'application Suivi des chantiers${r.maj_le ? ` — données du ${fmtDT(r.maj_le)}` : ""}</div>` +
    `</body></html>`;
}
function rapportPrint(rid){
  const r = rapports().find(x => x.id === rid); if(!r) return;
  const w = window.open("", "_blank");
  if(!w){ alert("Autorise les pop-ups pour imprimer / exporter en PDF."); return; }
  w.document.write(rapportDocHTML(r)); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch(e){} }, 350);
}

// Envoi par e-mail : le serveur convertit le document en PDF (Edge headless),
// l'archive dans data/rapports/ puis ouvre un brouillon Outlook pièce jointe.
let RAP_MAIL_BUSY = false;
async function rapportMail(rid){
  const r = rapports().find(x => x.id === rid); if(!r) return;
  if(r.statut !== "finalise"){
    alert("Finalise d'abord le rapport — c'est la version finale, visée, qui part par mail.");
    return;
  }
  if(RAP_MAIL_BUSY) return;
  RAP_MAIL_BUSY = true;
  try{
    const d = await api("POST", "/api/rapport_mail", {rapport_id: rid, html: rapportDocHTML(r)});
    alert(d.message || "E-mail préparé.");
  }catch(e){ /* bandeau de connexion déjà affiché par api() */ }
  finally{ RAP_MAIL_BUSY = false; }
}

// ======================================================================== //
//  Cahier des charges — document libre + révisions (indices) + validation
// ======================================================================== //
let CUR_CDC = null;   // id du chantier dont le CdC est ouvert dans l'éditeur
const CDC_ST = {
  brouillon:     {lbl: "Brouillon",     cls: "cdc-draft"},
  en_validation: {lbl: "En validation", cls: "cdc-review"},
  valide:        {lbl: "Validé",        cls: "cdc-valid"},
  obsolete:      {lbl: "Obsolète",      cls: "cdc-obsolete"},
};
const CDC_STATUTS_ARR = [["brouillon", "Brouillon"], ["en_validation", "En validation"],
                         ["valide", "Validé"], ["obsolete", "Obsolète"]];

function openCdc(cid){ CUR_CDC = cid; showView("cdc"); window.scrollTo(0, 0); }
function backFromCdc(){ if(CUR_CDC) openChantier(CUR_CDC); else setView("cahiers"); }

// Carte de synthèse affichée sur la page chantier
function cdcSummary(c){
  if(!c.cdc)
    return `<div class="empty">Aucun cahier des charges.</div>` +
      `<button class="btn sm primary" onclick="cdcCreate('${c.id}')">+ Créer le cahier des charges</button>`;
  const cdc = c.cdc, st = CDC_ST[cdc.statut] || CDC_ST.brouillon;
  let h = `<div class="cdc-sum"><span class="cdc-badge ${st.cls}">${st.lbl}</span> ` +
    `<span class="muted">indice ${esc(cdc.indice)} · maj ${fmt(cdc.date_maj)}</span></div>`;
  if(cdc.reference) h += `<div class="kv"><span class="k">Réf.</span><span class="v">${esc(cdc.reference)}</span></div>`;
  if(cdc.statut === "valide" && cdc.date_validation)
    h += `<div class="kv"><span class="k">Validé</span><span class="v">${fmt(cdc.date_validation)}${cdc.valide_par ? ` · ${esc(cdc.valide_par)}` : ""}</span></div>`;
  if(cdc.parties_prenantes.length)
    h += `<div class="kv"><span class="k">Parties</span><span class="v">${cdc.parties_prenantes.length} partie(s) prenante(s)</span></div>`;
  h += `<button class="btn sm primary" onclick="openCdc('${c.id}')">Ouvrir le cahier des charges</button>`;
  return h;
}

function cdcHeader(c, cdc){
  let h = `<div class="cdc-top">`;
  h += `<button class="ghost" onclick="backFromCdc()" title="Revenir à « ${esc(c.titre)} »">← Chantier</button>`;
  h += `<div class="cdc-toptitle"><div class="d-status">Cahier des charges</div>` +
       `<h2 class="pg-title">${esc((cdc && cdc.titre) || c.titre)}</h2></div>`;
  h += `<div class="grow"></div>`;
  if(cdc){
    h += `<button class="ghost" onclick="cdcRevise('${c.id}')" title="Figer l'indice courant et passer à l'indice suivant (la validation est réinitialisée)">Émettre une révision</button>`;
    h += `<button class="ghost" onclick="cdcPrint()" title="Imprimer ou enregistrer en PDF">Imprimer / PDF</button>`;
    h += `<button class="ghost" onclick="cdcWord('${c.id}')" title="Télécharger le cahier des charges en Word pour le retoucher">Word</button>`;
    h += `<button class="ghost" onclick="$('cdcDocx').click()" title="Relire un .docx modifié : le contenu revient ici et le changement est tracé comme une révision">Réimporter Word</button>`;
    h += `<button class="ghost" onclick="cdcMail('${c.id}')" title="Ouvrir un brouillon e-mail avec le Word en pièce jointe et un message de demande de validation">Envoyer</button>`;
    h += `<input type="file" id="cdcDocx" accept=".docx" style="display:none" onchange="cdcImportWord(this,'${c.id}')">`;
    h += `<span class="danger-link" onclick="cdcDelete('${c.id}')">Supprimer</span>`;
  }
  h += `</div>`;
  return h;
}

// ---- aller-retour Word ---------------------------------------------------
// Le .docx porte l'identifiant du chantier et ceux des sections dans ses
// proprietes de document : au retour, le texte retombe au bon endroit meme si
// les titres ont bouge. Un import qui change quelque chose emet une revision.
function cdcWord(cid){
  window.location = "/api/cdc_docx?chantier_id=" + encodeURIComponent(cid);
}
async function cdcMail(cid){
  const d = await api("POST", "/api/cdc_mail", {chantier_id: cid});
  alert(d.message || d.error || "Terminé.");
}
function cdcImportWord(input, cid){
  const file = input.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const d = await api("POST", "/api/cdc_import", {b64: reader.result, chantier_id: cid});
    input.value = "";
    if(d.error){ alert(d.error); return; }
    STORE = d.store; TODAY = d.today;
    alert(d.message || "Cahier des charges réimporté.");
    renderCdc();
  };
  reader.readAsDataURL(file);
}

function cdcInput(c, field, label, val, ph, full){
  return `<label class="cdc-f${full ? " full" : ""}"><span class="cdc-fl">${label}</span>` +
    `<input value="${esc(val || "")}" placeholder="${esc(ph || "")}" onblur="cdcField('${c.id}','${field}',this.value)"></label>`;
}

function renderCdc(){
  const c = chById(CUR_CDC);
  if(!c){ setView("cahiers"); return; }
  if(!c.cdc){
    $("cdc").innerHTML = cdcHeader(c, null) +
      `<div class="cdc-doc"><div class="cdc-card"><div class="empty">Ce chantier n'a pas encore de cahier des charges.</div>` +
      `<button class="btn primary" onclick="cdcCreate('${c.id}')">+ Créer le cahier des charges</button></div></div>`;
    return;
  }
  const cdc = c.cdc, st = CDC_ST[cdc.statut] || CDC_ST.brouillon;
  let h = cdcHeader(c, cdc);
  h += `<div class="cdc-doc">`;

  // En-tête de document : méta + validation
  h += `<div class="cdc-card"><div class="cdc-fields">`;
  h += cdcInput(c, "reference", "Référence", cdc.reference, "ex. CDC-2026-001");
  h += cdcInput(c, "redacteur", "Rédigé par", cdc.redacteur, "");
  h += cdcInput(c, "titre", "Titre du document", cdc.titre, "", true);
  h += cdcInput(c, "lien", "Lien du document maître (Word/PDF, SharePoint, réseau…)", cdc.lien, "https://…  ou  \\\\serveur\\partage\\…", true);
  h += `</div>`;

  h += `<div class="cdc-valid-block">`;
  h += `<div class="cdc-vrow"><span class="cdc-badge ${st.cls} big">${st.lbl}</span>` +
       `<label class="lab">Statut</label><select class="sel" onchange="cdcStatut('${c.id}',this.value)">` +
       CDC_STATUTS_ARR.map(([k, l]) => `<option value="${k}" ${cdc.statut === k ? "selected" : ""}>${l}</option>`).join("") + `</select>` +
       `<span class="muted">indice ${esc(cdc.indice)} · mis à jour le ${fmt(cdc.date_maj)}</span></div>`;
  if(cdc.statut === "valide"){
    h += `<div class="cdc-vrow"><label class="lab">Validé par</label>` +
      `<input value="${esc(cdc.valide_par || "")}" placeholder="nom / instance" onblur="cdcField('${c.id}','valide_par',this.value)">` +
      `<label class="lab">le</label><input type="date" value="${cdc.date_validation || ""}" onchange="cdcField('${c.id}','date_validation',this.value)"></div>`;
  }
  h += `<div class="cdc-pp"><div class="lab">Parties prenantes <span class="add" onclick="cdcAddPartie('${c.id}')">+ ajouter</span></div>`;
  h += (cdc.parties_prenantes.length ? cdc.parties_prenantes.map(pp =>
      `<div class="row-line"><span>${esc(pp.nom)}${pp.role ? ` <span class="muted">· ${esc(pp.role)}</span>` : ""}</span>` +
      `<span class="del" onclick="mutate({op:'cdc_partie_remove',chantier_id:'${c.id}',partie_id:'${pp.id}'})">×</span></div>`).join("")
      : `<div class="empty">Personne pour l'instant.</div>`);
  h += `</div></div>`;   // cdc-pp + cdc-valid-block
  h += `</div>`;         // cdc-card

  // Document libre : sections rédigeables
  h += `<div class="cdc-sections">`;
  cdc.sections.forEach((sec, i) => {
    h += `<section class="cdc-sec">` +
      `<div class="cdc-sec-h"><span class="cdc-sec-n">${i + 1}.</span>` +
      `<input class="cdc-sec-titre" value="${esc(sec.titre)}" placeholder="Titre de la section" onblur="cdcSectionField('${c.id}','${sec.id}','titre',this.value)">` +
      `<span class="cdc-sec-acts"><a onclick="mutate({op:'cdc_section_move',chantier_id:'${c.id}',section_id:'${sec.id}',dir:-1})" title="Monter">↑</a>` +
      `<a onclick="mutate({op:'cdc_section_move',chantier_id:'${c.id}',section_id:'${sec.id}',dir:1})" title="Descendre">↓</a>` +
      `<a class="danger" onclick="cdcRemoveSection('${c.id}','${sec.id}')" title="Supprimer la section">×</a></span></div>` +
      `<textarea class="cdc-sec-corps" placeholder="Rédige cette section…" onblur="cdcSectionField('${c.id}','${sec.id}','corps',this.value)">${esc(sec.corps)}</textarea>` +
      `</section>`;
  });
  h += `<button class="btn sm" onclick="cdcAddSection('${c.id}')">+ Ajouter une section</button>`;
  h += `</div>`;

  // Suivi des modifications (table d'indices)
  h += `<div class="cdc-card"><div class="cdc-rev-h">Suivi des modifications — révisions</div>`;
  h += `<table class="ptable cdc-rev"><thead><tr><th>Indice</th><th>Date</th><th>Auteur</th><th>Objet de la modification</th><th></th></tr></thead><tbody>`;
  cdc.revisions.slice().reverse().forEach(r => {
    const isCur = r.indice === cdc.indice;
    h += `<tr><td><b>${esc(r.indice)}</b>${isCur ? ` <span class="cdc-cur">courant</span>` : ""}</td>` +
      `<td>${fmt(r.date)}</td><td>${esc(r.auteur || "—")}</td><td>${esc(r.objet || "")}</td>` +
      `<td class="pacts">${(isCur || r.snapshot) ? `<a onclick="cdcViewRevision('${c.id}','${r.id}')">Voir</a>` : ""}</td></tr>`;
  });
  h += `</tbody></table><div class="muted small" style="margin-top:6px">« Émettre une révision » fige l'indice courant et passe au suivant (la validation repart à zéro).</div></div>`;

  h += `</div>`;   // cdc-doc
  $("cdc").innerHTML = h;
}

// ---- actions CdC ----
async function cdcCreate(cid){ await mutate({op: "cdc_create", chantier_id: cid}); openCdc(cid); }
function cdcField(cid, field, val){ mutate({op: "cdc_update", chantier_id: cid, [field]: val}); }
function cdcStatut(cid, statut){ mutate({op: "cdc_update", chantier_id: cid, statut}); }
function cdcSectionField(cid, sid, field, val){ mutate({op: "cdc_section_update", chantier_id: cid, section_id: sid, [field]: val}); }
function cdcAddSection(cid){
  const t = prompt("Titre de la nouvelle section :", "");
  if(t === null) return;
  mutate({op: "cdc_section_add", chantier_id: cid, titre: t.trim() || "Nouvelle section"});
}
function cdcRemoveSection(cid, sid){
  if(confirm("Supprimer cette section ?")) mutate({op: "cdc_section_remove", chantier_id: cid, section_id: sid});
}
function cdcAddPartie(cid){
  const n = prompt("Partie prenante (nom) :"); if(!n || !n.trim()) return;
  const r = (prompt("Rôle (ex. Approbateur, Vérificateur, Destinataire) :") || "").trim();
  mutate({op: "cdc_partie_add", chantier_id: cid, nom: n.trim(), role: r});
}
function cdcRevise(cid){
  const o = prompt("Objet de la révision (qu'est-ce qui change ?) :");
  if(o === null) return;
  if(!o.trim()){ alert("L'objet de la révision est requis."); return; }
  const a = (prompt("Auteur de la révision :", "") || "").trim();
  mutate({op: "cdc_revise", chantier_id: cid, objet: o.trim(), auteur: a});
}
async function cdcDelete(cid){
  if(!confirm("Supprimer définitivement le cahier des charges de ce chantier ?")) return;
  await mutate({op: "cdc_delete", chantier_id: cid});
  openChantier(cid);
}

// Vue lecture seule d'une révision (snapshot ou contenu courant)
function cdcViewRevision(cid, rid){
  const c = chById(cid); if(!c || !c.cdc) return;
  const cdc = c.cdc, r = cdc.revisions.find(x => x.id === rid); if(!r) return;
  const snap = r.snapshot || {titre: cdc.titre, reference: cdc.reference, sections: cdc.sections,
                              valide_par: cdc.valide_par, date_validation: cdc.date_validation};
  let h = `<div class="cdc-modal-bg" onclick="closeCdcModal()"><div class="cdc-modal" onclick="event.stopPropagation()">`;
  h += `<div class="cdc-modal-h"><b>Indice ${esc(r.indice)}</b> · ${fmt(r.date)}${r.auteur ? ` · ${esc(r.auteur)}` : ""}` +
       `<span class="add" onclick="closeCdcModal()">Fermer ✕</span></div>`;
  h += `<div class="cdc-modal-b"><h1 class="cdc-h1">${esc(snap.titre || c.titre)}</h1>` +
       `<div class="cdc-sub">${snap.reference ? esc(snap.reference) + " · " : ""}Indice ${esc(r.indice)} · ${fmt(r.date)}</div>`;
  (snap.sections || []).forEach((s, i) => {
    h += `<h3 class="cdc-h3">${i + 1}. ${esc(s.titre)}</h3>` +
      `<div class="cdc-corps">${(esc(s.corps || "").replace(/\n/g, "<br>")) || "<span class='empty'>—</span>"}</div>`;
  });
  h += `<div class="cdc-objet muted">Objet de cette révision : ${esc(r.objet || "—")}</div>`;
  h += `</div></div></div>`;
  const m = document.createElement("div"); m.id = "cdcModal"; m.innerHTML = h; document.body.appendChild(m);
}
function closeCdcModal(){ const m = $("cdcModal"); if(m) m.remove(); }

// Document imprimable (→ PDF via le navigateur)
// ---- vue imprimable : gabarit RFF, jetons NSN Industrie ------------------
// Meme construction que l'export Word (cdc_docx.py) : cartouche d'en-tete a
// bordures noires (marque officielle, adresse, N°, REV.), bandeau bilingue,
// barre tricolore, titre encadre, tableaux a en-tete NOIR texte blanc et
// grille complete, page Pilotage generee, sections formatees.
const CDC_RX = {
  puce:  /^\s*(?:[-•*]|\d+[.)])\s+/,
  colonnes: /\S {3,}\S/,
  continuation: /^\s{6,}\S/,
  label: /^([A-Z\u00C0-\u00DE0-9][A-Z\u00C0-\u00DE0-9 '\u2019/()&.,-]{2,70}?\s*:)(\s*)(.*)$/
};
function cdcMark(lettres, taille){
  return `<svg viewBox="0 0 59 65" style="height:${taille};width:auto;vertical-align:middle" aria-hidden="true">` +
    `<g fill="${lettres}"><path d="M0.872803 0H3.27816L25.3662 28.2978H25.4487V0H27.3524V31.083H24.947L2.85894 2.78522H2.77647V31.083H0.872803V0Z"/>` +
    `<path d="M1.90368 54.0332C1.94492 59.8195 5.29867 63.2592 13.257 63.2592C20.5074 63.2592 23.1602 59.9936 23.1602 56.338C23.1602 52.6824 21.5864 51.2898 15.3668 49.9389L9.85511 48.7204C3.38813 47.286 0.900303 45.2806 0.900303 40.5806C0.900303 35.8805 4.75575 32.5244 12.0887 32.5244C19.4216 32.5244 24.2735 35.4001 24.4797 42.015H22.576C22.3286 38.4429 20.4181 34.2651 12.6316 34.2651C5.42238 34.2651 3.05825 37.0503 3.05825 40.6224C3.05825 43.9298 4.42587 45.587 10.0613 46.7638L16.1503 48.0241C22.0743 49.2426 25.3113 51.248 25.3113 56.2057C25.3113 60.4253 22.6585 65 13.415 65C3.71801 65 -0.0137329 60.6063 -0.0137329 54.0332H1.88994H1.90368Z"/>` +
    `<path d="M32.5204 33.2207H34.9258L57.0139 61.5185H57.0963V33.2207H59V64.3037H56.5946L34.5066 36.0059H34.4241V64.3037H32.5204V33.2207Z"/></g>` +
    `<path fill="#7CD8B2" d="M59 0V9.40707H57.0963V1.92876H49.7153V0H59Z"/></svg>`;
}
function cdcFmtLigne(l){
  if(!l.trim()) return `<div class="vide"></div>`;
  if(CDC_RX.colonnes.test(l) || CDC_RX.continuation.test(l))
    return `<div class="mono">${esc(l)}</div>`;
  const mp = l.match(CDC_RX.puce);
  if(mp) return `<p class="puce"><b>${esc(mp[0])}</b>${esc(l.slice(mp[0].length))}</p>`;
  const m = l.match(CDC_RX.label);
  if(m && m[3].trim()) return `<p><b class="lbl">${esc(m[1])}</b>${esc(m[2] + m[3])}</p>`;
  if(m) return `<p class="soustitre">${esc(l)}</p>`;
  return `<p>${esc(l)}</p>`;
}
function cdcFmtCorps(corps){ return (corps || "").split("\n").map(cdcFmtLigne).join(""); }

function cdcDocHTML(c){
  const cdc = c.cdc, ref = esc(cdc.reference || c.id), din = "'Bahnschrift SemiCondensed','Bahnschrift',sans-serif";
  const stLbl = (CDC_ST[cdc.statut] || CDC_ST.brouillon).lbl;
  const eyebrow = (fr, en) => `<div class="eyebrow"><b>${fr}</b><span> / ${en}</span></div>`;

  const ident = `<table class="tc"><tr class="th"><td style="width:42mm">RUBRIQUE</td><td>VALEUR</td><td style="width:44mm">VALUE</td></tr>` +
    [["Référence", cdc.reference || "", "Reference"], ["Indice", cdc.indice, "Revision"],
     ["Statut", stLbl, ""], ["Rédacteur", cdc.redacteur || "", "Author"],
     ["Créé le", fmt(cdc.date_creation), "Created"], ["Mis à jour le", fmt(cdc.date_maj), "Updated"],
     ["Validé par", cdc.valide_par || "", cdc.date_validation ? fmt(cdc.date_validation) : ""]]
      .map(r => `<tr><td class="tl">${esc(r[0])}</td><td>${esc(r[1])}</td><td class="ten">${esc(r[2])}</td></tr>`).join("") + `</table>`;

  const revs = cdc.revisions.map(r =>
    `<tr><td class="tctr tdin">${esc(r.indice)}</td><td class="tctr tmono">${fmt(r.date)}</td>` +
    `<td>${esc(r.auteur || "")}</td><td>${esc(r.objet || "")}</td></tr>`).join("") +
    `<tr><td class="vide2" colspan="4"></td></tr><tr><td class="vide2" colspan="4"></td></tr>`;

  const appro = `<table class="tc"><tr class="th"><td style="width:24mm"></td><td>RÉDACTION</td><td>VÉRIFICATION</td><td>APPROBATION</td></tr>` +
    `<tr><td class="tl">NOM</td><td class="tctr">${esc(cdc.redacteur || "")}</td><td></td><td class="tctr">${esc(cdc.valide_par || "")}</td></tr>` +
    `<tr><td class="tl">DATE</td><td class="tctr tmono">${fmt(cdc.date_creation)}</td><td></td><td class="tctr tmono">${cdc.date_validation ? fmt(cdc.date_validation) : ""}</td></tr>` +
    `<tr class="visa"><td class="tl">VISA</td><td></td><td></td><td></td></tr></table>`;

  const etat = t => t.done ? "Fait le " + fmt(t.done_date) : (t.start_date ? "En cours depuis le " + fmt(t.start_date) : "À faire");
  const plan = `<table class="tc"><tr class="th"><td style="width:10mm">N°</td><td>LOT / JALON</td><td style="width:20mm">DURÉE</td><td style="width:44mm">ÉTAT</td></tr>` +
    c.taches.map((t, i) => `<tr><td class="tctr tdin">${i + 1}</td><td>${esc(t.label)}</td>` +
      `<td class="tctr tmono">${t.is_milestone ? "JALON" : (t.duree || 0) + " j"}</td><td>${etat(t)}</td></tr>`).join("") + `</table>`;

  const rks = (c.risques || []);
  const RKST = {ouvert: "Ouvert", maitrise: "Maîtrisé", avere: "Avéré", clos: "Clos"};
  const risques = rks.length
    ? `<table class="tc"><tr class="th"><td>RISQUE</td><td style="width:18mm">P×G</td><td>PARADE</td><td style="width:22mm">RESP.</td><td style="width:18mm">ÉTAT</td></tr>` +
      rks.map(r => `<tr><td>${esc(r.libelle)}</td><td class="tctr tmono">${r.probabilite}×${r.gravite} = ${r.probabilite * r.gravite}</td>` +
        `<td>${esc(r.parade || "")}</td><td>${esc(r.responsable || "")}</td><td>${RKST[r.statut] || esc(r.statut || "")}</td></tr>`).join("") + `</table>`
    : `<p class="aucun">Aucun risque enregistré au registre à la date d'édition.</p>`;

  const secs = cdc.sections.map((s, i) =>
    `<h2>${i + 1}. ${esc(s.titre)}</h2><div class="corps">${cdcFmtCorps(s.corps)}</div>`).join("");

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(cdc.titre || c.titre)}</title><style>
  @page{size:A4;margin:0}
  *{box-sizing:border-box;margin:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;color:#33555F;font-size:9.5pt;line-height:1.45;
       padding:33mm 12mm 22mm}
  .entete{position:fixed;top:4mm;left:12mm;right:12mm;background:#fff}
  .cart{width:100%;border-collapse:collapse}
  .cart td{border:.4mm solid #333;padding:1.2mm 2mm;vertical-align:middle}
  .cart .logo{width:26mm;text-align:center}
  .cart .adr{width:34mm;font-size:7pt;color:#33555F}
  .cart .adr b{font-size:9pt;color:#0F2329;display:block}
  .cart .ti{text-align:center}
  .cart .ti b{font-size:12pt;color:#0F2329;display:block}
  .cart .ti span{font-size:8pt;color:#647E86}
  .cart .ti span b{display:inline;font-size:9pt}
  .cart .rv{width:11mm;text-align:center;font-family:${din}}
  .cart .pg{width:18mm;text-align:center}
  .cart .petit{font-size:6.5pt;font-weight:700;color:#647E86;letter-spacing:.6pt}
  .cart .val{font-size:11pt;font-weight:700;color:#0F2329}
  .bandc{width:100%;border-collapse:collapse}
  .bandc td{border:.4mm solid #333;border-top:none;padding:1mm 2mm;font-size:7pt;width:50%}
  .bandc b{color:#0F2329}
  .bandc i{color:#647E86;font-weight:700}
  .pied{position:fixed;bottom:0;left:0;right:0;height:14mm;padding:2mm 12mm 0;border-top:.3mm solid #CFD8DB;
        text-align:center;font-size:6.5pt;color:#8798A0;background:#fff}
  .pied b{font-family:${din};letter-spacing:1.2pt;color:#647E86}
  .pied .prop{font-style:italic;font-size:6pt;margin-top:.5mm}
  .boite{border:1.2mm solid #111;margin:16mm 14mm 10mm;padding:8mm 6mm;text-align:center;break-inside:avoid}
  .boite h1{font-size:22pt;color:#0F2329;margin-bottom:2mm}
  .boite .num{font-size:12pt;color:#33555F}
  .boite .num b{color:#0F2329;font-size:13pt}
  .boite .sst{font-size:10pt;color:#647E86;margin-top:2mm}
  .eyebrow{border-bottom:.3mm solid #444;padding-bottom:1.2mm;margin:6mm 0 2.5mm;break-after:avoid-page}
  .eyebrow b{font-family:${din};font-size:10pt;letter-spacing:1.2pt;text-transform:uppercase;color:#081418}
  .eyebrow span{font-size:8pt;font-style:italic;color:#8798A0}
  .tc{width:100%;border-collapse:collapse}
  .tc td{padding:1.6mm 2.2mm;border:.3mm solid #333;font-size:8.5pt;vertical-align:middle}
  .tc tr{break-inside:avoid}
  .tc .th td{background:#1A1A1A;color:#fff;text-align:center;font-family:${din};font-size:8pt;
             font-weight:700;letter-spacing:1.2pt}
  .tl{font-family:${din};font-size:8pt;font-weight:700;letter-spacing:1pt;text-transform:uppercase;color:#0F2329}
  .ten{font-style:italic;font-size:7.5pt;color:#8798A0}
  .tctr{text-align:center}.tdin{font-family:${din};font-weight:700;color:#0F2329}
  .tmono{font-family:Consolas,monospace;font-size:8pt}
  .visa td{height:13mm}
  .vide2{height:4.5mm}
  h2{font-family:${din};font-size:13pt;letter-spacing:.8pt;text-transform:uppercase;color:#0F2329;
     border-bottom:.3mm solid #444;padding-bottom:1.2mm;margin:6mm 0 2.5mm;break-after:avoid-page}
  .corps p{margin:0 0 1.2mm}
  .corps .vide{height:1.6mm}
  .corps .puce{padding-left:8mm;text-indent:-4mm}
  .corps .puce b{color:#0F2329}
  .corps .lbl{color:#0F2329}
  .corps .soustitre{font-family:${din};font-weight:700;letter-spacing:1.2pt;color:#0F2329;margin:3mm 0 1.2mm}
  .corps .mono{font-family:Consolas,monospace;font-size:8pt;background:#F3F6F7;
               padding:.4mm 3mm;margin:0 3mm;white-space:pre}
  .aucun{font-style:italic;color:#8798A0;font-size:8.5pt}
  .note{border-top:.2mm solid #CFD8DB;margin-top:6mm;padding-top:2mm;font-style:italic;
        font-size:7.5pt;color:#8798A0}
  </style></head><body>
  <div class="entete">
    <table class="cart"><tr>
      <td class="logo" rowspan="2">${cdcMark("#0F2329", "11mm")}</td>
      <td class="adr" rowspan="2"><b>NSN</b>972 Avenue du 19 Mars 1962<br>38540 Heyrieux</td>
      <td class="ti" rowspan="2"><b>Cahier des Charges</b><span>N° CDC : <b>${ref}</b></span></td>
      <td class="rv petit">REV.</td><td class="pg petit">PAGE</td></tr>
      <tr><td class="rv val">${esc(cdc.indice)}</td><td class="pg" style="font-size:7pt;color:#647E86">—</td></tr>
    </table>
    <table class="bandc"><tr>
      <td><b>CHANTIER / </b><i>PROJECT</i> : ${esc(c.titre)}</td>
      <td><b>RÉDACTEUR / </b><i>AUTHOR</i> : ${esc(cdc.redacteur || "")}</td></tr>
    </table>
  </div>
  <div class="pied"><div><b>NSN</b> · 972 Avenue du 19 Mars 1962 · 38540 Heyrieux · <i>${ref} — ${esc(c.titre)}</i></div>
    <div class="prop">Ce document est la propriété de NSN Industrie. Il ne peut être reproduit ni communiqué à un tiers sans autorisation écrite.</div></div>

  <div class="boite"><h1>Cahier des Charges</h1>
    <div class="num">N° CDC : <b>${ref}</b></div>
    <div class="sst">${esc(cdc.titre || c.titre)}</div></div>
  ${eyebrow("Identification", "Document identification")}${ident}
  ${eyebrow("Liste des révisions", "Revision list")}
  <table class="tc"><tr class="th"><td style="width:16mm">INDICE</td><td style="width:24mm">DATE</td><td style="width:30mm">AUTEUR</td><td>OBJET DE LA RÉVISION</td></tr>${revs}</table>
  ${eyebrow("Approbation", "Approval")}${appro}
  ${eyebrow("Planning et jalons", "Schedule and milestones")}
  <p style="margin-bottom:1.5mm"><b class="lbl" style="font-family:${din};letter-spacing:1pt">DÉBUT</b> <span class="tmono">${fmt(c.date_debut)}</span>
     &nbsp;&nbsp;<b class="lbl" style="font-family:${din};letter-spacing:1pt">ÉCHÉANCE</b> <span class="tmono">${fmt(c.echeance) || "—"}</span>
     &nbsp;&nbsp;<i style="font-size:7.5pt;color:#8798A0">le planning de référence (chemin critique, jours ouvrés) vit dans l'appli de suivi</i></p>
  ${plan}
  ${eyebrow("Registre des risques", "Risk register")}${risques}
  ${secs}
  <div class="note">Document généré par le suivi des chantiers. La version Word éditable (bouton Word) fait référence pour les retouches ; ce PDF est la forme de diffusion.</div>
  </body></html>`;
}
function cdcPrint(){
  const c = chById(CUR_CDC); if(!c || !c.cdc) return;
  const w = window.open("", "_blank");
  if(!w){ alert("Autorise les pop-ups pour imprimer / exporter en PDF."); return; }
  w.document.write(cdcDocHTML(c)); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch(e){} }, 350);
}

// Vue d'ensemble : tous les cahiers des charges
function renderCahiers(){
  if(!STORE.chantiers.length){ $("cahiers").innerHTML = `<div class="ch-h">Cahiers des charges</div><div class="empty">Aucun chantier.</div>`; return; }
  const n = LIVE().filter(c => c.cdc).length;
  let h = `<div class="ch-h">Cahiers des charges <span class="muted small">· ${n}/${LIVE().length} chantier(s)</span></div>`;
  h += `<table class="ptable"><thead><tr><th>Chantier</th><th>Référence</th><th>Indice</th><th>Statut</th><th>Mis à jour</th><th>Validé</th><th></th></tr></thead><tbody>`;
  LIVE().forEach(c => {
    if(c.cdc){
      const cdc = c.cdc, st = CDC_ST[cdc.statut] || CDC_ST.brouillon;
      h += `<tr class="cdc-clk" onclick="openCdc('${c.id}')"><td><b>${esc(c.titre)}</b></td>` +
        `<td>${esc(cdc.reference || "—")}</td><td>${esc(cdc.indice)}</td>` +
        `<td><span class="cdc-badge ${st.cls}">${st.lbl}</span></td>` +
        `<td>${fmt(cdc.date_maj)}</td>` +
        `<td>${cdc.statut === "valide" && cdc.date_validation ? fmt(cdc.date_validation) + (cdc.valide_par ? ` · ${esc(cdc.valide_par)}` : "") : "—"}</td>` +
        `<td class="pacts"><a onclick="event.stopPropagation();openCdc('${c.id}')">Ouvrir</a></td></tr>`;
    } else {
      h += `<tr><td><b>${esc(c.titre)}</b></td><td colspan="5" class="muted">Pas de cahier des charges</td>` +
        `<td class="pacts"><a onclick="cdcCreate('${c.id}')">+ Créer</a></td></tr>`;
    }
  });
  h += `</tbody></table>`;
  $("cahiers").innerHTML = h;
}

// ===========================================================================
// Vue transverse : toutes les recettes, et ce qu'elles coûtent en temps.
// ===========================================================================
function renderRecettes(){
  const chs = recChantiers();
  const enRec = LIVE().filter(c => c.statut === "recette");
  let ok = 0, ttl = 0, pb = 0, late = 0, min = 0;
  chs.forEach(c => {
    const s = recStats(c);
    ok += s.ok; ttl += s.total; pb += s.probleme; late += recProbLate(c).length;
    min += recetteMin(c.id);
  });
  let h = `<div class="ch-h">Recette <span class="muted small">· ${chs.length} liste(s) · ${enRec.length} chantier(s) en recette</span></div>`;
  h += `<div class="kpis">` +
    kpi("Points vérifiés", `${ok}/${ttl}`, ttl ? Math.round(ok / ttl * 100) + " % de l'ensemble" : "aucun point", ttl && ok === ttl ? "good" : "") +
    kpi("Problèmes ouverts", String(pb), late + " en retard", (pb && late) ? "bad" : pb ? "warn" : "good") +
    kpi("Reste à vérifier", String(ttl - ok - pb), "points non statués", (ttl - ok - pb) ? "" : "good") +
    kpi("Temps de recette", min ? fmtDur(min) : "—", "chronométré, tous chantiers") +
    `</div>`;
  if(!chs.length){
    $("recettes").innerHTML = h + `<div class="empty">Aucune liste de recette. Ouvre un chantier et démarre-la depuis la carte « Recette ».</div>`;
    return;
  }
  h += `<table class="ptable rec-tbl"><thead><tr><th>Chantier</th><th>Avancement</th>` +
    `<th>Problèmes</th><th>Temps passé</th><th></th></tr></thead><tbody>`;
  chs.slice().sort((a, b) => recProblemes(b).length - recProblemes(a).length || recStats(a).pct - recStats(b).pct)
    .forEach(c => {
      const s = recStats(c), np = recProblemes(c).length, nl = recProbLate(c).length, m = recetteMin(c.id);
      h += `<tr class="cdc-clk" onclick="openChantier('${c.id}')">` +
        `<td><b>${esc(c.titre)}</b>${c.statut === "recette" ? ` <span class="bdg b-rec">en recette</span>` : ""}` +
          (s.fini ? ` <span class="rec-fini">✓ terminée</span>` : "") + `</td>` +
        `<td>${miniBar(s.pct, s.fini ? "good" : "")}<span class="muted small"> ${s.ok}/${s.total}</span></td>` +
        `<td>${np ? `${np}${nl ? ` <span class="bad-t">(${nl} en retard)</span>` : ""}` : `<span class="muted">—</span>`}</td>` +
        `<td>${m ? fmtDur(m) : "—"}</td>` +
        `<td class="pacts"><a onclick="event.stopPropagation();openChantier('${c.id}')">Ouvrir</a></td></tr>`;
    });
  h += `</tbody></table>`;
  // Ce qui coince, tous chantiers confondus — les échéances les plus proches d'abord
  const ech = p => p.echeance || "9999-99-99";
  const pbs = chs.flatMap(c => recProblemes(c)).sort((a, b) => ech(a) < ech(b) ? -1 : ech(a) > ech(b) ? 1 : 0);
  h += `<div class="ch-h">Ce qui coince — ${pbs.length}</div>`;
  if(!pbs.length) h += `<div class="empty">Aucun problème ouvert.</div>`;
  else {
    h += `<table class="ptable"><thead><tr><th>Point</th><th>Chantier</th><th>Constat</th>` +
      `<th>Qui corrige</th><th>Pour le</th><th></th></tr></thead><tbody>`;
    pbs.forEach(p => {
      const lt = isLate(p.echeance);
      h += `<tr class="cdc-clk" onclick="openChantier('${p._c.id}')">` +
        `<td><b>${esc(p.titre)}</b></td><td>${esc(p._c.titre)}</td>` +
        `<td class="muted">${esc(p.constat || "—")}</td><td>${esc(p.qui || "—")}</td>` +
        `<td class="${lt ? "bad-t" : ""}">${p.echeance ? fmt(p.echeance) + (lt ? " (en retard)" : "") : "—"}</td>` +
        `<td class="pacts"><a title="Marquer ce point comme vérifié" onclick="event.stopPropagation();mutate({op:'point_set',chantier_id:'${p._c.id}',point_id:'${p.id}',statut:'ok'})">✓ vérifié</a></td></tr>`;
    });
    h += `</tbody></table>`;
  }
  // Chantiers en recette sans liste : le trou dans la raquette
  const sans = enRec.filter(c => !recPoints(c).length);
  if(sans.length){
    h += `<div class="ch-h">À outiller — ${sans.length}</div><table class="ptable"><tbody>`;
    sans.forEach(c => h += `<tr><td><b>${esc(c.titre)}</b></td>` +
      `<td class="muted">${c.recette ? "liste vide" : "aucune liste de recette"}</td>` +
      `<td class="pacts"><a onclick="openChantier('${c.id}')">Ouvrir le chantier</a></td></tr>`);
    h += `</tbody></table>`;
  }
  $("recettes").innerHTML = h;
}
function miniBar(v, cls){
  return `<span class="mbar ${cls || ""}"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span><span class="mbar-v">${v} %</span>`;
}

loadStore();
// re-vérifie périodiquement les rappels (notif bureau tant que l'onglet est ouvert)
setInterval(checkDesktopNotifs, 60000);
// rafraîchit l'affichage du chrono en cours (durées, "Ma journée") chaque minute
setInterval(() => {
  if(!activeSession()) return;
  renderAlert();
  if(VIEW === "planning" && $("planning").style.display !== "none") renderPlanning();
}, 60000);
