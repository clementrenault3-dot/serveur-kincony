const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CODE_SECRET = "1234";
const registreCartes = new Map();

// --- CONNEXION SÉCURISÉE À GOOGLE SHEETS ---
let authGoogle;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    authGoogle = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    console.log("[Système] Authentification Google Sheets prête.");
    chargerHistoriqueLongTableau(); // Nouvelle fonction de chargement au boot
  }
} catch (erreur) {
  console.log("[Erreur] Impossible de lire la clé Google :", erreur.message);
}

async function ecrireHistorique(evenement) {
  if (!authGoogle || !process.env.SPREADSHEET_ID) return;
  try {
    const sheets = google.sheets({ version: 'v4', auth: authGoogle });
    const dateFR = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Feuille 1!A:B',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[dateFR, evenement]] }
    });
    console.log(`[Historique d'événements] Sauvegardé : ${evenement}`);
  } catch (erreur) {
    console.error("[Erreur Google Sheets]", erreur.message);
  }
}

// Fonction de chargement de l'onglet Feuille_Volume au démarrage
async function chargerHistoriqueLongTableau() {
  if (!authGoogle || !process.env.SPREADSHEET_ID) return;
  try {
    const sheets = google.sheets({ version: 'v4', auth: authGoogle });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Feuille_Volume!A:C',
    });
    const rows = response.data.values;
    if (rows && rows.length > 1) { // Ignore la ligne d'en-tête éventuelle
      let count = 0;
      rows.forEach((row, index) => {
        if(index > 0 && row.length >= 3) {
           const time = new Date(row[0]).getTime();
           if(isNaN(time)) return; 
           const nom = row[1];
           const vol = parseFloat(row[2].replace(',', '.')); // Corrige format FR
           
           if (!registreCartes.has(nom)) {
             registreCartes.set(nom, { etat: 0, derniereVue: 0, historiqueVolume: [], historiqueLong: [] });
           }
           const carte = registreCartes.get(nom);
           if (!carte.historiqueLong) carte.historiqueLong = [];
           carte.historiqueLong.push({ time, volume: vol });
           count++;
        }
      });
      console.log(`[Base de données Volume] Données ressuscitées au démarrage : ${count} points.`);
    }
  } catch (erreur) {
    console.log("[Base de données Volume] Onglet 'Feuille_Volume' vide, inaccessible ou inexistant.");
  }
}

// L'Algorithme d'Échantillonnage en base de données : Exécute toutes les 5 minutes
setInterval(async () => {
  if (!authGoogle || !process.env.SPREADSHEET_ID) return;
  const sheets = google.sheets({ version: 'v4', auth: authGoogle });
  const timeNow = Date.now();
  const dateIso = new Date().toISOString(); 
  const nouvellesLignes = [];

  for (const [nom, infos] of registreCartes.entries()) {
    if (infos.historiqueVolume && infos.historiqueVolume.length > 0) {
      const dataRecentes = infos.historiqueVolume.filter(p => (timeNow - p.time) < 300000); // points des 5 dernières ms
      if (dataRecentes.length > 0) {
        let somme = 0;
        dataRecentes.forEach(p => somme += p.volume);
        const moyenne = parseFloat((somme / dataRecentes.length).toFixed(1));
        
        if (!infos.historiqueLong) infos.historiqueLong = [];
        infos.historiqueLong.push({ time: timeNow, volume: moyenne });
        
        // Sécurité mémoire (on ne garde en RAM que ~2 mois d'historique)
        if (infos.historiqueLong.length > 18000) infos.historiqueLong.shift();
        
        nouvellesLignes.push([dateIso, nom, moyenne.toString().replace('.', ',')]); // Conversion vers FR facile
      }
    }
  }

  if (nouvellesLignes.length > 0) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'Feuille_Volume!A:C',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: nouvellesLignes }
      });
      console.log(`[Écriture Base Volume] ${nouvellesLignes.length} points de moyennes compressées sauvegardés.`);
    } catch(err) {
       console.error("[Écriture Base Volume] Échec de la sauvegarde Cloud:", err.message);
    }
  }
}, 300000); // 5 minutes

