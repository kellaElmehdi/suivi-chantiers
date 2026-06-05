"use strict";

let STORE = {chantiers: [], contacts: []};
let TODAY = "2025-01-01";
let CUR = null;            // id du chantier ouvert en page detaillee (sinon null)
let SETTINGS = {capacite_jour: 3, wip_max: 3, jours_ouvres: true, relance_jours: 7};

const COLS = [
  {key: "todo",    label: "À faire"},
  {key: "doing",   label: "En cours"},
  {key: "block",   label: "Bloqué"},
  {key: "recette", label: "Recette"},
  {key: "done",    label: "Terminé"},
];
const PRIO = {h: "haute", m: "moyenne", b: "basse"};
const LIV  = {attente: "En attente", recu: "Reçu", partiel: "Reçu partiel", annule: "Annulé"};
const RET  = {a_traiter: "À traiter", en_cours: "En cours", fait: "Fait", rejete: "Rejeté"};
const allRetours = c => (c.iterations || []).flatMap(it => it.retours.map(r => ({...r, _it: it})));
const openRetours = c => allRetours(c).filter(r => r.statut === "a_traiter" || r.statut === "en_cours");
const currentIter = c => (c.iterations || []).find(it => it.ouverte) || (c.iterations || []).slice(-1)[0] || null;

