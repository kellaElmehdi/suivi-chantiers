#!/usr/bin/env node
// tools/shots.mjs — captures et contrôles de l'interface, sans aucune dépendance :
// Edge headless piloté par le protocole DevTools (WebSocket natif de Node >= 22).
// Le serveur doit tourner (Suivi.bat -> http://127.0.0.1:8765). Rien n'est modifié :
// l'outil ne fait que passer d'écran en écran.
//
//   node tools/shots.mjs                                  tous les écrans à 1440 px
//   node tools/shots.mjs --widths 1280,1440,1920          plusieurs largeurs
//   node tools/shots.mjs --views board,page --full        pages entières (défilement compris)
//   node tools/shots.mjs --check nav,errors --no-shots    contrôles seuls ; code de sortie 1 si échec
//   node tools/shots.mjs --out C:/temp/avant              dossier de sortie (défaut : %TEMP%/suivi-shots)
//
// Contrôles (--check) :
//   nav     aucun onglet de la barre sur deux lignes, header sans débordement
//   ph      chaque écran commence par un seul en-tête de page (.ph)
//   emoji   aucun emoji dans un bouton (hors icônes de thème, qui sont des données)
//   errors  aucune exception ni console.error pendant le parcours
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = k => argv.includes('--' + k);
const APP = opt('url', 'http://127.0.0.1:8765/');
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'suivi-shots')));
const WIDTHS = opt('widths', '1440').split(',').map(Number).filter(Boolean);
const HEIGHT = +opt('height', 900);
const ONLY = opt('views', '').split(',').filter(Boolean);
const CHECKS = opt('check', '').split(',').filter(Boolean);
const SHOTS = !flag('no-shots');
const FULL = flag('full');
// Les icônes de thème (choisies par l'utilisateur) et les valeurs affichées par les listes
// déroulantes (types de note, thèmes…) sont des données, pas des icônes de commande.
const EMOJI_OK = '.th-fb, .th-chip, .th-ic, [data-th], .cse';

const EDGE = ['ProgramFiles(x86)', 'ProgramFiles'].map(v => process.env[v]).filter(Boolean)
  .map(p => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(p => fs.existsSync(p));
if(!EDGE){ console.error('Microsoft Edge introuvable.'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => http.get(u, r => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => { try{ res(JSON.parse(d)); }catch(e){ rej(e); } });
}).on('error', rej));

// ---- fonctions exécutées DANS la page (sérialisées par toString : aucune variable extérieure)
function openDetail(kind){
  const cs = STORE.chantiers;
  const c = kind === 'cdc' ? (cs.find(x => x.cdc) || cs[0])
          : (cs.find(x => !x.hold && x.statut !== 'done' && (x.taches || []).length > 3) || cs[0]);
  if(kind === 'cdc') openCdc(c.id); else openChantier(c.id);
  return c.titre;
}
function probe(emojiOk){
  const el = document.getElementById(SHOWN);
  const kids = [...el.children].filter(k => k.getBoundingClientRect().height > 0);
  const first = kids[0] || null;
  const hdr = document.querySelector('header');
  const navWrapped = [...document.querySelectorAll('#nav > button, #nav .menu > button')]
    .filter(b => b.getBoundingClientRect().height > 34).map(b => b.textContent.trim());
  const pict = /\p{Extended_Pictographic}/u;
  const emoji = [...el.querySelectorAll('button, .btn, .ghost')]
    .filter(b => !b.closest(emojiOk) && pict.test(b.textContent)).map(b => b.textContent.trim().slice(0, 32));
  return {
    view: SHOWN,
    first: first ? (first.getAttribute('class') || first.tagName.toLowerCase()) : '(vide)',
    phFirst: !!(first && first.classList.contains('ph')),
    phCount: el.querySelectorAll('.ph').length,
    padding: getComputedStyle(el).padding,
    width: first ? Math.round(first.getBoundingClientRect().width) : 0,
    navWrapped,
    headerOverflow: hdr.scrollWidth > hdr.clientWidth + 1,
    alertH: Math.round(document.getElementById('alert').getBoundingClientRect().height),
    emoji: emoji.slice(0, 6), emojiCount: emoji.length,
  };
}
function fullHeight(){
  const w = document.querySelector('.work'), f = document.querySelector('.app-footer');
  return Math.ceil(w.getBoundingClientRect().top + w.scrollHeight + (f ? f.offsetHeight : 0));
}

