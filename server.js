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
    console.log(`[Historique] Sauvegardé : ${evenement}`);
  } catch (erreur) {
    console.error("[Erreur Google Sheets]", erreur.message);
  }
}

// --- 1. L'INTERFACE WEB (TABLEAU DE BORD) ---
app.get('/', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Centre de Contrôle Domotique</title>
    <style>
      body { font-family: Arial, sans-serif; text-align: center; background-color: #f4f4f9; padding: 20px;}
      .carte-section { background-color: #e9ecef; border-radius: 10px; padding: 15px; margin-bottom: 25px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);}
      .status-bar { padding: 10px; margin-bottom: 15px; border-radius: 5px; font-weight: bold; font-size: 18px; }
      .online { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb;}
      .offline { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb;}
      .container { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
      .card { background: white; padding: 15px; border-radius: 10px; width: 100px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
      .indicator { width: 12px; height: 12px; border-radius: 50%; display: inline-block; margin-right: 5px; }
      .on { background-color: #4CAF50; }
      .off { background-color: #bbb; }
      button { width: 100%; padding: 10px; margin-top: 10px; cursor: pointer; border-radius: 5px; border: none; font-weight: bold; color: white;}
      .btn-on { background-color: #4CAF50; }
      .btn-off { background-color: #f44336; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      #ecran-app { display: none; }
      input[type=password] { padding: 10px; font-size: 16px; width: 100px; text-align: center; }
      .btn-login { background-color: #2196F3; color: white; width: auto; padding: 10px 20px; }
    </style>
  </head>
  <body>
    <div id="ecran-login">
      <h2>Verrouillage Système</h2>
      <input type="password" id="pin-input" placeholder="PIN">
      <button class="btn-login" onclick="validerPin()">Accéder</button>
    </div>
    <div id="ecran-app">
      <h1>Flotte Domotique</h1>
      <div id="cartes-container"><p>En attente de connexion au serveur...</p></div>
    </div>
    <script>
      let codePin = "";
      const ws = new WebSocket('wss://' + window.location.host);
      
      function validerPin() {
        codePin = document.getElementById('pin-input').value;
        document.getElementById('ecran-login').style.display = 'none';
        document.getElementById('ecran-app').style.display = 'block';
        ws.send("GET_DASHBOARD"); 
      }

      ws.onmessage = (event) => {
        const msg = event.data;
        if (msg.startsWith("{")) {
            const data = JSON.parse(msg);
            if (data.type === "UPDATE") majAffichageCartes(data.liste);
        }
      };

      function majAffichageCartes(listeCartes) {
        let html = '';
        if (listeCartes.length === 0) html = "<p>Aucune carte n'est actuellement détectée.</p>";

        listeCartes.forEach(carte => {
          const statusClass = carte.enLigne ? "online" : "offline";
          const statusText = carte.enLigne ? "Connectée 🟢" : "Déconnectée 🔴";
          
          let relaisHtml = '';
          for(let i=1; i<=6; i++) {
            const estOn = (carte.etat & (1 << (i-1)));
            
            // NOUVEAUTÉ : On bloque le bouton si la carte est hors ligne
            const etatBouton = carte.enLigne ? '' : 'disabled';
            
            relaisHtml += \`
            <div class="card">
              <span class="indicator \${estOn ? 'on' : 'off'}"></span> R\${i}<br>
              <button class="\${estOn ? 'btn-off' : 'btn-on'}" \${etatBouton} onclick="envoyerOrdre('\${carte.nom}', '\${i}', '\${estOn ? 'OFF' : 'ON'}')">
                \${estOn ? 'OFF' : 'ON'}
              </button>
            </div>\`;
          }
          html += \`<div class="carte-section"><div class="status-bar \${statusClass}">Appareil : \${carte.nom.replace(/_/g, ' ')} - \${statusText}</div><div class="container">\${relaisHtml}</div></div>\`;
        });
        document.getElementById('cartes-container').innerHTML = html;
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
  
  // Gère la déconnexion "propre" (quand le Wi-Fi coupe proprement)
  ws.on('close', () => {
    for (const [nom, infos] of registreCartes.entries()) {
      if (infos.ws === ws) {
        infos.ws = null;
        console.log(\`[Déconnexion] \${nom} a quitté le réseau.\`);
        diffuserMiseAJourWeb();
        break;
      }
    }
  });

  ws.on('message', (message) => {
    const data = message.toString();

    // A. Une carte se connecte
    if (data.startsWith("INIT:")) {
      const parts = data.split(":");
      if (parts.length >= 4) {
        const nom = parts[1];
        // NOUVEAUTÉ : On enregistre l'heure exacte (derniereVue) de la connexion
        registreCartes.set(nom, { ws: ws, lat: parts[2], lon: parts[3], etat: 0, derniereVue: Date.now() });
        console.log(\`[Nouvelle Carte] \${nom} connectée.\`);
        diffuserMiseAJourWeb();
        verifierPluieGlobal();
      }
    } 
    // B. Une carte met à jour son état
    else if (data.startsWith("STATE:")) {
      const parts = data.split(":");
      if (parts.length >= 3) {
        const nom = parts[1];
        const etat = parseInt(parts[2]);
        if (registreCartes.has(nom)) {
          registreCartes.get(nom).etat = etat;
          registreCartes.get(nom).ws = ws; 
          // NOUVEAUTÉ : On rafraîchit le compteur à chaque battement de coeur
          registreCartes.get(nom).derniereVue = Date.now(); 
          diffuserMiseAJourWeb();
        }
      }
    }
    // C. Rafraîchissement du navigateur
    else if (data === "GET_DASHBOARD") {
      diffuserMiseAJourWeb();
    }
    // D. Ordre manuel depuis l'interface web
    else if (data.startsWith(CODE_SECRET + "-")) {
      const parts = data.split("-");
      if (parts.length >= 3) {
        const cible = parts[1];
        const ordre = parts[2]; 
        
        if (registreCartes.has(cible)) {
          const carteWs = registreCartes.get(cible).ws;
          // NOUVEAUTÉ : On bloque l'ordre et Google Sheets si la carte est morte
          if (carteWs && carteWs.readyState === WebSocket.OPEN) {
            carteWs.send(ordre);
            ecrireHistorique(\`\${cible} : Ordre MANUEL envoyé -> \${ordre}\`);
          } else {
            console.log(\`[Erreur] Ordre annulé, \${cible} est hors ligne.\`);
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
    resume.push({ nom: nom, etat: infos.etat, enLigne: enLigne });
  }
  const json = JSON.stringify({ type: "UPDATE", liste: resume });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(json); 
  });
}

// --- 3. LE CHIEN DE GARDE (WATCHDOG) ANTI-DÉCONNEXION FANTÔME ---
setInterval(() => {
  const maintenant = Date.now();
  let changementDetecte = false;

  for (const [nom, infos] of registreCartes.entries()) {
    // Si la carte est censée être en ligne, mais qu'elle n'a rien envoyé depuis plus de 25 secondes
    if (infos.ws && (maintenant - infos.derniereVue > 25000)) {
      console.log(\`[Alerte] \${nom} ne répond plus (Coupure de courant ou de Wi-Fi détectée).\`);
      infos.ws.terminate(); // On coupe de force la connexion fantôme
      infos.ws = null;      // On la déclare officiellement morte
      changementDetecte = true;
    }
  }

  // S'il y a eu un mort, on avertit immédiatement les téléphones connectés
  if (changementDetecte) {
    diffuserMiseAJourWeb();
  }
}, 10000); // Le serveur fait sa ronde toutes les 10 secondes


// --- 4. LE CERVEAU MÉTÉO AUTOMATISÉ ---
async function verifierPluieGlobal() {
  for (const [nom, infos] of registreCartes.entries()) {
    if (!infos.ws || infos.ws.readyState !== WebSocket.OPEN) continue; 

    try {
      const url = \`https://api.open-meteo.com/v1/forecast?latitude=\${infos.lat}&longitude=\${infos.lon}&hourly=precipitation&timezone=Europe%2FParis&forecast_days=3\`;
      const reponse = await fetch(url);
      
      if (!reponse.ok) throw new Error(\`Open-Météo a refusé la connexion (Code erreur HTTP : \${reponse.status})\`);

      const data = await reponse.json();

      const heureActuelle = new Date().getTime();
      let indexDepart = data.hourly.time.findIndex(t => new Date(t).getTime() >= heureActuelle);
      if (indexDepart === -1) indexDepart = 0;

      let pluieTotale = 0;
      for (let i = indexDepart; i < indexDepart + 48 && i < data.hourly.precipitation.length; i++) {
        pluieTotale += data.hourly.precipitation[i];
      }

      console.log(\`[Météo] \${nom} : \${pluieTotale.toFixed(1)} mm prévus sur 48h.\`);

      if (pluieTotale > 10) {
        const relais1Allume = (infos.etat & 1) !== 0;
        if (!relais1Allume) {
          infos.ws.send("R1_ON");
          ecrireHistorique(\`\${nom} : Alerte Pluie (\${pluieTotale.toFixed(1)}mm) -> Allumage automatique\`);
          infos.etat = infos.etat | 1; 
        }
      } else {
        const relais1Allume = (infos.etat & 1) !== 0;
        if (relais1Allume) {
          infos.ws.send("R1_OFF");
          infos.etat = infos.etat & ~1;
          ecrireHistorique(\`\${nom} : Fin de l'alerte pluie -> Extinction automatique\`);
        }
      }

    } catch (erreur) {
      console.error(\`[Erreur Météo] Problème avec \${nom} :\`, erreur.message);
    }
  }
}

setInterval(verifierPluieGlobal, 3600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Serveur centralisé en ligne sur le port ' + PORT);
});
// --- FIN DU FICHIER ---