// ---- utils ---------------------------------------------------------------
const $ = id => document.getElementById(id);
const esc = s => (s == null ? "" : String(s)).replace(/[&<>"]/g, c =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const isLate = d => d && d < TODAY;
const pct = c => c.taches.length ? Math.round(100 * c.taches.filter(t => t.done).length / c.taches.length) : 0;
const openAtt = c => c.livrables.filter(l => l.statut === "attente" || l.statut === "partiel");
const lateAtt = c => c.livrables.filter(l => (l.statut === "attente" || l.statut === "partiel") && isLate(l.date));
const chById = id => STORE.chantiers.find(c => c.id === id);
// "Bloqué" est calculé : point bloquant rempli, OU une tâche non finie attend un
// livrable rattaché non reçu, OU un livrable non reçu est EN RETARD.
const gatedLivrable = c => (c.livrables || []).find(l => l.tache_id
  && (l.statut === "attente" || l.statut === "partiel")
  && (c.taches || []).some(t => t.id === l.tache_id && !t.done));
function isBlocked(c){
  if(c.statut === "done") return false;
  if(c.blocage && c.blocage.trim()) return true;
  if(gatedLivrable(c)) return true;
  return lateAtt(c).length > 0;   // livrable non reçu et en retard
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
function fmtShort(d){ const p = d.split("-"); return `${p[2]}/${p[1]}`; }
const isWeekend = dt => { const d = dt.getUTCDay(); return d === 0 || d === 6; };
// Unités de planning : jours ouvrés (si réglé) ou calendaires. Les échéances/compteurs réels restent en daysBetween.
function addUnits(s, n){
  if(!SETTINGS.jours_ouvres) return addDays(s, n);
  const dt = dparse(s), step = n >= 0 ? 1 : -1; let rem = Math.abs(Math.round(n));
  while(rem > 0){ dt.setUTCDate(dt.getUTCDate() + step); if(!isWeekend(dt)) rem--; }
  return dstr(dt);
}
function workOffset(start, date){
  if(!SETTINGS.jours_ouvres) return daysBetween(start, date);
  const dt = dparse(start), tgt = dparse(date); let k = 0;
  if(tgt >= dt){ while(dt < tgt){ dt.setUTCDate(dt.getUTCDate() + 1); if(!isWeekend(dt)) k++; } }
  else { while(dt > tgt){ dt.setUTCDate(dt.getUTCDate() - 1); if(!isWeekend(dt)) k--; } }
  return k;
}

// ---- API -----------------------------------------------------------------
async function api(method, path, body){
  const r = await fetch(path, {method, headers: {"Content-Type": "application/json"},
                              body: body ? JSON.stringify(body) : undefined});
  return r.json();
}
async function loadStore(){
  const d = await api("GET", "/api/store");
  STORE = d.store; TODAY = d.today;
  if(STORE.settings) SETTINGS = {...SETTINGS, ...STORE.settings};
  if(CUR && chById(CUR)) renderPage(); else { CUR = null; showView("board"); }
}
async function mutate(op){
  const d = await api("POST", "/api/mutate", op);
  if(d.error){ alert(d.error); return; }
  STORE = d.store; TODAY = d.today;
  if(STORE.settings) SETTINGS = {...SETTINGS, ...STORE.settings};
  if(CUR && chById(CUR)) renderPage();
  else { CUR = null; showView(VIEW); }
}

// ---- vues ----------------------------------------------------------------
let VIEW = "board";
function showView(v){
  if(v === "board" || v === "charge" || v === "people" || v === "dash") VIEW = v;
  $("board").style.display = v === "board" ? "flex" : "none";
  $("dash").style.display = v === "dash" ? "block" : "none";
  $("charge").style.display = v === "charge" ? "block" : "none";
  $("people").style.display = v === "people" ? "grid" : "none";
  $("page").style.display = v === "page" ? "block" : "none";
  document.querySelectorAll(".nav button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  renderAlert();
  if(v === "board") renderBoard();
  if(v === "dash") renderDashboard();
  if(v === "charge") renderCharge();
  if(v === "people") renderPeople();
}
function setView(v){ CUR = null; showView(v); }
function renderAll(){ renderAlert(); renderBoard(); renderPeople(); }

// ---- bandeau + board + personnes ----------------------------------------
// ---- règles globales -----------------------------------------------------
function lateTasks(c){   // tâches/jalons non finis dont la fin PRÉVUE est déjà passée
  const S = computeSchedule(c);
  return c.taches.filter(t => !t.done && S.sched[t.id] && S.sched[t.id].endDate < TODAY);
}
function relancesDues(c){
  return c.livrables.filter(l => (l.statut === "attente" || l.statut === "partiel")
    && (!l.derniere || daysBetween(l.derniere, TODAY) >= SETTINGS.relance_jours));
}
function retoursLate(c){
  return allRetours(c).filter(r => (r.statut === "a_traiter" || r.statut === "en_cours") && isLate(r.echeance));
}
function chargeData(){
  const items = [];
  STORE.chantiers.forEach(c => {
    const S = computeSchedule(c);
    c.taches.forEach(t => {
      if(t.done || t.is_milestone) return;
      const f = S.fc[t.id]; if(!f) return;
      const sl = S.sched[t.id] ? S.sched[t.id].slack : 0;
      items.push({chantier_id: c.id, tache_id: t.id, chantier: c.titre, label: t.label,
                  start: f.fsDate, end: f.ffDate, slack: sl, fixed: !!t.start_fix});
    });
  });
  if(!items.length) return {days: [], overload: 0, cap: SETTINGS.capacite_jour, items};
  let mx = items.reduce((a, i) => i.end > a ? i.end : a, items[0].end);
  const horizon = addDays(TODAY, 120); if(mx > horizon) mx = horizon;
  const days = []; let d = TODAY, guard = 0;
  while(d < mx && guard++ < 400){
    if(!(SETTINGS.jours_ouvres && isWeekend(dparse(d)))){
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
function levelingSuggestions(){
  const cd = chargeData();
  if(!cd.overload) return [];
  const overDays = cd.days.filter(x => x.count > cd.cap).sort((a, b) => b.count - a.count);
  const sugg = [], used = new Set();
  for(const day of overDays){
    if(sugg.length >= 8) break;
    const cand = cd.items.filter(i => i.slack > 0 && i.start <= day.date && day.date < i.end
      && !used.has(i.chantier_id + i.tache_id)).sort((a, b) => b.slack - a.slack);
    for(const it of cand){
      let ns = addDays(day.date, 1);
      while(SETTINGS.jours_ouvres && isWeekend(dparse(ns))) ns = addDays(ns, 1);
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
  let openL = 0, lateL = 0, lateT = 0, relances = 0, retL = 0;
  STORE.chantiers.forEach(c => {
    openL += openAtt(c).length; lateL += lateAtt(c).length; lateT += lateTasks(c).length;
    relances += relancesDues(c).length; retL += retoursLate(c).length;
  });
  const wip = STORE.chantiers.filter(c => colOf(c) === "doing").length;
  const over = chargeData().overload;
  $("subtitle").textContent = `${STORE.chantiers.length} chantiers`;
  const seg = [];
  seg.push(`<b>${openL}</b> livraison(s) attendue(s)` + (lateL ? ` (<span class="lt">${lateL} en retard</span>)` : ""));
  if(lateT) seg.push(`<span class="lt">${lateT} tâche(s) en retard</span>`);
  if(relances) seg.push(`<a class="seg" onclick="setView('people')">${relances} relance(s) à faire</a>`);
  if(retL) seg.push(`<span class="lt">${retL} retour(s) en retard</span>`);
  seg.push(`WIP <b class="${wip > SETTINGS.wip_max ? "lt" : ""}">${wip}</b>/${SETTINGS.wip_max} en cours`);
  if(over) seg.push(`<a class="seg lt" onclick="setView('charge')">${over} jour(s) en surcharge</a>`);
  $("alert").innerHTML = seg.join("&nbsp;·&nbsp;");
}

function saveSetting(k, v){ mutate({op: "set_settings", settings: {[k]: v}}); }

// ---- Tableau de bord -----------------------------------------------------
function dkpi(label, val, sub, cls, onclick){
  return `<div class="kpi ${cls || ""}"${onclick ? ` onclick="${onclick}" style="cursor:pointer"` : ""}>` +
    `<div class="lab">${label}</div><div class="num">${esc(String(val))}</div>` +
    (sub ? `<div class="sub">${esc(sub)}</div>` : "") + `</div>`;
}
function dsection(t){ return `<div class="ch-h">${t}</div>`; }
function topPersAll(m){ return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8); }
function chartBox(title, svg){ return `<div class="cardx"><div class="cardx-h">${title}</div><div class="cardx-b">${svg}</div></div>`; }
const STATUT_COLOR = {todo: "var(--gray)", doing: "var(--blue)", block: "var(--red)", recette: "#7a5ea8", done: "var(--green)"};

function hbar(rows, opts){   // barres horizontales [{label,value,color,disp}]
  opts = opts || {};
  if(!rows.length) return `<div class="empty">—</div>`;
  const max = Math.max(1, ...rows.map(r => r.value));
  const labelW = opts.labelW || 150, barW = opts.barW || 210, rowH = 22, padT = 4;
  const W = labelW + barW + 46, H = padT + rows.length * rowH + 6;
  let g = `<svg width="${W}" height="${H}" class="hbar">`;
  rows.forEach((r, i) => {
    const y = padT + i * rowH, w = Math.round((r.value / max) * barW);
    g += `<text x="${labelW - 6}" y="${y + 14}" font-size="11" text-anchor="end" fill="var(--ink)">${esc(String(r.label).slice(0, 24))}</text>`;
    g += `<rect x="${labelW}" y="${y + 4}" width="${Math.max(0, w)}" height="13" fill="${r.color || "var(--blue)"}"/>`;
    g += `<text x="${labelW + Math.max(w, 0) + 5}" y="${y + 14}" font-size="10.5" fill="var(--muted)">${r.disp != null ? r.disp : r.value}</text>`;
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
    if(r.days > 0) g += `<rect x="${mid}" y="${y + 4}" width="${w}" height="13" fill="var(--red)"/>`;
    else g += `<rect x="${mid - w}" y="${y + 4}" width="${w}" height="13" fill="var(--green)"/>`;
    g += `<text x="${r.days > 0 ? mid + w + 4 : mid - w - 4}" y="${y + 14}" font-size="10.5" fill="var(--muted)" text-anchor="${r.days > 0 ? "start" : "end"}">${r.days > 0 ? "+" + r.days + "j" : r.days + "j"}</text>`;
  });
  return `<div class="scrollx">${g}</svg></div><div class="legend"><span><i class="sq green"></i>marge (avance)</span><span><i class="sq red"></i>retard sur échéance</span></div>`;
}
function vbar(rows){   // barres verticales [{label,value}]
  const max = Math.max(1, ...rows.map(r => r.value));
  const barW = 30, gap = 8, H = 130, padB = 24, padT = 10, padL = 18;
  const W = padL + rows.length * (barW + gap) + 8, plotH = H - padB - padT;
  const y = v => padT + plotH - (v / max) * plotH;
  let g = `<svg width="${W}" height="${H}" class="chart">`;
  rows.forEach((r, i) => {
    const bx = padL + i * (barW + gap);
    if(r.value > 0) g += `<rect x="${bx}" y="${y(r.value)}" width="${barW}" height="${y(0) - y(r.value)}" fill="var(--green)"/>`;
    g += `<text x="${bx + barW / 2}" y="${y(r.value) - 3}" font-size="9" fill="var(--muted)" text-anchor="middle">${r.value || ""}</text>`;
    g += `<text x="${bx + barW / 2}" y="${H - 8}" font-size="8" fill="var(--faint)" text-anchor="middle">${esc(r.label)}</text>`;
  });
  return `<div class="scrollx">${g}</svg></div>`;
}

function donutChart(rows){   // [{label,value,color}]
  const total = rows.reduce((a, x) => a + x.value, 0);
  if(!total) return `<div class="empty">—</div>`;
  const cx = 70, cy = 70, R = 54, Ri = 33;
  let ang = -Math.PI / 2, seg = "";
  rows.forEach(x => {
    if(x.value <= 0) return;
    const a0 = ang, a1 = ang + (x.value / total) * 2 * Math.PI; ang = a1;
    const lrg = (a1 - a0) > Math.PI ? 1 : 0;
    const p = (rr, a) => `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
    seg += `<path d="M${p(R, a0)} A${R},${R} 0 ${lrg} 1 ${p(R, a1)} L${p(Ri, a1)} A${Ri},${Ri} 0 ${lrg} 0 ${p(Ri, a0)} Z" fill="${x.color}"><title>${esc(x.label)}: ${x.value}</title></path>`;
  });
  const lg = rows.filter(x => x.value > 0).map(x => `<span class="lg"><i style="background:${x.color}"></i>${esc(x.label)} <b>${x.value}</b></span>`).join("");
  return `<div class="donutwrap"><svg width="140" height="140" viewBox="0 0 140 140">${seg}` +
    `<text x="70" y="68" text-anchor="middle" font-size="22" font-weight="700" fill="var(--ink)">${total}</text>` +
    `<text x="70" y="84" text-anchor="middle" font-size="9" fill="var(--muted)">total</text></svg><div class="dlegend">${lg}</div></div>`;
}

function thresholdBar(value, limit, max, unit, over){   // jauge linéaire avec repère de limite
  unit = unit || ""; if(over === undefined) over = limit > 0 && value > limit;
  const W = 250, padL = 6, barW = W - 12, bh = 18, y = 26;
  max = Math.max(max, value, limit, 1);
  const fill = Math.min(value, max) / max, lm = limit / max;
  let g = `<svg width="${W}" height="58">`;
  g += `<text x="${padL}" y="18" font-size="20" font-weight="700" fill="${over ? "var(--red)" : "var(--ink)"}">${value}${unit}</text>`;
  g += `<rect x="${padL}" y="${y}" width="${barW}" height="${bh}" fill="#eee" stroke="var(--line-soft)"/>`;
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

function gauge(value, max, sub, over, unit){   // jauge radiale (demi-cercle)
  unit = unit || ""; const W = 150, H = 92, cx = 75, cy = 80, R = 58;
  const frac = Math.max(0, Math.min(1, max ? value / max : 0));
  const pol = a => `${(cx + R * Math.cos(a)).toFixed(1)},${(cy - R * Math.sin(a)).toFixed(1)}`;
  const arc = (a0, a1, col, w) => `<path d="M${pol(a0)} A${R},${R} 0 0 0 ${pol(a1)}" fill="none" stroke="${col}" stroke-width="${w}"/>`;
  const col = over ? "var(--red)" : "var(--blue)";
  return `<svg width="${W}" height="${H}">` + arc(Math.PI, 0, "var(--line-soft)", 12) + arc(Math.PI, Math.PI * (1 - frac), col, 12) +
    `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="22" font-weight="700" fill="${over ? "var(--red)" : "var(--ink)"}">${value}${unit}</text>` +
    (sub ? `<text x="${cx}" y="${cy + 11}" text-anchor="middle" font-size="9" fill="var(--muted)">${esc(sub)}</text>` : "") + `</svg>`;
}

function heatColor(cnt, cap){
  if(cnt <= 0) return "#f0f0f0";
  if(cnt > cap) return "var(--red)";
  const t = cnt / Math.max(1, cap);
  return t <= 0.34 ? "#cfe0ef" : t <= 0.67 ? "#86b0d6" : "var(--blue)";
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
    `<div class="legend"><span>peu</span><span><i class="sq" style="background:#cfe0ef;border-color:#cfe0ef"></i></span>` +
    `<span><i class="sq" style="background:#86b0d6;border-color:#86b0d6"></i></span><span><i class="sq" style="background:var(--blue);border-color:var(--blue)"></i></span>` +
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
  const chs = STORE.chantiers;
  const scheds = chs.map(c => ({c, S: computeSchedule(c)}));
  const active = chs.filter(c => colOf(c) !== "done");
  // A. Portefeuille
  const by = {todo: 0, doing: 0, block: 0, recette: 0, done: 0};
  chs.forEach(c => by[colOf(c)]++);
  const avg = active.length ? Math.round(active.reduce((a, c) => a + pct(c), 0) / active.length) : 0;
  // B. Délais
  let enRetard = 0, retardCumule = 0, lateTtl = 0; const ech7 = []; let jalon = null;
  scheds.forEach(({c, S}) => {
    if(colOf(c) !== "done" && c.echeance && S.fend > c.echeance) enRetard++;
    if(c.baseline){ const g = daysBetween(c.baseline.project_end, S.fend); if(g > 0) retardCumule += g; }
    lateTtl += c.taches.filter(t => !t.done && S.sched[t.id] && S.sched[t.id].endDate < TODAY).length;
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
  const topPers = Object.entries(byPers).sort((a, b) => b[1] - a[1]).slice(0, 3);
  // E. Recette
  let retOpen = 0, retLate = 0, iterOpen = 0;
  chs.forEach(c => { retOpen += openRetours(c).length; retLate += retoursLate(c).length; iterOpen += (c.iterations || []).filter(it => it.ouverte).length; });
  // F. Activité & hygiène
  let done7 = 0, done30 = 0, critN = 0, taskN = 0;
  chs.forEach(c => c.taches.forEach(t => { if(t.done && t.done_date){ const d = daysBetween(t.done_date, TODAY); if(d >= 0 && d <= 7) done7++; if(d >= 0 && d <= 30) done30++; } }));
  scheds.forEach(({c, S}) => c.taches.forEach(t => { if(!t.done){ taskN++; if(S.sched[t.id] && S.sched[t.id].critical) critN++; } }));
  const sansEch = active.filter(c => !c.echeance).length, sansRef = active.filter(c => !c.baseline).length;
  const critPct = taskN ? Math.round(100 * critN / taskN) : 0;

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
  const retCnt = {a_traiter: 0, en_cours: 0, fait: 0, rejete: 0};
  chs.forEach(c => allRetours(c).forEach(r => retCnt[r.statut]++));
  const retRows = [["a_traiter", "À traiter", "var(--amber)"], ["en_cours", "En cours", "var(--blue)"], ["fait", "Fait", "var(--green)"], ["rejete", "Rejeté", "var(--faint)"]]
    .map(([k, l, col]) => ({label: l, value: retCnt[k], color: col}));
  const weeks = new Array(8).fill(0);
  chs.forEach(c => c.taches.forEach(t => { if(t.done && t.done_date){ const d = daysBetween(t.done_date, TODAY); if(d >= 0){ const w = Math.floor(d / 7); if(w < 8) weeks[w]++; } } }));
  const weekRows = weeks.map((v, i) => ({label: i === 0 ? "cette sem." : "S-" + i, value: v})).reverse();

  const bubblePts = active.filter(c => c.echeance).map(c => ({label: c.titre, x: daysBetween(TODAY, c.echeance),
    y: pct(c), size: c.taches.length, color: STATUT_COLOR[colOf(c)]}));

  let h = dsection("Portefeuille");
  h += `<div class="dash-row">` + chartBox("Répartition par statut", donutChart(statutRows)) +
       chartBox("Avancement par chantier (actifs)", hbar(avancRows, {labelW: 170, barW: 170})) + `</div>`;
  h += `<div class="dash-row">` +
    chartBox("Avancement moyen", `<div class="center">${donut(avg)}<div class="muted small">des ${active.length} chantiers actifs</div></div>`) +
    chartBox("WIP — chantiers en cours", `<div class="center">${wipDots(by.doing, SETTINGS.wip_max)}` +
      `<div class="small ${by.doing > SETTINGS.wip_max ? "bad-t" : "muted"}">limite ${SETTINGS.wip_max}${by.doing > SETTINGS.wip_max ? " — dépassée" : ""}</div></div>`) + `</div>`;

  h += dsection("Délais & retards");
  h += chartBox("Carte des risques — urgence × avancement", bubbleMap(bubblePts));
  h += chartBox("Marge / retard vs échéance (jours)", divbar(retardRows));
  h += `<div class="kpis6">` +
    dkpi("Retard cumulé / réf.", retardCumule + " j", "Σ glissements", retardCumule ? "bad" : "good") +
    dkpi("Échéances < 7 j", ech7.length, ech7.slice(0, 2).join(", ") || "rien d'imminent", ech7.length ? "bad" : "") +
    dkpi("Prochain jalon", jalon ? fmt(jalon.date) : "—", jalon ? jalon.label : "aucun") +
    dkpi("Tâches/jalons en retard", lateTtl, "à rattraper", lateTtl ? "bad" : "good") + `</div>`;

  h += dsection("Charge");
  h += chartBox("Calendrier de charge — tâches actives/jour (limite " + cd.cap + ")", cd.days.length ? heatmapCalendar(cd) : `<div class="empty">—</div>`);
  h += `<div class="dash-row">` +
    chartBox("Taux d'occupation", thresholdBar(occ, 100, Math.max(occ, 100), "%")) +
    chartBox("Pic de charge", thresholdBar(peak, cd.cap, Math.max(peak, cd.cap), " tâ./j")) +
    chartBox("Jours en surcharge", thresholdBar(cd.overload, 0, Math.max(cd.days.length, 1), " j", cd.overload > 0) +
      `<div class="muted small">sur ${cd.days.length} jours d'horizon</div>`) + `</div>`;

  h += dsection("Livrables & relances");
  h += `<div class="dash-row">` + chartBox("Livrables attendus par personne", hbar(persRows, {labelW: 150, barW: 170})) +
       chartBox("Retours de recette par statut", donutChart(retRows)) + `</div>`;
  h += `<div class="kpis6">` +
    dkpi("Livrables attendus", livOpen, livLate + " en retard", livLate ? "bad" : "", "setView('people')") +
    dkpi("Relances à faire", relances, "depuis " + SETTINGS.relance_jours + " j+", relances ? "bad" : "good", "setView('people')") +
    dkpi("Retours ouverts", retOpen, retLate + " en retard", retLate ? "bad" : "") +
    dkpi("Chantiers en recette", by.recette, iterOpen + " itération(s) ouverte(s)") + `</div>`;

  h += dsection("Activité & hygiène");
  h += `<div class="dash-row">` + chartBox("Tâches terminées par semaine", vbar(weekRows)) +
       chartBox("% chemin critique", `<div class="center">${donut(critPct)}<div class="muted small">${critN}/${taskN} tâches actives</div></div>`) + `</div>`;
  h += `<div class="kpis6">` +
    dkpi("Terminées (7 j)", done7, done30 + " sur 30 j", "good") +
    dkpi("Sans échéance", sansEch, "chantiers actifs", sansEch ? "bad" : "good") +
    dkpi("Sans référence figée", sansRef, "chantiers actifs") + `</div>`;

  $("dash").innerHTML = h;
}

function renderCharge(){
  const cd = chargeData();
  let h = `<div class="settings">` +
    fldNum("Capacité / jour", "capacite_jour", 1) +
    fldNum("Max chantiers en cours", "wip_max", 1) +
    fldNum("Relance après (j)", "relance_jours", 1) +
    `<label class="fld"><input type="checkbox" ${SETTINGS.jours_ouvres ? "checked" : ""} ` +
    `onchange="saveSetting('jours_ouvres',this.checked)"> Jours ouvrés (exclure week-ends)</label></div>`;
  h += `<div class="ch-h">Plan de charge — tâches actives par jour · limite <b>${cd.cap}</b> · horizon 120 j</div>`;
  if(!cd.days.length){ $("charge").innerHTML = h + `<div class="empty">Aucune tâche active planifiée.</div>`; return; }
  h += chargeChart(cd);
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
      h += `<div class="muted small" style="margin-bottom:10px">Aucune tâche déplaçable (toutes les tâches des jours surchargés sont sur le chemin critique, sans marge). Réduis la charge en allongeant une échéance ou en retirant une tâche.</div>`;
    }
    h += `<div class="ch-h">Jours en surcharge (${over.length})</div>`;
    over.forEach(x => {
      h += `<div class="overday"><b>${fmt(x.date)}</b> — ${x.count} tâches (limite ${cd.cap})<ul>` +
        x.tasks.map(t => `<li>${esc(t.label)} <span class="muted">— ${esc(t.chantier)}</span>${t.slack > 0 ? ` <span class="movable">marge ${t.slack} j</span>` : ` <span class="muted">(critique)</span>`}</li>`).join("") + `</ul></div>`;
    });
  } else {
    h += `<div class="ok-note">Aucune journée au-dessus de la limite de ${cd.cap} tâches.</div>`;
  }
  $("charge").innerHTML = h;
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

function renderBoard(){
  const b = $("board"); b.innerHTML = "";
  COLS.forEach(col => {
    const cards = STORE.chantiers.filter(c => colOf(c) === col.key)
                       .sort((a, c) => (a.ordre || 0) - (c.ordre || 0));
    const el = document.createElement("div");
    el.className = "col"; el.dataset.col = col.key;
    const autoNote = col.key === "block" ? ` <span class="auto">auto</span>` : "";
    el.innerHTML = `<div class="col-h"><span class="mk ${col.key}"></span>` +
      `<span class="nm">${col.label}</span>${autoNote}<span class="ct">${cards.length}</span></div>`;
    if(col.key !== "block"){   // la colonne Bloqué est calculée → pas une cible de drop
      el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("over"); });
      el.addEventListener("dragleave", () => el.classList.remove("over"));
      el.addEventListener("drop", e => {
        e.preventDefault(); el.classList.remove("over");
        const id = e.dataTransfer.getData("id"); const c = chById(id);
        if(c && c.statut !== col.key) mutate({op: "move_chantier", id, statut: col.key});
      });
    }
    cards.forEach(c => {
      const open = openAtt(c), late = lateAtt(c);
      const card = document.createElement("div");
      card.className = "card" + (late.length ? " w-late" : (open.length ? " w-wait" : ""));
      card.draggable = true;
      card.addEventListener("dragstart", e => { e.dataTransfer.setData("id", c.id); card.classList.add("drag"); });
      card.addEventListener("dragend", () => card.classList.remove("drag"));
      card.onclick = () => openChantier(c.id);
      const p = pct(c), lateDue = c.statut !== "done" && isLate(c.echeance);
      let h = `<div class="c-title">${esc(c.titre)}</div>`;
      h += `<div class="c-prog"><span class="track"><i style="width:${p}%"></i></span><span class="pc">${p}%</span></div>`;
      h += `<div class="c-meta"><span class="due ${lateDue ? "late" : ""}">${fmt(c.echeance)}</span>` +
           `<span class="pr-${c.prio}">Priorité ${PRIO[c.prio]}</span></div>`;
      if((c.tags || []).length) h += `<div class="chips">` + c.tags.map(t => `<span class="chip">${esc(t)}</span>`).join("") + `</div>`;
      if(c.statut === "recette"){
        const it = currentIter(c), or = openRetours(c).length;
        h += `<div class="tag rec">Recette · it. ${it ? it.num : 1} · ${or} retour(s) ouvert(s)</div>`;
      }
      if(open.length){
        const names = [...new Set(open.map(a => a.personne))].join(", ");
        h += `<div class="tag ${late.length ? "late" : ""}">${late.length ? "En retard" : "En attente"} · ${esc(names)}</div>`;
      }
      if(c.blocage) h += `<div class="blk"><span class="lab">Bloqué</span>${esc(c.blocage)}</div>`;
      const lt = lateTasks(c).length;
      if(lt) h += `<div class="tag late">${lt} tâche(s) en retard</div>`;
      card.innerHTML = h; el.appendChild(card);
    });
    b.appendChild(el);
  });
}

function renderPeople(){
  const map = {};
  STORE.chantiers.forEach(c => c.livrables.forEach(l => {
    (map[l.personne] = map[l.personne] || {role: l.role, items: []}).items.push({...l, chantier: c.titre});
  }));
  const w = $("people"); w.innerHTML = "";
  const names = Object.keys(map).sort((a, b) => a.localeCompare(b));
  if(!names.length){ w.innerHTML = `<div class="empty">Aucune attente enregistrée.</div>`; return; }
  names.forEach(nom => {
    const info = map[nom];
    const el = document.createElement("div"); el.className = "person";
    let h = `<h3>${esc(nom)}</h3><div class="role">${esc(info.role || "")}</div>`;
    info.items.forEach(it => {
      const late = (it.statut === "attente" || it.statut === "partiel") && isLate(it.date);
      const cls = it.statut === "recu" ? "recu" : it.statut === "annule" ? "annule"
                : it.statut === "partiel" ? "partiel" : (late ? "retard" : "attente");
      h += `<div class="deliv"><span class="stm ${cls}"></span><div><div class="q">${esc(it.quoi)}</div>` +
           `<div class="meta ${late ? "late" : ""}"><b>${esc(it.chantier)}</b> · attendu le ${fmt(it.date)} · ` +
           `${late ? "EN RETARD" : LIV[it.statut]}</div></div></div>`;
    });
    el.innerHTML = h; w.appendChild(el);
  });
}

// ======================================================================== //
//  CPM — planning calcule (dates, marges, chemin critique)
// ======================================================================== //
function computeSchedule(c){
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
    if(t.done && t.done_date){
      ffIdx = Math.max(0, workOffset(start, t.done_date));   // fin = date reelle de completion
      fsIdx = Math.max(0, ffIdx - dur(t));                    // barre = sa duree (pas un trou geant)
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

  return {start, projectDays, sched, byId, preds, cycle, order, gateInfo,
          end: addUnits(start, projectDays),
          fc, fendIdx, fend: addUnits(start, fendIdx),
          baseline: c.baseline || null};
}

// ======================================================================== //
//  Page detaillee d'un chantier
// ======================================================================== //
function openChantier(id){ CUR = id; renderPage(); showView("page"); window.scrollTo(0, 0); }
function backToBoard(){ CUR = null; showView("board"); }
document.addEventListener("keydown", e => { if(e.key === "Escape" && CUR) backToBoard(); });

function renderPage(){
  const c = chById(CUR); if(!c){ backToBoard(); return; }
  const S = computeSchedule(c);
  const p = pct(c);
  const col = COLS.find(k => k.key === c.statut);
  const jr = c.echeance ? daysBetween(TODAY, c.echeance) : null;
  const bl = S.baseline;
  const blocked = isBlocked(c);

  let h = "";
  // En-tete
  h += `<div class="pg-top">`;
  h += `<button class="ghost" onclick="backToBoard()">← Tableau</button>`;
  const statusTxt = blocked ? `Bloqué (auto) — ${esc(blockReason(c))}` : col.label;
  h += `<div class="pg-titlewrap"><div class="d-status ${blocked ? "block" : c.statut}">${statusTxt} · priorité ${PRIO[c.prio]}</div>` +
       `<h2 class="pg-title" contenteditable="true" onblur="saveField('titre',this.textContent)">${esc(c.titre)}</h2></div>`;
  h += `<div class="grow"></div>`;
  h += `<select onchange="mutate({op:'move_chantier',id:'${c.id}',statut:this.value})" class="sel" title="État d'avancement (Bloqué est calculé)">` +
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

  // Colonnes : gauche (objectif, anneau, échéance, parties, tags, blocage) / droite (visuels)
  h += `<div class="pg-grid"><div class="pg-left">`;

  h += card("Objectif", `<textarea onblur="mutate({op:'update_chantier',id:'${c.id}',objectif:this.value})" ` +
            `placeholder="Décris l'objectif…">${esc(c.objectif || "")}</textarea>`);

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

  // Tags
  h += card(`Tags <span class="add" onclick="showAddTag('${c.id}')">+ ajouter</span>`,
    `<div class="chips edit">` + (c.tags.length ? c.tags.map(t =>
      `<span class="chip">${esc(t)} <span class="x" onclick="mutate({op:'remove_tag',chantier_id:'${c.id}',tag:'${esc(t)}'})">×</span></span>`).join("")
      : `<span class="empty">Aucun tag.</span>`) + `</div><div id="addTag_${c.id}"></div>`);

  // Blocage
  h += card("Point bloquant", `<textarea placeholder="Qu'est-ce qui bloque ?" ` +
            `onblur="mutate({op:'update_chantier',id:'${c.id}',blocage:this.value})">${esc(c.blocage || "")}</textarea>`);

  h += `</div><div class="pg-right">`;

  // Tâches (checklist enrichie)
  h += card(`Plan de tâches <span class="add" onclick="showAddTache('${c.id}')">+ tâche</span>`, taskTable(c, S));

  // Recette / itérations (retours utilisateurs)
  if(c.statut === "recette" || (c.iterations || []).length)
    h += card(`Recette / Itérations <span class="add" onclick="showAddRetour('${c.id}')">+ retour</span>`, recetteCard(c));

  // Gantt
  h += card("Diagramme de Gantt", S.cycle ? cycleWarn() : ganttSVG(c, S));

  // PERT
  h += card("Réseau PERT — chemin critique", S.cycle ? cycleWarn() : pertSVG(c, S));

  // Livrables
  h += card(`Ce que j'attends <span class="add" onclick="showAddLiv('${c.id}')">+ livrable</span>`, livrablesBlock(c));

  // Courbe d'avancement
  h += card("Avancement dans le temps", progressCurve(c, S));

  // Historique
  h += card(`Historique <span class="add" onclick="showAddNote('${c.id}')">+ note</span>`,
    `<div id="addNote_${c.id}"></div>` + (c.histo.length
      ? c.histo.map(e => `<div class="hist"><span class="d">${fmt(e.d)}</span>${esc(e.t)}</div>`).join("")
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
function card(title, body){
  return `<section class="cardx"><div class="cardx-h">${title}</div><div class="cardx-b">${body}</div></section>`;
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
    h += `<div class="muted small">Référence figée le <b>${fmt(S.baseline.frozen_at)}</b> — fin prévue alors : <b>${fmt(S.baseline.project_end)}</b></div>`;
    h += `<div class="small ${rd > 0 ? "bad-t" : rd < 0 ? "good-t" : ""}">${rd > 0 ? "Glissement de +" + rd + " j" : rd < 0 ? Math.abs(rd) + " j d'avance" : "Conforme à la référence"}</div>`;
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

function taskTable(c, S){
  if(!c.taches.length) return `<div class="empty">Aucune tâche — ajoute des tâches (durée + prédécesseurs) pour générer le Gantt et le PERT.</div><div id="addTache_${c.id}"></div>`;
  const lbl = {}; c.taches.forEach(x => lbl[x.id] = x.label);
  let h = `<div class="ttable">`;
  S.order.forEach(id => {
    const s = S.sched[id], t = s.task;
    const fixed = !!t.start_fix;
    h += `<div class="trow ${s.critical ? "crit" : ""}">`;
    // ligne 1 : etat + libelle + jalon + suppr
    h += `<div class="trow-main">`;
    h += `<span class="box ${t.done ? "ok" : ""}" title="Fait / à faire" onclick="mutate({op:'toggle_tache',chantier_id:'${c.id}',tache_id:'${t.id}'})"></span>`;
    h += `<input class="tlabel ${t.done ? "done" : ""}" value="${esc(t.label)}" ` +
         `onblur="if(this.value.trim()&&this.value!=='${esc(t.label)}')mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',label:this.value.trim()})">`;
    h += `<label class="ms" title="Jalon (durée 0)"><input type="checkbox" ${t.is_milestone ? "checked" : ""} ` +
         `onchange="mutate({op:'update_tache',chantier_id:'${c.id}',tache_id:'${t.id}',is_milestone:this.checked})"> jalon</label>`;
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
        ? `<span class="gate wait">⊘ attend : ${pend.map(l => esc(l.quoi) + " (" + esc(l.personne) + (l.date ? ", " + fmtShort(l.date) : "") + ")").join(" · ")}</span>`
        : `<span class="gate ok">✓ livrable reçu</span>`;
    }
    h += `</div></div>`;
  });
  h += `</div><div id="addTache_${c.id}"></div>`;
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
  const duree = Math.max(0, daysBetween(eff, val));
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

function ganttSVG(c, S){
  const tasks = S.order; if(!tasks.length) return `<div class="empty">—</div>`;
  const bl = S.baseline;
  const blById = {}; if(bl) bl.tasks.forEach(b => blById[b.id] = b);
  const tIdx = workOffset(S.start, TODAY);
  let days = Math.max(1, S.projectDays, S.fendIdx, tIdx);
  if(bl) bl.tasks.forEach(b => days = Math.max(days, workOffset(S.start, b.end)));
  const hasBl = !!bl;
  const labelW = 180, dayW = Math.max(9, Math.min(28, Math.floor(740 / days))), rowH = hasBl ? 30 : 26, top = 28;
  const W = labelW + days * dayW + 30, H = top + tasks.length * rowH + 16;
  const x = d => labelW + d * dayW;
  let g = `<div class="scrollx"><svg width="${W}" height="${H}" class="gantt">`;
  g += `<defs><marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">` +
       `<path d="M0,0 L6,3 L0,6 Z" fill="#b9b6ad"/></marker></defs>`;
  const step = days > 40 ? 5 : 1;
  for(let d = 0; d <= days; d += step){
    g += `<line x1="${x(d)}" y1="${top}" x2="${x(d)}" y2="${H - 12}" stroke="var(--line-soft)"/>`;
    g += `<text x="${x(d)}" y="${top - 8}" font-size="9" fill="var(--faint)" text-anchor="middle">${fmtShort(addUnits(S.start, d))}</text>`;
  }
  if(tIdx >= 0 && tIdx <= days) g += `<line x1="${x(tIdx)}" y1="${top}" x2="${x(tIdx)}" y2="${H - 12}" stroke="var(--red)" stroke-dasharray="3 3"/>`;
  // fleches de dependance (positions previsionnelles)
  tasks.forEach((id, i) => {
    S.preds[id].forEach(p => {
      const j = tasks.indexOf(p); if(j < 0) return;
      const x1 = x(S.fc[p].ffIdx), y1 = top + j * rowH + rowH / 2;
      const x2 = x(S.fc[id].fsIdx), y2 = top + i * rowH + rowH / 2;
      g += `<path d="M${x1},${y1} C${x1 + 12},${y1} ${x2 - 12},${y2} ${x2},${y2}" fill="none" stroke="#cdcabf" stroke-width="1" marker-end="url(#ah)"/>`;
    });
  });
  // barres
  tasks.forEach((id, i) => {
    const s = S.sched[id], f = S.fc[id], t = s.task, y0 = top + i * rowH + 5;
    g += `<text x="${labelW - 8}" y="${y0 + 10}" font-size="11" text-anchor="end" fill="var(--ink)">${esc(t.label.slice(0, 26))}</text>`;
    // reference (fantome) derriere
    if(hasBl && blById[id]){
      const bs = workOffset(S.start, blById[id].start), be = workOffset(S.start, blById[id].end);
      if(t.is_milestone){
        g += `<path d="M${x(bs)},${y0 + 4} L${x(bs) + 5},${y0 + 9} L${x(bs)},${y0 + 14} L${x(bs) - 5},${y0 + 9} Z" fill="none" stroke="#c9c6bc"/>`;
      } else {
        g += `<rect x="${x(bs)}" y="${y0 + 1}" width="${Math.max(2, (be - bs) * dayW)}" height="6" rx="1" fill="#e3e0d7"/>`;
      }
    }
    const y = hasBl ? y0 + 9 : y0;
    if(t.is_milestone){
      const cx = x(f.fsIdx), cy = y + 8, r = 6;
      g += `<path d="M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z" fill="${s.critical ? "var(--red)" : "var(--ink)"}"/>`;
    } else {
      const bx = x(f.fsIdx), bw = Math.max(3, (f.ffIdx - f.fsIdx) * dayW);
      const fill = t.done ? "var(--green)" : (s.critical ? "var(--red)" : (f.late ? "var(--amber)" : "var(--blue)"));
      g += `<rect x="${bx}" y="${y}" width="${bw}" height="14" rx="2" fill="${fill}" opacity="${t.done ? .85 : 1}"/>`;
    }
  });
  g += `</svg></div>`;
  g += `<div class="legend"><span><i class="sq red"></i>critique</span><span><i class="sq blue"></i>tâche</span>` +
       `<span><i class="sq amberb"></i>en glissement</span><span><i class="sq green"></i>terminée</span>` +
       (hasBl ? `<span><i class="sq refb"></i>référence figée</span>` : ``) + `<span><i class="dia"></i>jalon</span></div>`;
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
       `<path d="M0,0 L6,3 L0,6 Z" fill="#9d9a90"/></marker>` +
       `<marker id="apc" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">` +
       `<path d="M0,0 L6,3 L0,6 Z" fill="var(--red)"/></marker></defs>`;
  // arcs
  tasks.forEach(id => S.preds[id].forEach(p => {
    if(!pos[p] || !pos[id]) return;
    const a = pos[p], b = pos[id];
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    const crit = S.sched[p].critical && S.sched[id].critical;
    g += `<path d="M${x1},${y1} C${x1 + 28},${y1} ${x2 - 28},${y2} ${x2},${y2}" fill="none" ` +
         `stroke="${crit ? "var(--red)" : "#bdbab0"}" stroke-width="${crit ? 2 : 1}" marker-end="url(#${crit ? "apc" : "ap"})"/>`;
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
        g += `<text x="${labelW - 8}" y="${y + 4}" font-size="10.5" text-anchor="end" fill="var(--ink)">${esc(l.personne.slice(0, 18))}</text>`;
        g += `<line x1="${labelW}" y1="${y}" x2="${labelW + 520}" y2="${y}" stroke="var(--line-soft)"/>`;
        if(l.date){
          const late = (l.statut === "attente" || l.statut === "partiel") && isLate(l.date);
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
    const late = (l.statut === "attente" || l.statut === "partiel") && isLate(l.date);
    const cls = l.statut === "recu" ? "recu" : l.statut === "annule" ? "annule"
              : l.statut === "partiel" ? "partiel" : (late ? "retard" : "attente");
    h += `<div class="d-deliv"><span class="stm ${cls}" style="margin-top:6px"></span><div>` +
      `<div class="q">${esc(l.quoi)}</div>` +
      `<div class="meta ${late ? "late" : ""}"><b>${esc(l.personne)}</b>${l.role ? " · " + esc(l.role) : ""} · attendu le ${fmt(l.date)} · ${late ? "EN RETARD" : LIV[l.statut]}</div>` +
      (l.impact ? `<div class="relance">Impact : ${esc(l.impact)}</div>` : "") +
      (l.relances ? `<div class="relance">relancé ${l.relances}× · dernière le ${fmt(l.derniere)}</div>` : "") +
      `<div class="acts"><select onchange="mutate({op:'update_livrable',chantier_id:'${c.id}',livrable_id:'${l.id}',statut:this.value})">` +
        Object.keys(LIV).map(s => `<option value="${s}" ${l.statut === s ? "selected" : ""}>${LIV[s]}</option>`).join("") + `</select>` +
      `<select title="Rattacher à une tâche : elle attend ce livrable" onchange="mutate({op:'update_livrable',chantier_id:'${c.id}',livrable_id:'${l.id}',tache_id:this.value})">` +
        `<option value="">— ne bloque aucune tâche —</option>` +
        c.taches.map(t => `<option value="${t.id}" ${l.tache_id === t.id ? "selected" : ""}>bloque : ${esc(t.label)}</option>`).join("") + `</select>` +
      `<a onclick="mutate({op:'update_livrable',chantier_id:'${c.id}',livrable_id:'${l.id}',relance:true})">Relancé aujourd'hui</a>` +
      `<a class="danger" onclick="if(confirm('Supprimer ce livrable ?'))mutate({op:'remove_livrable',chantier_id:'${c.id}',livrable_id:'${l.id}'})">Supprimer</a>` +
      `</div></div></div>`;
  });
  h += `<div id="addLiv_${c.id}"></div>`;
  return h;
}

function recetteCard(c){
  const its = c.iterations || [];
  const it = currentIter(c);
  let h = "";
  if(!it){
    return `<div class="empty">Aucune itération. <a class="lnk" onclick="mutate({op:'add_iteration',chantier_id:'${c.id}'})">Démarrer l'itération 1</a></div>`;
  }
  // itération courante
  const done = it.retours.filter(r => r.statut === "fait" || r.statut === "rejete").length;
  h += `<div class="iter-h"><b>Itération ${it.num}</b> ${it.ouverte ? '<span class="iopen">ouverte</span>' : '<span class="iclosed">clôturée</span>'}` +
       ` · ouverte le ${fmt(it.date)} · ${done}/${it.retours.length} traités`;
  h += `<span class="iter-acts">` +
       (it.ouverte ? `<a onclick="mutate({op:'close_iteration',chantier_id:'${c.id}',iteration_id:'${it.id}'})">Clôturer</a> ` : ``) +
       `<a onclick="mutate({op:'add_iteration',chantier_id:'${c.id}'})">+ nouvelle itération</a></span></div>`;
  h += `<div id="addRetour_${c.id}"></div>`;
  // retours de l'itération courante (priorité haute d'abord, ouverts d'abord)
  const ord = {a_traiter: 0, en_cours: 1, fait: 2, rejete: 3}, pr = {h: 0, m: 1, b: 2};
  const rs = it.retours.slice().sort((a, b) => ord[a.statut] - ord[b.statut] || pr[a.priorite] - pr[b.priorite]);
  if(!rs.length) h += `<div class="empty">Aucun retour pour cette itération.</div>`;
  rs.forEach(r => h += retourRow(c, it, r));
  // itérations passées
  const past = its.filter(x => x.id !== it.id);
  if(past.length){
    h += `<div class="past"><div class="fl">Itérations précédentes</div>`;
    past.sort((a, b) => b.num - a.num).forEach(x => {
      const o = x.retours.filter(r => r.statut === "a_traiter" || r.statut === "en_cours").length;
      h += `<div class="past-line">Itération ${x.num} · ${x.retours.length} retour(s)${o ? ` · <span class="bad-t">${o} encore ouvert(s)</span>` : ` · soldée`} · ${fmt(x.date)}</div>`;
    });
    h += `</div>`;
  }
  return h;
}
function retourRow(c, it, r){
  const late = (r.statut === "a_traiter" || r.statut === "en_cours") && isLate(r.echeance);
  return `<div class="retour"><span class="rdot ${r.statut}" title="${RET[r.statut]}"></span><div class="rbody">` +
    `<div class="rq pr-${r.priorite}">${esc(r.quoi)}</div>` +
    `<div class="rmeta ${late ? "late" : ""}">${r.de ? "de <b>" + esc(r.de) + "</b> · " : ""}priorité ${PRIO[r.priorite]}` +
    `${r.echeance ? " · pour le " + fmt(r.echeance) + (late ? " (en retard)" : "") : ""}${r.date ? " · reçu le " + fmt(r.date) : ""}</div>` +
    `<div class="acts">` +
    `<select onchange="mutate({op:'update_retour',chantier_id:'${c.id}',iteration_id:'${it.id}',retour_id:'${r.id}',statut:this.value})">` +
      Object.keys(RET).map(s => `<option value="${s}" ${r.statut === s ? "selected" : ""}>${RET[s]}</option>`).join("") + `</select>` +
    `<select onchange="mutate({op:'update_retour',chantier_id:'${c.id}',iteration_id:'${it.id}',retour_id:'${r.id}',priorite:this.value})">` +
      ["h", "m", "b"].map(x => `<option value="${x}" ${r.priorite === x ? "selected" : ""}>${PRIO[x]}</option>`).join("") + `</select>` +
    `<a class="danger" onclick="if(confirm('Supprimer ce retour ?'))mutate({op:'remove_retour',chantier_id:'${c.id}',iteration_id:'${it.id}',retour_id:'${r.id}'})">Supprimer</a>` +
    `</div></div></div>`;
}
function showAddRetour(cid){
  const c = chById(cid), it = currentIter(c);
  if(!it){ mutate({op: "add_iteration", chantier_id: cid}); return; }
  $("addRetour_" + cid).innerHTML =
    `<div class="miniform"><input id="rq" placeholder="Retour / demande de modif">` +
    `<div class="row"><input id="rde" placeholder="De qui (utilisateur)">` +
    `<select id="rpr"><option value="h">haute</option><option value="m" selected>moyenne</option><option value="b">basse</option></select>` +
    `<span class="fld"><span class="fl">échéance</span><input id="rech" type="date"></span></div>` +
    `<div class="actions"><button class="btn sm" onclick="hide('addRetour_${cid}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addRetour('${cid}')">Ajouter</button></div></div>`;
  $("rq").focus();
  $("rq").addEventListener("keydown", e => { if(e.key === "Enter") addRetour(cid); });
}
function addRetour(cid){
  const c = chById(cid), it = currentIter(c);
  const quoi = $("rq").value.trim(); if(!quoi || !it) return;
  mutate({op: "add_retour", chantier_id: cid, iteration_id: it.id, quoi,
          de: $("rde").value.trim(), priorite: $("rpr").value, echeance: $("rech").value || null});
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
  g += `<line x1="${padL}" y1="${y(0)}" x2="${x(idealEnd)}" y2="${y(total)}" stroke="#cdcabf" stroke-dasharray="4 3"/>`;
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
    CUR = null; renderAll(); showView("board");
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
  $("addPartie_" + id).innerHTML =
    `<div class="miniform"><div class="row"><input id="ppn" placeholder="Nom"><input id="ppr" placeholder="Rôle"></div>` +
    `<div class="actions"><button class="btn sm" onclick="hide('addPartie_${id}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addPartie('${id}')">Ajouter</button></div></div>`;
  $("ppn").focus();
}
function addPartie(id){ const v = $("ppn").value.trim(); if(v) mutate({op: "add_partie", chantier_id: id, nom: v, role: $("ppr").value.trim()}); }

function showAddTag(id){
  $("addTag_" + id).innerHTML =
    `<div class="miniform"><input id="tgv" placeholder="Tag (ex. Power BI)">` +
    `<div class="actions"><button class="btn sm" onclick="hide('addTag_${id}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addTag('${id}')">Ajouter</button></div></div>`;
  $("tgv").focus();
  $("tgv").addEventListener("keydown", e => { if(e.key === "Enter") addTag(id); });
}
function addTag(id){ const v = $("tgv").value.trim(); if(v) mutate({op: "add_tag", chantier_id: id, tag: v}); }

function contactOptions(sel){
  let o = `<option value="">— saisir un nom —</option>`;
  STORE.contacts.forEach(c => { o += `<option value="${c.id}" ${sel === c.id ? "selected" : ""}>${esc(c.nom)}${c.role ? " (" + esc(c.role) + ")" : ""}</option>`; });
  return o;
}
function showAddLiv(id){
  $("addLiv_" + id).innerHTML =
    `<div class="miniform">` +
    `<div class="row"><select id="lvc" onchange="lvContactChange()">${contactOptions("")}</select></div>` +
    `<div class="row" id="lvname"><input id="lvp" placeholder="Personne"><input id="lvr" placeholder="Rôle / service"></div>` +
    `<input id="lvq" placeholder="Ce que tu attends (le livrable)">` +
    `<div class="row"><input id="lvd" type="date"><select id="lvs">` +
      Object.keys(LIV).map(s => `<option value="${s}">${LIV[s]}</option>`).join("") + `</select></div>` +
    `<input id="lvi" placeholder="Impact si en retard (optionnel)">` +
    `<div class="actions"><button class="btn sm" onclick="hide('addLiv_${id}')">Annuler</button>` +
    `<button class="btn sm primary" onclick="addLiv('${id}')">Ajouter</button></div></div>`;
}
function lvContactChange(){ $("lvname").style.display = $("lvc").value ? "none" : "flex"; }
function addLiv(id){
  const cid = $("lvc").value;
  const op = {op: "add_livrable", chantier_id: id, quoi: $("lvq").value.trim(),
              date: $("lvd").value || null, statut: $("lvs").value, impact: $("lvi").value.trim()};
  if(cid) op.contact_id = cid; else { op.personne = $("lvp").value.trim(); op.role = $("lvr").value.trim(); }
  if(!op.quoi){ alert("Indique ce que tu attends."); return; }
  if(!cid && !op.personne){ alert("Indique de qui tu l'attends."); return; }
  mutate(op);
}
function hide(id){ if($(id)) $(id).innerHTML = ""; }

function newChantier(){
  const titre = prompt("Titre du nouveau chantier :");
  if(titre && titre.trim()) mutate({op: "create_chantier", titre: titre.trim(), statut: "todo", prio: "m"});
}

loadStore();
