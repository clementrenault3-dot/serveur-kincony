const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir les fichiers statiques (HTML, CSS, images, logo, etc.) depuis le dossier public
app.use(express.static(path.join(__dirname, 'public')));

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
    chargerHistoriqueLongTableau(); // Chargement au boot
  }
} catch (erreur) {
  console.log("[Erreur] Impossible de lire la clé Google :", erreur.message);
}

// Buffer mémoire pour éviter d'exploser le Quota Google API
let eventsBuffer = [];

function ecrireHistorique(evenement) {
  if (!authGoogle || !process.env.SPREADSHEET_ID) return;
  const dateFR = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  eventsBuffer.push([dateFR, evenement]);
  console.log(`[Événement Bufferisé en RAM] : ${evenement}`);
}

// Flush du Buffer vers Google Sheets toutes les minutes
setInterval(async () => {
  if (eventsBuffer.length > 0 && authGoogle && process.env.SPREADSHEET_ID) {
    const lignesASauver = [...eventsBuffer];
    eventsBuffer = []; 

    try {
      const sheets = google.sheets({ version: 'v4', auth: authGoogle });
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'Feuille 1!A:B',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: lignesASauver }
      });
      console.log(`[Synchronisation Google API] ${lignesASauver.length} événement(s) poussé(s) avec succès.`);
    } catch (erreur) {
      console.error("[Erreur Google API Flush]", erreur.message);
      eventsBuffer = lignesASauver.concat(eventsBuffer);
    }
  }
}, 60000);

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
    if (rows && rows.length > 0) { 
      let count = 0;
      rows.forEach((row, index) => {
        if(row.length >= 3 && (row[0].includes('20') || row[0].includes('/'))) { 
           let time;
           const s = String(row[0]);
           if (s.includes('/')) { 
              const espace = s.split(' ');
              if (espace.length >= 2) {
                  const d = espace[0].split('/');
                  const h = espace[1].split(':');
                  if (d.length === 3 && h.length >= 2) {
                      time = new Date(d[2], d[1]-1, d[0], h[0], h[1], h[2]||0).getTime();
                  } else time = new Date(s).getTime();
              } else time = new Date(s).getTime();
           } else {
              time = new Date(s).getTime();
           }
           if (isNaN(time)) return; 

           const nom = row[1];
           const vol = parseFloat(String(row[2]).replace(',', '.'));
           
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

// Algorithme d'échantillonnage (toutes les 5 minutes)
setInterval(async () => {
  if (!authGoogle || !process.env.SPREADSHEET_ID) return;
  const sheets = google.sheets({ version: 'v4', auth: authGoogle });
  const timeNow = Date.now();
  const dateIso = new Date().toISOString(); 
  const nouvellesLignes = [];

  for (const [nom, infos] of registreCartes.entries()) {
    if (infos.historiqueVolume && infos.historiqueVolume.length > 0) {
      const dataRecentes = infos.historiqueVolume.filter(p => (timeNow - p.time) < 300000);
      if (dataRecentes.length > 0) {
        let somme = 0;
        dataRecentes.forEach(p => somme += p.volume);
        const moyenne = parseFloat((somme / dataRecentes.length).toFixed(1));
        
        if (!infos.historiqueLong) infos.historiqueLong = [];
        infos.historiqueLong.push({ time: timeNow, volume: moyenne });
        
        if (infos.historiqueLong.length > 18000) infos.historiqueLong.shift();
        
        nouvellesLignes.push([dateIso, nom, moyenne.toString().replace('.', ',')]);
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
      console.log(`[Écriture Base Volume] ${nouvellesLignes.length} points sauvegardés.`);
    } catch(err) {
       console.error("[Écriture Base Volume] Échec:", err.message);
    }
  }
}, 300000);

// --- 1. L'INTERFACE WEB (TABLEAU DE BORD) ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 2. GESTION DES COMMUNICATIONS WEBSOCKETS ---
wss.on('connection', (ws) => {

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
        const surfaceT = parts.length >= 5 ? parseFloat(parts[4]) : 0; 
        
        if (!registreCartes.has(nom)) {
           registreCartes.set(nom, { ws: ws, lat: parts[2], lon: parts[3], surface: surfaceT, etat: 0, derniereVue: Date.now(), historiqueVolume: [], historiqueLong: [] });
           console.log(`[Nouvelle Carte] ${nom} enregistrée. (Toit: ${surfaceT}m²)`);
        } else {
           const infos = registreCartes.get(nom);
           infos.ws = ws;
           infos.lat = parts[2];
           infos.lon = parts[3];
           infos.surface = surfaceT;
           infos.derniereVue = Date.now();
           console.log(`[Information] ${nom} s'est reconnectée au Wi-Fi. (Toit: ${surfaceT}m²)`);
        }
        
        diffuserMiseAJourWeb();
        // Interroger la météo AROME si pas encore connue (sans forcer le rate-limit)
        verifierPluieCarte(nom, false);
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
          const infos = registreCartes.get(nom);
          infos.etat = etat;
          if (volume !== null && !isNaN(volume)) infos.volume = volume;
          if (pourcentage !== null && !isNaN(pourcentage)) infos.pourcentage = pourcentage;
          infos.ws = ws;
          infos.derniereVue = Date.now();
          
          if (!infos.historiqueVolume) infos.historiqueVolume = [];
          if (volume !== null && !isNaN(volume)) {
            infos.historiqueVolume.push({ time: Date.now(), volume: volume });
            if (infos.historiqueVolume.length > 100) infos.historiqueVolume.shift();
            
            if (infos.arretMeteoVolumeCible !== undefined && (infos.etat & 1) !== 0) {
               if (infos.volume <= infos.arretMeteoVolumeCible) {
                   infos.ws.send("R1_OFF");
                   infos.etat = infos.etat & ~1;
                   ecrireHistorique(`${nom} : Plafond sécurisé (Descendu à ${infos.volume}L). Objectif Météo Atteint -> Fermeture Vanne.`);
                   delete infos.arretMeteoVolumeCible;
               }
            }
          }
          diffuserMiseAJourWeb();

          // Si la carte n'a pas encore reçu sa météo, retenter la récupération AROME
          if (infos.pluiePrevue === undefined) {
             verifierPluieCarte(nom);
          }
        }
      }
    }
    else if (data.startsWith("METEO_REPORT:")) {
      const parts = data.split(":");
      if (parts.length >= 3) {
        const nom = parts[1];
        const pluieVal = parseFloat(parts[2]);
        if (registreCartes.has(nom) && !isNaN(pluieVal)) {
          const infos = registreCartes.get(nom);
          infos.pluiePrevue = pluieVal.toFixed(1);
          infos.tempsDerniereMeteo = Date.now();
          delete infos.dernierEchecMeteo;
          console.log(`[Météo Directe reçue de ${nom}] : ${infos.pluiePrevue} mm (IP Maison).`);
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
        const periode = parts[2];
        
        if (registreCartes.has(nomCarte)) {
            const infos = registreCartes.get(nomCarte);
            const refTime = Date.now();
            let pointsCibles = [];
            let intervalleMillis = 0;
            let timeLimite = 0;
            
            if (periode === '1d') {
                timeLimite = refTime - (24 * 3600 * 1000); 
                intervalleMillis = 0; 
            } else if (periode === '1w') {
                timeLimite = refTime - (7 * 24 * 3600 * 1000);
                intervalleMillis = 1800000; 
            } else if (periode === '1m') {
                timeLimite = refTime - (31 * 24 * 3600 * 1000);
                intervalleMillis = 14400000; 
            }
            
            let ensemblePoints = [];
            if (infos.historiqueLong) ensemblePoints = ensemblePoints.concat(infos.historiqueLong);
            if (infos.historiqueVolume) ensemblePoints = ensemblePoints.concat(infos.historiqueVolume);
            
            ensemblePoints.sort((a,b) => a.time - b.time);

            if (ensemblePoints.length > 0) {
                const filteredList = ensemblePoints.filter(p => p.time >= timeLimite);
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
    else if (data.indexOf('-') !== -1 && !data.startsWith("GET_CHART_HISTORY-")) {
      if (data.startsWith(CODE_SECRET + "-")) {
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
      } else {
        console.log("[Alerte Sécurité] Tentative d'accès non autorisée. Kick matériel.");
        ws.terminate();
      }
    }
  });
});

function diffuserMiseAJourWeb() {
  const resume = [];
  const socketsHardware = new Set();

  for (const [nom, infos] of registreCartes.entries()) {
    const enLigne = (infos.ws && infos.ws.readyState === WebSocket.OPEN);
    if (infos.ws) socketsHardware.add(infos.ws);
    
    resume.push({
      nom: nom,
      etat: infos.etat,
      volume: infos.volume,
      pourcentage: infos.pourcentage,
      pluie: infos.pluiePrevue,
      enLigne: enLigne
    });
  }
  
  const json = JSON.stringify({ type: "UPDATE", liste: resume });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && !socketsHardware.has(client)) {
       client.send(json);
    }
  });
}

// --- 3. WATCHDOG ---
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

// --- 4. LE CERVEAU MÉTÉO BASÉ SUR L'API DÉDIÉE MÉTÉO-FRANCE (AROME / ARPEGE) ---
async function verifierPluieCarte(nomCarte, force = false) {
  const infos = registreCartes.get(nomCarte);
  if (!infos || !infos.ws || infos.ws.readyState !== WebSocket.OPEN) return;

  const maintenant = Date.now();

  // 1. Si la météo AROME valide date de moins de 2h, renvoyer la valeur connue
  if (!force && infos.tempsDerniereMeteo && (maintenant - infos.tempsDerniereMeteo < 7200000) && infos.pluiePrevue !== undefined) {
    infos.ws.send("METEO:" + infos.pluiePrevue);
    return;
  }

  // 2. Si un échec 429 / rate-limit a eu lieu récemment (< 15 min), temporiser pour laisser débloquer l'IP
  if (!force && infos.dernierEchecMeteo && (maintenant - infos.dernierEchecMeteo < 900000)) {
    return;
  }

  const lat = parseFloat(infos.lat) || 50.75;
  const lon = parseFloat(infos.lon) || 2.61;

  // URLs à tester (URL principale + URL de secours avec le modèle AROME explicite)
  const urls = [
    `https://api.open-meteo.com/v1/meteofrance?latitude=${lat}&longitude=${lon}&hourly=precipitation&timezone=Europe%2FParis`,
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation&models=meteofrance_arome&timezone=Europe%2FParis`
  ];

  let reponse = null;
  let reponseSucces = false;

  for (const url of urls) {
    try {
      reponse = await fetch(url, {
        headers: {
          'User-Agent': 'KinconyMeteoFranceApp/2.0 (Contact: domotique@fletre.fr)'
        }
      });
      if (reponse.ok) {
        reponseSucces = true;
        break;
      }
    } catch (err) {
      // continuer sur l'URL suivante
    }
  }

  try {
    if (!reponseSucces || !reponse) {
      infos.dernierEchecMeteo = maintenant;
      const status = reponse ? reponse.status : 'Timeout/Erreur Réseau';
      console.log(`[Météo-France AROME ${nomCarte}] Rate-limit ou indisponibilité (Code ${status}). Prochain essai dans 15 min.`);
      return;
    }

    const data = await reponse.json();
    infos.tempsDerniereMeteo = maintenant;
    delete infos.dernierEchecMeteo;

    const heureActuelle = new Date().getTime();
    let indexDepart = data.hourly.time.findIndex(t => new Date(t).getTime() >= heureActuelle);
    if (indexDepart === -1) indexDepart = 0;

    let pluieTotale = 0;
    for (let i = indexDepart; i < indexDepart + 48 && i < data.hourly.precipitation.length; i++) {
      pluieTotale += data.hourly.precipitation[i];
    }

    infos.pluiePrevue = pluieTotale.toFixed(1);
    console.log(`[Météo-France AROME Succès] ${nomCarte} : ${infos.pluiePrevue} mm prévus sur 48h.`);

    if (infos.ws && infos.ws.readyState === WebSocket.OPEN) {
      infos.ws.send("METEO:" + infos.pluiePrevue);
    }
    diffuserMiseAJourWeb();

    let actionMeteoRequise = false;
    const surfaceToit = infos.surface ? infos.surface : 0;
    
    if (surfaceToit > 0 && infos.volume !== undefined && infos.pourcentage !== undefined && infos.pourcentage > 0) {
       const pluieLitrePrevu = pluieTotale * surfaceToit; 
       const capaciteMax = infos.volume / (infos.pourcentage / 100.0);
       const espaceLibre = capaciteMax - infos.volume;
       
       if (pluieLitrePrevu > espaceLibre + 50) {
          actionMeteoRequise = true;
          const surplus = pluieLitrePrevu - espaceLibre;
          infos.arretMeteoVolumeCible = infos.volume - surplus;
          if (infos.arretMeteoVolumeCible < 0) infos.arretMeteoVolumeCible = 0;

          const relais1Allume = (infos.etat & 1) !== 0;
          if (!relais1Allume) {
             infos.ws.send("R1_ON");
             infos.etat = infos.etat | 1;
             ecrireHistorique(`${nomCarte} : DANGER DÉBORDEMENT AROME (${pluieLitrePrevu.toFixed(0)}L attendus pour ${espaceLibre.toFixed(0)}L d'espace). Ouverture Vanne jusqu'à ${infos.arretMeteoVolumeCible.toFixed(0)}L.`);
          }
       }
    } else if (pluieTotale > 10 && surfaceToit === 0) {
       actionMeteoRequise = true;
       const relais1Allume = (infos.etat & 1) !== 0;
       if (!relais1Allume) {
         infos.ws.send("R1_ON");
         infos.etat = infos.etat | 1;
         ecrireHistorique(`${nomCarte} : Alerte Pluie Classique AROME (>10mm) -> Allumage`);
       }
    }

    if (!actionMeteoRequise) {
      const relais1Allume = (infos.etat & 1) !== 0;
      if (relais1Allume && infos.arretMeteoVolumeCible !== undefined) {
         infos.ws.send("R1_OFF");
         infos.etat = infos.etat & ~1;
         ecrireHistorique(`${nomCarte} : Risque Météo Écarté -> Fermeture.`);
         delete infos.arretMeteoVolumeCible;
      }
    }
  } catch (erreur) {
    infos.dernierEchecMeteo = maintenant;
    console.log(`[Erreur Météo-France AROME ${nomCarte}] :`, erreur.message);
  }
}

async function verifierPluieGlobal() {
  for (const [nom, infos] of registreCartes.entries()) {
     await verifierPluieCarte(nom);
  }
}

// Boucle automatique de vérification toutes les 15 minutes
setInterval(verifierPluieGlobal, 900000);

// --- DEMARRAGE DU SERVEUR WEB ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Serveur] En écoute sur le port ${PORT}`);
});