// --- 1. L'INTERFACE WEB (TABLEAU DE BORD) ---
app.get('/', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Centre de Contrôle Domotique</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
      :root {
        --bg-color: #0f172a;
        --card-bg: rgba(30, 41, 59, 0.7);
        --card-border: rgba(255, 255, 255, 0.1);
        --text-main: #f8fafc;
        --text-muted: #94a3b8;
        --accent: #3b82f6;
        --accent-hover: #2563eb;
        --success: #10b981;
        --danger: #ef4444;
        --blur: blur(12px);
      }
      body { 
        font-family: 'Inter', sans-serif; 
        background-color: var(--bg-color); 
        color: var(--text-main); 
        margin: 0; 
        padding: 20px;
        min-height: 100vh;
        background-image: radial-gradient(circle at top right, #1e1b4b, transparent 40%), radial-gradient(circle at bottom left, #0f172a, transparent 40%);
      }
      h1, h2 { font-weight: 700; color: #fff; text-align: center; margin-bottom: 30px; letter-spacing: -0.5px; }
      
      #ecran-login {
        max-width: 350px; margin: 100px auto; padding: 40px;
        background: var(--card-bg); backdrop-filter: var(--blur); border: 1px solid var(--card-border);
        border-radius: 24px; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
      }
      input[type=password] { 
        width: 100%; padding: 15px; margin-bottom: 20px; box-sizing: border-box;
        background: rgba(0,0,0,0.2); border: 1px solid var(--card-border); border-radius: 12px;
        color: white; font-size: 18px; text-align: center; outline: none; transition: border 0.3s;
      }
      input[type=password]:focus { border-color: var(--accent); }
      .btn-login { 
        background: var(--accent); color: white; border: none; padding: 15px 30px;
        border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer;
        transition: background 0.3s, transform 0.1s; width: 100%;
      }
      .btn-login:hover { background: var(--accent-hover); }
      .btn-login:active { transform: scale(0.98); }

      #ecran-app { display: none; max-width: 1000px; margin: 0 auto; }
      
      .carte-section { 
        background: var(--card-bg); backdrop-filter: var(--blur); border: 1px solid var(--card-border);
        border-radius: 20px; padding: 25px; margin-bottom: 30px; 
        box-shadow: 0 10px 30px -5px rgba(0,0,0,0.3);
      }
      
      .status-bar { 
        display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px;
        padding-bottom: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--card-border);
      }
      .status-title { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 600; }
      .status-badge { 
        padding: 6px 12px; border-radius: 20px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px;
      }
      .online .status-badge { background: rgba(16, 185, 129, 0.1); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); }
      .offline .status-badge { background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); }
      
      .sensor-data { 
        display: flex; gap: 15px; font-size: 15px; background: rgba(0,0,0,0.3); 
        padding: 8px 16px; border-radius: 20px; color: var(--text-main); font-weight: 500;
        border: 1px solid var(--card-border); box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
      }
      
      .container { 
        display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 15px; 
      }
      .dashboard-layout { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
      .tank-column { width: 80px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
      .tank-container {
        width: 60px; height: 180px; background: rgba(255,255,255,0.05); border: 2px solid var(--card-border);
        border-radius: 30px; position: relative; overflow: hidden; box-shadow: inset 0 0 10px rgba(0,0,0,0.5); margin-bottom: 15px;
      }
      .tank-fill {
        position: absolute; bottom: 0; width: 100%; background: linear-gradient(to top, #0ea5e9, #38bdf8);
        transition: height 1s ease-out; box-shadow: 0 0 15px #38bdf8;
      }
      .chart-column { flex-grow: 1; min-width: 300px; background: rgba(0,0,0,0.2); border-radius: 15px; padding: 15px; border: 1px solid var(--card-border); min-height: 200px; display: flex; flex-direction: column; }
      .chart-filters { display: flex; gap: 10px; margin-bottom: 10px; justify-content: flex-end; }
      .filter-btn { background: rgba(255,255,255,0.05); color: var(--text-muted); border: 1px solid var(--card-border); border-radius: 6px; padding: 6px 12px; font-size: 13px; font-weight: 500; cursor: pointer; transition: 0.2s; }
      .filter-btn:hover, .filter-btn.active { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border-color: rgba(56, 189, 248, 0.5); }
      .chart-wrapper { flex-grow: 1; position: relative; }
      .card { 
        background: rgba(255,255,255,0.03); border: 1px solid var(--card-border);
        padding: 20px 15px; border-radius: 16px; text-align: center;
        transition: transform 0.2s, background 0.3s;
      }
      .card:hover { background: rgba(255,255,255,0.06); transform: translateY(-2px); }
      
      .relais-title { 
        font-size: 16px; font-weight: 600; color: var(--text-muted); margin-bottom: 15px;
        display: flex; justify-content: center; align-items: center; gap: 8px;
      }
      .indicator { width: 10px; height: 10px; border-radius: 50%; display: inline-block; box-shadow: 0 0 10px currentColor; }
      .on .indicator { background-color: var(--success); color: var(--success); }
      .off .indicator { background-color: var(--text-muted); color: var(--text-muted); box-shadow: none; }
      
      button.action-btn { 
        width: 100%; padding: 12px; cursor: pointer; border-radius: 10px; border: none; 
        font-weight: 600; font-size: 14px; transition: all 0.2s;
      }
      .btn-on { background-color: var(--success); color: #fff; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3); }
      .btn-on:hover { background-color: #059669; }
      .btn-off { background-color: rgba(255,255,255,0.1); color: var(--text-main); }
      .btn-off:hover { background-color: rgba(255,255,255,0.2); }
      button:disabled { opacity: 0.4; cursor: not-allowed; filter: grayscale(1); box-shadow: none; }
    </style>
  </head>
  <body>
    <div id="ecran-login">
      <h2>🔒 Verrouillage</h2>
      <input type="password" id="pin-input" placeholder="Code PIN">
      <button class="btn-login" onclick="validerPin()">Déverrouiller</button>
    </div>
    <div id="ecran-app">
      <h1>Flotte Domotique ⚡</h1>
      <div id="cartes-container">
        <div style="text-align: center; color: var(--text-muted); height: 100px; display: flex; align-items: center; justify-content: center;">En attente de connexion...</div>
      </div>
    </div>
    <script>
      let codePin = localStorage.getItem("savedPin") || "";
      const ws = new WebSocket('wss://' + window.location.host);
      
      ws.onopen = () => {
        if (codePin) {
          document.getElementById('ecran-login').style.display = 'none';
          document.getElementById('ecran-app').style.display = 'block';
          ws.send("GET_DASHBOARD"); 
        }
      };

      function validerPin() {
        codePin = document.getElementById('pin-input').value;
        localStorage.setItem("savedPin", codePin);
        document.getElementById('ecran-login').style.display = 'none';
        document.getElementById('ecran-app').style.display = 'block';
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("GET_DASHBOARD"); 
        }
      }

      ws.onmessage = (event) => {
        const msg = event.data;
        if (msg.startsWith("{")) {
            const data = JSON.parse(msg);
            if (data.type === "UPDATE") majAffichageCartes(data.liste);
            else if (data.type === "HISTORY_DATA") dessinerGraphique(data.nom, data.points, data.periode);
        }
      };

      const chartsMemory = {};

      function majAffichageCartes(listeCartes) {
        if (listeCartes.length === 0) {
            document.getElementById('cartes-container').innerHTML = "<div style='text-align: center; color: var(--text-muted);'>Aucune carte n'est actuellement détectée.</div>";
            return;
        }

        let container = document.getElementById('cartes-container');
        if (container.innerHTML.includes("Aucune carte") || container.innerHTML.includes("En attente")) {
            container.innerHTML = "";
        }

        listeCartes.forEach(carte => {
          const safeNom = carte.nom.replace(/_/g, '-');
          const carteId = 'carte-ui-' + safeNom;
          let el = document.getElementById(carteId);
          
          // CRÉATION INITIALE SI ELLE N'EXISTE PAS ENCORE DANS LE HTML
          if (!el) {
             const statusClass = carte.enLigne ? "online" : "offline";
             const statusIcon = carte.enLigne ? "🟢" : "🔴";
             const statusText = carte.enLigne ? "En ligne" : "Hors ligne";
             const nomPropre = carte.nom.replace(/_/g, ' ');
             
             let relaisHtml = '';
             for(let i=1; i<=6; i++) {
               relaisHtml += '<div class="card off" id="r-card-' + safeNom + '-' + i + '">' +
                 '<div class="relais-title"><span class="indicator"></span> R' + i + '</div>' +
                 '<button id="r-btn-' + safeNom + '-' + i + '" class="action-btn btn-on" onclick="envoyerOrdre(\\'' + carte.nom + '\\', \\'' + i + '\\', \\'ON\\')">Activer</button>' +
               '</div>';
             }
             
             let newCarteTemplate = document.createElement("div");
             newCarteTemplate.id = carteId;
             newCarteTemplate.className = 'carte-section ' + statusClass;
             newCarteTemplate.innerHTML = 
               '<div class="status-bar">' +
                 '<div class="status-title">' + nomPropre + ' <span class="status-badge" id="status-' + safeNom + '">' + statusIcon + ' ' + statusText + '</span></div>' + 
                 '<div class="sensor-data"><span id="vol-' + safeNom + '">💧 0 L</span><span id="pct-' + safeNom + '">📊 0.0%</span></div>' +
               '</div>' +
               '<div class="dashboard-layout">' +
                 '<div class="tank-column">' +
                    '<div class="tank-container"><div class="tank-fill" id="fill-' + safeNom + '" style="height: 0%;"></div></div>' +
                    '<div style="font-weight:bold;color:#38bdf8;" id="filltext-' + safeNom + '">0.0%</div>' +
                 '</div>' +
                 '<div class="chart-column">' +
                    '<div class="chart-filters">' +
                        '<button class="filter-btn active" onclick="demanderHistorique(\\'' + carte.nom + '\\', \\'1d\\', this)">1 Jour</button>' +
                        '<button class="filter-btn" onclick="demanderHistorique(\\'' + carte.nom + '\\', \\'1w\\', this)">1 Sem.</button>' +
                        '<button class="filter-btn" onclick="demanderHistorique(\\'' + carte.nom + '\\', \\'1m\\', this)">1 Mois</button>' +
                    '</div>' +
                    '<div class="chart-wrapper"><canvas id="chart-' + carte.nom + '"></canvas></div>' +
                 '</div>' +
               '</div>' +
               '<div class="container">' + relaisHtml + '</div>';
               
             container.appendChild(newCarteTemplate);
             // On demande implicitement le chargement de l'historique sur 1 Jour via websocket au premier affichage
             demanderHistorique(carte.nom, '1d', null);
          } 
          
          // MISE A JOUR CIBLEE DANS LE HTML EXISTANT SANS RIEN DÉTRUIRE (ADIEU LES FLASHS)
          el = document.getElementById(carteId);
          if (el) {
             const statLabel = carte.enLigne ? "🟢 En ligne" : "🔴 Hors ligne";
             document.getElementById('status-' + safeNom).innerHTML = statLabel;
             if (carte.enLigne) el.className = 'carte-section online';
             else el.className = 'carte-section offline';

             if (carte.volume !== null && carte.pourcentage !== null) {
                 document.getElementById('vol-' + safeNom).innerText = '💧 ' + carte.volume + ' L';
                 document.getElementById('pct-' + safeNom).innerText = '📊 ' + carte.pourcentage + '%';
                 document.getElementById('fill-' + safeNom).style.height = carte.pourcentage + '%';
                 document.getElementById('filltext-' + safeNom).innerText = carte.pourcentage + '%';
                 
                 // Ajout astucieux de la mesure en direct dans le chart existant
                 majDernierPointGraphique(carte.nom, carte.volume);
             }
             
             // Update des switch relais :
             for(let i=1; i<=6; i++) {
                const estOn = (carte.etat & (1 << (i-1)));
                const rCard = document.getElementById('r-card-' + safeNom + '-' + i);
                const rBtn = document.getElementById('r-btn-' + safeNom + '-' + i);
                if (!carte.enLigne) rBtn.setAttribute('disabled', 'true');
                else rBtn.removeAttribute('disabled');
                
                if (estOn) {
                    rCard.className = 'card on';
                    rBtn.className = 'action-btn btn-off';
                    rBtn.innerText = 'Désactiver';
                    rBtn.setAttribute('onclick', 'envoyerOrdre(\\'' + carte.nom + '\\', \\'' + i + '\\', \\'OFF\\')');
                } else {
                    rCard.className = 'card off';
                    rBtn.className = 'action-btn btn-on';
                    rBtn.innerText = 'Activer';
                    rBtn.setAttribute('onclick', 'envoyerOrdre(\\'' + carte.nom + '\\', \\'' + i + '\\', \\'ON\\')');
                }
             }
          }
        });
      }

      function demanderHistorique(nom, periode, boutonDOM) {
          if (boutonDOM) {
             const parent = boutonDOM.parentNode;
             const boutons = parent.querySelectorAll('.filter-btn');
             boutons.forEach(b => b.classList.remove('active'));
             boutonDOM.classList.add('active');
          }
          if (ws.readyState === WebSocket.OPEN) {
              ws.send("GET_CHART_HISTORY-" + nom + "-" + periode);
          }
      }

      function majDernierPointGraphique(nom, volume) {
          if (chartsMemory[nom]) {
              const timeLbl = new Date().toLocaleTimeString('fr-FR').substring(0, 5); // Ex: 10:45
              // On jette un oeil à la date du dernier point, pour ne vérifier et rafraichir qu'occasionnellement
              const len = chartsMemory[nom].data.labels.length;
              if (len > 0) {
                  const lastLbl = chartsMemory[nom].data.labels[len - 1];
                  if (lastLbl !== timeLbl) {
                      chartsMemory[nom].data.labels.push(timeLbl);
                      chartsMemory[nom].data.datasets[0].data.push(volume);
                      chartsMemory[nom].update('none'); // Update du direct sans animation !
                  }
              }
          }
      }

      function dessinerGraphique(nom, historiqueRecu, periodeChoisie) {
         const ctx = document.getElementById('chart-' + nom);
         if(!ctx) return;
         
         // Historique stocké dans la BDD
         const dataPoints = historiqueRecu.map(h => h.volume);
         const labels = historiqueRecu.map(h => {
             const d = new Date(h.time);
             if (periodeChoisie === '1d' || periodeChoisie === '1h') return d.toLocaleTimeString('fr-FR').substring(0, 5);
             return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).replace(",", " -");
         });

         if(chartsMemory[nom]) chartsMemory[nom].destroy();
         
         const timeLineDesc = (periodeChoisie==='1d') ? "Dernières 24h" : (periodeChoisie==='1w') ? "Derniers 7 Jours" : "Dernier Mois";

         chartsMemory[nom] = new Chart(ctx, {
             type: 'line',
             data: {
                 labels: labels,
                 datasets: [{
                     label: 'Volume (Litres) - ' + timeLineDesc,
                     data: dataPoints,
                     borderColor: '#38bdf8',
                     backgroundColor: 'rgba(56, 189, 248, 0.2)',
                     fill: true,
                     tension: 0.4,
                     pointRadius: (periodeChoisie === '1d') ? 0 : 2 // points trop tassés sur 24h
                 }]
             },
             options: {
                 responsive: true,
                 maintainAspectRatio: false,
                 animation: { duration: 600 }, // Une jolie petite animation puisqu'on recharge tout
                 plugins: {
                     legend: { labels: { color: '#f8fafc', font: { size: 14 } } }
                 },
                 scales: {
                     x: { ticks: { color: '#94a3b8', maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                     y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.1)' }, min: 0 }
                 }
             }
         });
      }

      function envoyerOrdre(nomCarte, numeroRelais, action) { 
        if(ws.readyState === WebSocket.OPEN) {
            ws.send(codePin + "-" + nomCarte + "-R" + numeroRelais + "_" + action); 
        } else {
            alert("Déconnecté du serveur !");
        }
      }
    </script>
  </body>
  </html>
  `;
  res.send(html);
});

// --- 2. GESTION DES COMMUNICATIONS WEBSOCKETS ---
wss.on('connection', (ws) => {

  // Gère la déconnexion propre du Wi-Fi
  ws.on('close', () => {
    for (const [nom, infos] of registreCartes.entries()) {
      if (infos.ws === ws) {
        infos.ws = null;
        console.log(`[Déconnexion] ${nom} a quitté le réseau.`);
        diffuserMiseAJourWeb();
        break;
      }
    }
  });

  ws.on('message', (message) => {
    const data = message.toString();

    if (data.startsWith("INIT:")) {
      const parts = data.split(":");
      if (parts.length >= 4) {
        const nom = parts[1];
        registreCartes.set(nom, { ws: ws, lat: parts[2], lon: parts[3], etat: 0, derniereVue: Date.now(), historiqueVolume: [] });
        console.log(`[Nouvelle Carte] ${nom} connectée.`);
        diffuserMiseAJourWeb();
        verifierPluieGlobal();
      }
    }
    else if (data.startsWith("STATE:")) {
      const parts = data.split(":");
      if (parts.length >= 3) {
        const nom = parts[1];
        const etat = parseInt(parts[2]);
        const volume = parts.length >= 5 ? parseFloat(parts[3]) : null;
        const pourcentage = parts.length >= 5 ? parseFloat(parts[4]) : null;
        if (registreCartes.has(nom)) {
          registreCartes.get(nom).etat = etat;
          if (volume !== null && !isNaN(volume)) registreCartes.get(nom).volume = volume;
          if (pourcentage !== null && !isNaN(pourcentage)) registreCartes.get(nom).pourcentage = pourcentage;
          registreCartes.get(nom).ws = ws;
          registreCartes.get(nom).derniereVue = Date.now();
          
          if (!registreCartes.get(nom).historiqueVolume) registreCartes.get(nom).historiqueVolume = [];
          if (volume !== null && !isNaN(volume)) {
            registreCartes.get(nom).historiqueVolume.push({ time: Date.now(), volume: volume });
            if (registreCartes.get(nom).historiqueVolume.length > 100) registreCartes.get(nom).historiqueVolume.shift();
          }
          diffuserMiseAJourWeb();
        }
      }
    }
    else if (data === "GET_DASHBOARD") {
      diffuserMiseAJourWeb();
    }
    else if (data.startsWith("GET_CHART_HISTORY-")) { 
      const parts = data.split("-");
      if (parts.length >= 3) {
        const nomCarte = parts[1];
        const periode = parts[2]; // '1d', '1w', '1m'
        
        if (registreCartes.has(nomCarte)) {
            const infos = registreCartes.get(nomCarte);
            const refTime = Date.now();
            let pointsCibles = [];
            let intervalleMillis = 0;
            let timeLimite = 0;
            
            if (periode === '1d') {
                timeLimite = refTime - (24 * 3600 * 1000); 
                intervalleMillis = 0; // Aucun tri supplémentaire (la base est déjà échantillonnée par 5 minutes)
            } else if (periode === '1w') {
                timeLimite = refTime - (7 * 24 * 3600 * 1000);
                intervalleMillis = 1800000; // 30 minutes entre chaque point (pour ne pas saturer le graph)
            } else if (periode === '1m') {
                timeLimite = refTime - (31 * 24 * 3600 * 1000);
                intervalleMillis = 14400000; // 4 heures
            }
            
            if (infos.historiqueLong && infos.historiqueLong.length) {
                const filteredList = infos.historiqueLong.filter(p => p.time >= timeLimite);
                let dernierTempsAjoute = 0;
                filteredList.forEach(p => {
                    if (p.time - dernierTempsAjoute >= intervalleMillis) {
                        pointsCibles.push(p);
                        dernierTempsAjoute = p.time;
                    }
                });
            }
            
            ws.send(JSON.stringify({ type: "HISTORY_DATA", nom: nomCarte, periode: periode, points: pointsCibles }));
        }
      }
    }
    else if (data.startsWith(CODE_SECRET + "-")) {
      const parts = data.split("-");
      if (parts.length >= 3) {
        const cible = parts[1];
        const ordre = parts[2];

        if (registreCartes.has(cible)) {
          const carteWs = registreCartes.get(cible).ws;
          if (carteWs && carteWs.readyState === WebSocket.OPEN) {
            carteWs.send(ordre);
            ecrireHistorique(`${cible} : Ordre MANUEL envoyé -> ${ordre}`);
          } else {
            console.log(`[Erreur] Ordre annulé, ${cible} est hors ligne.`);
          }
        }
      }
    }
  });
});

function diffuserMiseAJourWeb() {
  const resume = [];
  for (const [nom, infos] of registreCartes.entries()) {
    const enLigne = (infos.ws && infos.ws.readyState === WebSocket.OPEN);
    resume.push({
      nom: nom,
      etat: infos.etat,
      volume: infos.volume,
      pourcentage: infos.pourcentage,
      // On n'envoie dorénavant plus l'historique complet pour ne pas polluer l'ESP32 et le réseau.
      enLigne: enLigne
    });
  }
  const json = JSON.stringify({ type: "UPDATE", liste: resume });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

// --- 3. LE CHIEN DE GARDE (WATCHDOG) ---
setInterval(() => {
  const maintenant = Date.now();
  let changementDetecte = false;

  for (const [nom, infos] of registreCartes.entries()) {
    if (infos.ws && (maintenant - infos.derniereVue > 25000)) {
      console.log(`[Alerte] ${nom} ne répond plus (Coupure de courant ou de Wi-Fi).`);
      infos.ws.terminate();
      infos.ws = null;
      changementDetecte = true;
    }
  }

  if (changementDetecte) {
    diffuserMiseAJourWeb();
  }
}, 10000);

// --- 4. LE CERVEAU MÉTÉO AUTOMATISÉ ---
let tempsDerniereMeteo = 0; // La mémoire de la dernière vérification

async function verifierPluieGlobal() {
  const maintenant = Date.now();

  // LE BOUCLIER : 1 heure = 3 600 000 millisecondes
  if (tempsDerniereMeteo !== 0 && (maintenant - tempsDerniereMeteo < 3600000)) {
    console.log("[Météo] Requête ignorée : La dernière vérification date de moins d'une heure.");
    return; // On annule l'exécution de la suite
  }

  // Si le bouclier est passé, on mémorise l'heure actuelle pour bloquer les requêtes suivantes
  tempsDerniereMeteo = maintenant;

  for (const [nom, infos] of registreCartes.entries()) {
    if (!infos.ws || infos.ws.readyState !== WebSocket.OPEN) continue;

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${infos.lat}&longitude=${infos.lon}&hourly=precipitation&timezone=Europe%2FParis&forecast_days=3`;
      const reponse = await fetch(url);

      if (!reponse.ok) throw new Error(`Open-Météo a refusé (Code : ${reponse.status})`);

      const data = await reponse.json();
      const heureActuelle = new Date().getTime();
      let indexDepart = data.hourly.time.findIndex(t => new Date(t).getTime() >= heureActuelle);
      if (indexDepart === -1) indexDepart = 0;

      let pluieTotale = 0;
      for (let i = indexDepart; i < indexDepart + 48 && i < data.hourly.precipitation.length; i++) {
        pluieTotale += data.hourly.precipitation[i];
      }

      console.log(`[Météo] ${nom} : ${pluieTotale.toFixed(1)} mm prévus.`);

      if (pluieTotale > 10) {
        const relais1Allume = (infos.etat & 1) !== 0;
        if (!relais1Allume) {
          infos.ws.send("R1_ON");
          ecrireHistorique(`${nom} : Alerte Pluie (${pluieTotale.toFixed(1)}mm) -> Allumage`);
          infos.etat = infos.etat | 1;
        }
      } else {
        const relais1Allume = (infos.etat & 1) !== 0;
        if (relais1Allume) {
          infos.ws.send("R1_OFF");
          infos.etat = infos.etat & ~1;
          ecrireHistorique(`${nom} : Fin de l'alerte pluie -> Extinction`);
        }
      }

    } catch (erreur) {
      console.error(`[Erreur Météo] Problème avec ${nom} :`, erreur.message);
    }
  }
}

setInterval(verifierPluieGlobal, 3600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Serveur centralisé en ligne sur le port ' + PORT);
});
// --- FIN DU FICHIER ---