async function main(){
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'suivi-edge-'));
  const edge = spawn(EDGE, ['--headless', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {stdio: 'ignore'});
  const stop = () => {
    try{ if(process.platform === 'win32') spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], {stdio: 'ignore'}); else edge.kill(); }catch(e){}
    try{ fs.rmSync(profile, {recursive: true, force: true}); }catch(e){}
  };
  try{
    let tabs = null;
    for(let i = 0; i < 80 && !tabs; i++){ try{ tabs = await getJSON(`http://127.0.0.1:${port}/json`); }catch(e){ await sleep(250); } }
    const tab = (tabs || []).find(t => t.type === 'page');
    if(!tab) throw new Error('Edge ne répond pas sur le port de débogage.');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
    let seq = 0; const pending = new Map(); const errors = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if(m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); return; }
      if(m.method === 'Runtime.exceptionThrown'){ const d = m.params.exceptionDetails; errors.push((d.exception && d.exception.description) || d.text); }
      if(m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    };
    const send = (method, params = {}) => new Promise(r => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
    const run = async (fn, ...args) => {
      const r = await send('Runtime.evaluate', {expression: `(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`, returnByValue: true, awaitPromise: true});
      if(r.result && r.result.exceptionDetails){ const d = r.result.exceptionDetails; throw new Error((d.exception && d.exception.description) || d.text); }
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const size = (w, h) => send('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: false});
    const shot = async file => { const r = await send('Page.captureScreenshot', {format: 'png'}); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); };

    await send('Page.enable'); await send('Runtime.enable');
    await size(WIDTHS[0], HEIGHT);
    await send('Page.navigate', {url: APP});
    let ready = false;
    for(let i = 0; i < 60 && !ready; i++){
      await sleep(250);
      ready = await run(() => typeof SHOWN !== 'undefined' && SHOWN !== null && STORE.chantiers.length > 0).catch(() => false);
    }
    if(!ready) throw new Error(`L'application ne s'est pas chargée (${APP}). Le serveur tourne-t-il ?`);

    const all = await run(() => VIEWS.map(v => v.id));
    const screens = ONLY.length ? all.filter(v => ONLY.includes(v)) : all;
    if(SHOTS) fs.mkdirSync(OUT, {recursive: true});
    const rows = [];
    for(const w of WIDTHS){
      await size(w, HEIGHT); await sleep(300);
      for(const s of screens){
        const before = errors.length;
        if(s === 'page' || s === 'cdc') await run(openDetail, s); else await run(v => setView(v), s);
        await sleep(600);
        const m = await run(probe, EMOJI_OK);
        m.width_vp = w; m.errors = errors.slice(before);
        rows.push(m);
        if(SHOTS){
          if(FULL){ await size(w, Math.min(12000, Math.max(HEIGHT, await run(fullHeight)))); await sleep(300); }
          await shot(path.join(OUT, `${s}-${w}.png`));
          if(FULL){ await size(w, HEIGHT); await sleep(200); }
        }
      }
    }
    ws.close();

    // ---- rapport
    const fails = [];
    const check = (name, r, bad, why) => { if(CHECKS.includes(name) && bad) fails.push(`${r.view}@${r.width_vp} [${name}] ${why}`); };
    rows.forEach(r => {
      check('nav', r, r.navWrapped.length || r.headerOverflow, r.headerOverflow ? 'le header déborde' : 'onglets sur 2 lignes : ' + r.navWrapped.join(', '));
      check('ph', r, !r.phFirst || r.phCount !== 1, `premier élément « ${r.first} », ${r.phCount} en-tête(s) .ph`);
      check('emoji', r, r.emojiCount, `${r.emojiCount} bouton(s) à emoji : ${r.emoji.join(' | ')}`);
      check('errors', r, r.errors.length, r.errors.join(' / ').slice(0, 300));
    });
    const pad = (s, n) => String(s).padEnd(n).slice(0, n);
    console.log(pad('écran@largeur', 16) + pad('1er élément', 24) + pad('.ph', 5) + pad('padding', 18) + pad('larg.', 7) + pad('onglets', 9) + pad('alertes', 9) + 'emoji');
    rows.forEach(r => console.log(pad(`${r.view}@${r.width_vp}`, 16) + pad(r.first, 24) + pad(r.phCount, 5) + pad(r.padding, 18) + pad(r.width, 7) +
      pad(r.navWrapped.length ? r.navWrapped.length + ' repl.' : (r.headerOverflow ? 'débord.' : 'ok'), 9) + pad(r.alertH + 'px', 9) + r.emojiCount));
    if(SHOTS){ fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rows, null, 1)); console.log(`\nCaptures : ${OUT}`); }
    if(CHECKS.length) console.log(fails.length ? `\n${fails.length} échec(s) :\n` + fails.map(f => ' - ' + f).join('\n') : `\nContrôles OK : ${CHECKS.join(', ')}`);
    return fails.length ? 1 : 0;
  } finally { stop(); }
}
main().then(code => process.exit(code), e => { console.error(e.message || e); process.exit(2); });
