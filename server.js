const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CODE_SECRET = "1234";

// --- NOTRE REGISTRE DE CARTES ---
// Il stockera les informations sous cette forme : 
// "Maison_Fletre" => { ws: objet_connexion, lat: "50.75", lon: "2.61", etat: 0 }
const registreCartes = new Map();

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
      <div id="cartes-container">
        <p>En attente de connexion au serveur...</p>
      </div>
    </div>

    <script>
      let codePin = "";
      const ws = new WebSocket('wss://' + window.location.host);
      
      function validerPin() {
        codePin = document.getElementById('pin-input').value;
        document.getElementById('ecran-login').style.display = 'none';
        document.getElementById('ecran-app').style.display = 'block';
        // Demande au serveur la liste des cartes dès qu'on se connecte
        ws.send("GET_DASHBOARD"); 
      }

      // Quand le serveur nous envoie des informations
      ws.onmessage = (event) => {
        const msg = event.data;
        // Si le message ressemble à du JSON (c'est notre mise à jour de tableau de bord)
        if (msg.startsWith("{")) {
            const data = JSON.parse(msg);
            if (data.type === "UPDATE") {
                majAffichageCartes(data.liste);
            }
        }
      };

      // Construit dynamiquement l'interface en fonction des cartes branchées
      function majAffichageCartes(listeCartes) {
        let html = '';
        if (listeCartes.length === 0) {
            html = "<p>Aucune carte n'est actuellement détectée par le serveur.</p>";
        }

        listeCartes.forEach(carte => {
          const statusClass = carte.enLigne ? "online" : "offline";
          const statusText = carte.enLigne ? "Connectée 🟢" : "Déconnectée 🔴";
          
          let relaisHtml = '';
          for(let i=1; i<=6; i++) {
            const estOn = (carte.etat & (1 << (i-1)));
            relaisHtml += \`
            <div class="card">
              <span class="indicator \${estOn ? 'on' : 'off'}"></span> R\${i}<br>
              <button class="\${estOn ? 'btn-off' : 'btn-on'}" onclick="envoyerOrdre('\${carte.nom}', '\${i}', '\${estOn ? 'OFF' : 'ON'}')">
                \${estOn ? 'OFF' : 'ON'}
              </button>
            </div>\`;
          }

          html += \`
          <div class="carte-section">
            <div class="status-bar \${statusClass}">Appareil : \${carte.nom.replace(/_/g, ' ')} - \${statusText}</div>
            <div class="container">\${relaisHtml}</div>
          </div>\`;
        });
        document.getElementById('cartes-container').innerHTML = html;
      }

      // Le format d'envoi est maintenant : PIN-NomCarte-R1_ON
      function envoyerOrdre(nomCarte, numeroRelais, action) { 
        if(ws.readyState === WebSocket.OPEN) {
            ws.send(codePin + "-" + nomCarte + "-R" + numeroRelais + "_" + action); 
        } else {
            alert("Déconnecté du serveur !");
        }
      }
    </script>
  </body>
  </html>`;
  res.send(html);
});


// --- 2. GESTION DES COMMUNICATIONS WEBSOCKETS ---
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    const data = message.toString();

    // A. Une carte se présente (INIT:Maison_Fletre:50.75:2.61)
    if (data.startsWith("INIT:")) {
      const parts = data.split(":");
      if (parts.length >= 4) {
        const nom = parts[1];
        registreCartes.set(nom, { ws: ws, lat: parts[2], lon: parts[3], etat: 0 });
        console.log(\`[Nouvelle Carte] \${nom} enregistrée aux coordonnées \${parts[2]}, \${parts[3]}\`);
        diffuserMiseAJourWeb();
      }
    } 
    // B. Une carte envoie son état (STATE:Maison_Fletre:1)
    else if (data.startsWith("STATE:")) {
      const parts = data.split(":");
      if (parts.length >= 3) {
        const nom = parts[1];
        const etat = parseInt(parts[2]);
        if (registreCartes.has(nom)) {
          registreCartes.get(nom).etat = etat;
          registreCartes.get(nom).ws = ws; // Met à jour le "tuyau" au cas où elle se serait reconnectée
          diffuserMiseAJourWeb();
        }
      }
    }
    // C. Le navigateur demande à rafraîchir l'écran
    else if (data === "GET_DASHBOARD") {
      diffuserMiseAJourWeb();
    }
    // D. Le navigateur envoie un ordre manuel sécurisé (1234-Maison_Fletre-R1_ON)
    else if (data.startsWith(CODE_SECRET + "-")) {
      const parts = data.split("-");
      if (parts.length >= 3) {
        const cible = parts[1];
        const ordre = parts[2]; // ex: R1_ON
        
        // On cherche la bonne carte dans le registre et on lui transmet l'ordre
        if (registreCartes.has(cible)) {
          const carteWs = registreCartes.get(cible).ws;
          if (carteWs && carteWs.readyState === WebSocket.OPEN) {
            carteWs.send(ordre);
            console.log(\`[Ordre Manuel] Action \${ordre} transmise à \${cible}\`);
          }
        }
      }
    }
  });
});

// Prépare un résumé de l'annuaire au format JSON et l'envoie à tous les téléphones/navigateurs connectés
function diffuserMiseAJourWeb() {
  const resume = [];
  for (const [nom, infos] of registreCartes.entries()) {
    const enLigne = (infos.ws && infos.ws.readyState === WebSocket.OPEN);
    resume.push({ nom: nom, etat: infos.etat, enLigne: enLigne });
  }
  const json = JSON.stringify({ type: "UPDATE", liste: resume });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json); // La puce ESP32 ignorera ce message car il ne commence pas par "R"
    }
  });
}


// --- 3. LE CERVEAU MÉTÉO AUTOMATISÉ ---
async function verifierPluieGlobal() {
  console.log("[Météo] Début de la tournée d'inspection pour toutes les cartes...");
  
  // Le serveur parcourt son annuaire de cartes une par une
  for (const [nom, infos] of registreCartes.entries()) {
    // Inutile de vérifier la météo si la carte est débranchée
    if (!infos.ws || infos.ws.readyState !== WebSocket.OPEN) {
      continue; 
    }

    try {
      // On utilise les coordonnées spécifiques (lat/lon) de la carte en cours
      const url = \`https://api.open-meteo.com/v1/forecast?latitude=\${infos.lat}&longitude=\${infos.lon}&hourly=precipitation&timezone=Europe%2FParis&forecast_days=3\`;
      const reponse = await fetch(url);
      const data = await reponse.json();

      const heureActuelle = new Date().getTime();
      let indexDepart = data.hourly.time.findIndex(t => new Date(t).getTime() >= heureActuelle);
      if (indexDepart === -1) indexDepart = 0;

      let pluieTotale = 0;
      for (let i = indexDepart; i < indexDepart + 48 && i < data.hourly.precipitation.length; i++) {
        pluieTotale += data.hourly.precipitation[i];
      }

      console.log(\`[Météo] \${nom} : \${pluieTotale.toFixed(1)} mm prévus sur 48h.\`);

      // Prise de décision pour cette carte spécifique
      if (pluieTotale > 10) {
        infos.ws.send("R1_ON");
        console.log(\`[Alerte Pluie] Allumage R1 pour \${nom}\`);
      } else {
        infos.ws.send("R1_OFF");
        console.log(\`[Météo Calme] Extinction R1 pour \${nom}\`);
      }

    } catch (erreur) {
      console.error(\`[Erreur Météo] Impossible de joindre l'API pour \${nom}\`);
    }
  }
}

// Lancement de la tournée météo toutes les heures
setInterval(verifierPluieGlobal, 3600000);
// Lancement initial 10 secondes après le démarrage
setTimeout(verifierPluieGlobal, 10000);

// Démarrage du serveur web
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Serveur centralisé en ligne sur le port ' + PORT);
});
