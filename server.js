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

// --- CONFIGURATION SÉCURITÉ ---
const CODE_SECRET = process.env.CODE_SECRET || "1234";
const HARDWARE_TOKEN = process.env.HARDWARE_TOKEN || "KINCONY_B4_SECRET_2026";
const STRICT_HARDWARE_AUTH = process.env.STRICT_HARDWARE_AUTH === "true";
const MAX_CARTES = 20;
const NOM_CARTE_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;

const registreCartes = new Map();
const cartesMasquees = new Set();
const historiquePrecharge = new Map(); // Cache des points Google Sheets rattaché uniquement aux cartes actives

// Protection Anti-Bruteforce par IP (Max 5 échecs -> Blocage 5 minutes)
const tentativesParIP = new Map();
const MAX_TENTATIVES_PIN = 5;
const DUREE_BLOCAGE_MS = 5 * 60 * 1000;

function obtenirIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'inconnue';
}

function estIPBloquee(ip) {
  const info = tentativesParIP.get(ip);
  if (!info) return false;
  if (Date.now() > info.expireLe) {
    tentativesParIP.delete(ip);
    return false;
  }
  return info.echecs >= MAX_TENTATIVES_PIN;
}

function enregistrerEchecIP(ip) {
  const maintenant = Date.now();
  const info = tentativesParIP.get(ip) || { echecs: 0, expireLe: maintenant + DUREE_BLOCAGE_MS };
  if (maintenant > info.expireLe) {
    info.echecs = 1;
  } else {
    info.echecs += 1;
  }
  info.expireLe = maintenant + DUREE_BLOCAGE_MS;
  tentativesParIP.set(ip, info);
  return Math.max(0, MAX_TENTATIVES_PIN - info.echecs);
}

function reinitialiserEchecsIP(ip) {
  tentativesParIP.delete(ip);
}

// --- JOURNAL D'ACTIVITÉ EN DIRECT (RAM) + BUFFER GOOGLE SHEETS ---
let eventsBuffer = [];
const journalRecents = [];
const MAX_JOURNAL_RAM = 40;

function ecrireHistorique(evenement, niveau = 'info') {
  const dateFR = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  const entreeJournal = {
    time: Date.now(),
    dateFR: dateFR,
    texte: evenement,
    niveau: niveau
  };

  journalRecents.unshift(entreeJournal);
  if (journalRecents.length > MAX_JOURNAL_RAM) {
    journalRecents.pop();
  }

  diffuserLogWeb(entreeJournal);

  if (!authGoogle || !process.env.SPREADSHEET_ID) return;
  eventsBuffer.push([dateFR, evenement]);
  console.log(`[Événement Bufferisé en RAM] : ${evenement}`);
}

function diffuserLogWeb(entreeJournal) {
  const msg = JSON.stringify({ type: "NEW_LOG", log: entreeJournal });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.estAuthentifieWeb) {
      client.send(msg);
    }
  });
}

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
      rows.forEach((row) => {
        if (row.length >= 3 && (row[0].includes('20') || row[0].includes('/'))) { 
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

           const nom = String(row[1]).trim();
           if (!NOM_CARTE_REGEX.test(nom) || cartesMasquees.has(nom)) return;
           const vol = parseFloat(String(row[2]).replace(',', '.'));
           if (isNaN(vol)) return;
           
           // Stocker dans le cache préchargé sans créer de carte fantôme "Hors ligne" à l'écran
           if (!historiquePrecharge.has(nom)) {
             historiquePrecharge.set(nom, []);
           }
           historiquePrecharge.get(nom).push({ time, volume: vol });

           // Si la carte s'est déjà connectée pendant le chargement, lui rattacher ses points
           const carte = registreCartes.get(nom);
           if (carte) {
             if (!carte.historiqueLong) carte.historiqueLong = [];
             carte.historiqueLong.push({ time, volume: vol });
           }
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
wss.on('connection', (ws, req) => {
  const clientIP = obtenirIP(req);
  ws.estAuthentifieWeb = false;
  ws.estHardware = false;
  ws.cartesAutorisees = new Set();

  // Mise à jour du watchdog sur réception d'un pong matériel
  ws.on('pong', () => {
    for (const nom of ws.cartesAutorisees) {
      const infos = registreCartes.get(nom);
      if (infos) infos.derniereVue = Date.now();
    }
  });

  ws.on('close', () => {
    let changement = false;
    for (const [nom, infos] of registreCartes.entries()) {
      if (infos.ws === ws) {
        infos.ws = null;
        console.log(`[Déconnexion] ${nom} a quitté le réseau.`);
        ecrireHistorique(`${nom} : Déconnexion réseau détectée.`, 'warning');
        changement = true;
      }
    }
    if (changement) diffuserMiseAJourWeb();
  });

  ws.on('message', (message) => {
    const data = message.toString().trim();

    // --- A. AUTHENTIFICATION CLIENT WEB ---
    if (data.startsWith("AUTH:")) {
      if (estIPBloquee(clientIP)) {
        ws.send(JSON.stringify({
          type: "AUTH_ERROR",
          message: "Trop de tentatives échouées. Réessayez dans 5 minutes."
        }));
        return;
      }

      const pinSaisi = data.substring(5);
      if (pinSaisi === CODE_SECRET) {
        reinitialiserEchecsIP(clientIP);
        ws.estAuthentifieWeb = true;
        ws.send(JSON.stringify({ type: "AUTH_OK" }));
        ws.send(JSON.stringify({ type: "LOGS_INIT", logs: journalRecents }));
        diffuserMiseAJourWeb();
      } else {
        const restants = enregistrerEchecIP(clientIP);
        console.log(`[Sécurité] Échec PIN depuis IP ${clientIP} (${restants} essai(s) restant(s)).`);
        ws.send(JSON.stringify({
          type: "AUTH_ERROR",
          message: restants > 0
            ? `Code PIN incorrect (${restants} essai(s) restant(s))`
            : "Accès temporairement bloqué (5 min) suite à trop d'erreurs."
        }));
      }
      return;
    }

    // --- B. ENREGISTREMENT MATÉRIEL (INIT) ---
    if (data.startsWith("INIT:")) {
      const parts = data.split(":");
      if (parts.length >= 4) {
        const nom = parts[1].trim();
        if (!NOM_CARTE_REGEX.test(nom)) {
          console.log(`[Sécurité] Nom de carte rejeté : ${nom}`);
          ws.terminate();
          return;
        }

        const lat = parseFloat(parts[2]) || 50.75;
        const lon = parseFloat(parts[3]) || 2.61;
        const surfaceT = parts.length >= 5 && !isNaN(parseFloat(parts[4])) ? parseFloat(parts[4]) : 100;
        const capaciteMax = parts.length >= 6 && !isNaN(parseFloat(parts[5])) && parseFloat(parts[5]) > 0 ? parseFloat(parts[5]) : 3000;
        const tokenRecu = parts.length >= 7 ? parts[6] : null;

        if (tokenRecu !== HARDWARE_TOKEN) {
          if (STRICT_HARDWARE_AUTH || (tokenRecu !== null && tokenRecu !== HARDWARE_TOKEN)) {
            console.log(`[Sécurité] Jeton matériel invalide pour ${nom} depuis ${clientIP}.`);
            ws.terminate();
            return;
          } else {
            console.log(`[Avertissement Sécurité] ${nom} connectée sans jeton matériel (mode rétrocompatible).`);
          }
        }

        if (!registreCartes.has(nom) && registreCartes.size >= MAX_CARTES) {
          console.log(`[Sécurité] Nombre maximal de cartes atteint (${MAX_CARTES}). Rejet de ${nom}.`);
          ws.terminate();
          return;
        }

        ws.estHardware = true;
        ws.cartesAutorisees.add(nom);
        cartesMasquees.delete(nom);

        if (!registreCartes.has(nom)) {
           const histLongInitial = historiquePrecharge.has(nom) ? [...historiquePrecharge.get(nom)] : [];
           registreCartes.set(nom, {
             ws: ws,
             lat: lat,
             lon: lon,
             surface: surfaceT,
             capaciteMax: capaciteMax,
             modeAutoMeteo: true,
             etat: 0,
             derniereVue: Date.now(),
             historiqueVolume: [],
             historiqueLong: histLongInitial
           });
           console.log(`[Nouvelle Carte] ${nom} enregistrée. (Toit: ${surfaceT}m², Cuve: ${capaciteMax}L)`);
           ecrireHistorique(`${nom} : Carte connectée et initialisée (Toit ${surfaceT}m², Cuve ${capaciteMax}L).`, 'success');
        } else {
           const infos = registreCartes.get(nom);
           const etaitHorsLigne = !infos.ws;
           infos.ws = ws;
           infos.lat = lat;
           infos.lon = lon;
           infos.surface = surfaceT;
           infos.capaciteMax = capaciteMax;
           if (infos.modeAutoMeteo === undefined) infos.modeAutoMeteo = true;
           infos.derniereVue = Date.now();
           console.log(`[Information] ${nom} s'est reconnectée au Wi-Fi. (Toit: ${surfaceT}m², Cuve: ${capaciteMax}L)`);
           if (etaitHorsLigne) {
             ecrireHistorique(`${nom} : Reconnexion au serveur réussie.`, 'success');
           }
        }
        
        diffuserMiseAJourWeb();
        // Interroger la météo AROME si pas encore connue (sans forcer le rate-limit)
        verifierPluieCarte(nom, false);
      }
      return;
    }

    // --- C. ÉTAT DU CAPTEUR ET DES RELAIS (STATE) ---
    if (data.startsWith("STATE:")) {
      const parts = data.split(":");
      if (parts.length >= 3) {
        const nom = parts[1].trim();
        if (!ws.estHardware || !ws.cartesAutorisees.has(nom)) {
          console.log(`[Sécurité] Trame STATE rejetée pour ${nom} (Socket non autorisé).`);
          return;
        }

        const etat = parseInt(parts[2], 10);
        const volume = parts.length >= 5 ? parseFloat(parts[3]) : null;
        const pourcentage = parts.length >= 5 ? parseFloat(parts[4]) : null;
        if (registreCartes.has(nom)) {
          const infos = registreCartes.get(nom);
          if (!isNaN(etat)) infos.etat = etat;
          if (volume !== null && !isNaN(volume)) infos.volume = volume;
          if (pourcentage !== null && !isNaN(pourcentage)) infos.pourcentage = pourcentage;
          infos.ws = ws;
          infos.derniereVue = Date.now();
          
          if (!infos.historiqueVolume) infos.historiqueVolume = [];
          if (volume !== null && !isNaN(volume)) {
            infos.historiqueVolume.push({ time: Date.now(), volume: volume });
            if (infos.historiqueVolume.length > 100) infos.historiqueVolume.shift();
            
            if (infos.modeAutoMeteo && infos.arretMeteoVolumeCible !== undefined && (infos.etat & 1) !== 0) {
               if (infos.volume <= infos.arretMeteoVolumeCible) {
                   infos.ws.send("R1_OFF");
                   infos.etat = infos.etat & ~1;
                   ecrireHistorique(`${nom} : Plafond sécurisé atteint (${infos.volume}L <= ${infos.arretMeteoVolumeCible.toFixed(0)}L) -> Fermeture Vanne (R1).`, 'success');
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
      return;
    }

    // --- D. RAPPORT MÉTÉO DIRECT DE L'ESP32 (METEO_REPORT) ---
    if (data.startsWith("METEO_REPORT:")) {
      const parts = data.split(":");
      if (parts.length >= 3) {
        const nom = parts[1].trim();
        if (!ws.estHardware || !ws.cartesAutorisees.has(nom)) {
          console.log(`[Sécurité] Trame METEO_REPORT rejetée pour ${nom} (Socket non autorisé).`);
          return;
        }

        const pluieVal = parseFloat(parts[2]);
        if (registreCartes.has(nom) && !isNaN(pluieVal) && pluieVal >= 0 && pluieVal <= 500) {
          const infos = registreCartes.get(nom);
          infos.pluiePrevue = pluieVal.toFixed(1);
          infos.tempsDerniereMeteo = Date.now();
          delete infos.dernierEchecMeteo;
          console.log(`[Météo Directe reçue de ${nom}] : ${infos.pluiePrevue} mm sur 48h (IP Maison).`);
          evaluerRisqueDebordement(nom);
          diffuserMiseAJourWeb();
        }
      }
      return;
    }

    // --- E. REQUÊTES TABLEAU DE BORD WEB (SÉCURISÉES PAR SESSION) ---
    if (data === "GET_DASHBOARD") {
      if (!ws.estAuthentifieWeb) {
        ws.send(JSON.stringify({ type: "AUTH_REQUIRED" }));
        return;
      }
      ws.send(JSON.stringify({ type: "LOGS_INIT", logs: journalRecents }));
      diffuserMiseAJourWeb();
      return;
    }

    if (data.startsWith("GET_CHART_HISTORY-")) { 
      if (!ws.estAuthentifieWeb) {
        ws.send(JSON.stringify({ type: "AUTH_REQUIRED" }));
        return;
      }
      const parts = data.split("-");
      if (parts.length >= 3) {
        const periode = parts[parts.length - 1];
        const nomCarte = parts.slice(1, parts.length - 1).join("-");
        
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
            
            ws.send(JSON.stringify({
              type: "HISTORY_DATA",
              nom: nomCarte,
              periode: periode,
              capaciteMax: infos.capaciteMax || 3000,
              cibleMeteo: infos.arretMeteoVolumeCible,
              points: pointsCibles
            }));
        }
      }
      return;
    }

    // --- F. BASCULEMENT DU MODE AUTOMATIQUE MÉTÉO & PURGE DES CARTES FANTÔMES ---
    if (data.startsWith("DELETE_CARD:")) {
      if (!ws.estAuthentifieWeb) {
        ws.send(JSON.stringify({ type: "AUTH_REQUIRED" }));
        return;
      }
      const nomCarte = data.substring(12).trim();
      if (registreCartes.has(nomCarte)) {
        const infos = registreCartes.get(nomCarte);
        if (infos.ws) {
          try { infos.ws.terminate(); } catch (e) {}
        }
        registreCartes.delete(nomCarte);
        cartesMasquees.add(nomCarte);
        ecrireHistorique(`${nomCarte} : Carte retirée de l'affichage par l'utilisateur.`, 'warning');
        diffuserMiseAJourWeb();
      }
      return;
    }

    if (data === "PURGE_OFFLINE") {
      if (!ws.estAuthentifieWeb) {
        ws.send(JSON.stringify({ type: "AUTH_REQUIRED" }));
        return;
      }
      let nbSupprimees = 0;
      for (const [nom, infos] of registreCartes.entries()) {
        const enLigne = Boolean(infos.ws && infos.ws.readyState === WebSocket.OPEN);
        if (!enLigne) {
          registreCartes.delete(nom);
          cartesMasquees.add(nom);
          nbSupprimees++;
        }
      }
      if (nbSupprimees > 0) {
        ecrireHistorique(`Purge d'affichage : ${nbSupprimees} ancienne(s) carte(s) hors-ligne supprimée(s).`, 'warning');
        diffuserMiseAJourWeb();
      }
      return;
    }

    if (data.startsWith("TOGGLE_AUTO:")) {
      if (!ws.estAuthentifieWeb) {
        ws.send(JSON.stringify({ type: "AUTH_REQUIRED" }));
        return;
      }
      const nomCarte = data.substring(12).trim();
      if (registreCartes.has(nomCarte)) {
        const infos = registreCartes.get(nomCarte);
        infos.modeAutoMeteo = !infos.modeAutoMeteo;
        if (!infos.modeAutoMeteo) {
          delete infos.arretMeteoVolumeCible;
          ecrireHistorique(`${nomCarte} : Automatisme météo désactivé (Passage en mode Manuel).`, 'warning');
        } else {
          ecrireHistorique(`${nomCarte} : Automatisme météo activé.`, 'info');
          evaluerRisqueDebordement(nomCarte);
        }
        diffuserMiseAJourWeb();
      }
      return;
    }

    // --- G. ORDRES MANUELS DE PILOTAGE RELAIS ---
    if (data.indexOf('-') !== -1) {
      if (estIPBloquee(clientIP)) {
        ws.send(JSON.stringify({ type: "AUTH_ERROR", message: "IP temporairement bloquée." }));
        return;
      }

      if (data.startsWith(CODE_SECRET + "-")) {
        reinitialiserEchecsIP(clientIP);
        ws.estAuthentifieWeb = true;
        const reste = data.substring(CODE_SECRET.length + 1);
        const dernierTiret = reste.lastIndexOf("-");
        if (dernierTiret !== -1) {
          const cible = reste.substring(0, dernierTiret);
          const ordre = reste.substring(dernierTiret + 1);

          if (registreCartes.has(cible) && /^R[1-4]_(ON|OFF)$/.test(ordre)) {
            const infos = registreCartes.get(cible);
            const carteWs = infos.ws;
            if (carteWs && carteWs.readyState === WebSocket.OPEN) {
              carteWs.send(ordre);

              const numRelais = parseInt(ordre.charAt(1), 10);
              const masque = 1 << (numRelais - 1);
              if (ordre.endsWith("_ON")) {
                infos.etat = infos.etat | masque;
              } else {
                infos.etat = infos.etat & ~masque;
              }

              // Si l'utilisateur pilote manuellement R1, annuler une éventuelle consigne météo en cours pour éviter tout conflit
              if (numRelais === 1 && infos.arretMeteoVolumeCible !== undefined) {
                delete infos.arretMeteoVolumeCible;
                ecrireHistorique(`${cible} : Reprise en main manuelle sur R1 (${ordre}) -> Consigne météo annulée.`, 'warning');
              } else {
                ecrireHistorique(`${cible} : Ordre MANUEL envoyé -> ${ordre}`, 'info');
              }

              diffuserMiseAJourWeb();
            } else {
              console.log(`[Erreur] Ordre annulé, ${cible} est hors ligne.`);
            }
          }
        }
      } else {
        const restants = enregistrerEchecIP(clientIP);
        console.log(`[Alerte Sécurité] Tentative d'ordre non autorisée depuis ${clientIP} (${restants} essai(s) restant(s)).`);
        ws.send(JSON.stringify({ type: "AUTH_ERROR", message: "Code PIN invalide pour exécuter cet ordre." }));
        if (restants === 0) ws.terminate();
      }
    }
  });
});

function calculerMetriquesMeteo(infos) {
  const surfaceToit = infos.surface !== undefined ? infos.surface : 100;
  const capaciteMax = infos.capaciteMax || 3000;
  const volumeActuel = infos.volume !== undefined ? infos.volume : 0;
  const espaceLibre = Math.max(0, capaciteMax - volumeActuel);
  const pluieMm = infos.pluiePrevue !== undefined ? parseFloat(infos.pluiePrevue) : null;
  const pluieLitrePrevu = (pluieMm !== null && !isNaN(pluieMm)) ? Math.round(pluieMm * surfaceToit) : null;
  const risqueDebordement = (pluieLitrePrevu !== null) && (pluieLitrePrevu > espaceLibre + 50);

  return {
    surfaceToit,
    capaciteMax,
    espaceLibre: Math.round(espaceLibre),
    pluieLitrePrevu,
    risqueDebordement
  };
}

function diffuserMiseAJourWeb() {
  const resume = [];

  for (const [nom, infos] of registreCartes.entries()) {
    const enLigne = Boolean(infos.ws && infos.ws.readyState === WebSocket.OPEN);
    const metriques = calculerMetriquesMeteo(infos);
    
    resume.push({
      nom: nom,
      etat: infos.etat || 0,
      volume: infos.volume !== undefined ? infos.volume : null,
      pourcentage: infos.pourcentage !== undefined ? infos.pourcentage : null,
      pluie: infos.pluiePrevue,
      enLigne: enLigne,
      derniereVue: infos.derniereVue || 0,
      surface: metriques.surfaceToit,
      capaciteMax: metriques.capaciteMax,
      espaceLibre: metriques.espaceLibre,
      pluieLitrePrevu: metriques.pluieLitrePrevu,
      risqueDebordement: metriques.risqueDebordement,
      modeAutoMeteo: infos.modeAutoMeteo !== false,
      cibleMeteo: infos.arretMeteoVolumeCible !== undefined ? Math.round(infos.arretMeteoVolumeCible) : null
    });
  }
  
  const json = JSON.stringify({ type: "UPDATE", liste: resume });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.estAuthentifieWeb && !client.estHardware) {
       client.send(json);
    }
  });
}

// --- 3. WATCHDOG MATÉRIEL (AVEC PING WEBSOCKET & TOLÉRANCE 45S) ---
setInterval(() => {
  const maintenant = Date.now();
  let changementDetecte = false;

  for (const [nom, infos] of registreCartes.entries()) {
    if (infos.ws) {
      if (maintenant - infos.derniereVue > 45000) {
        console.log(`[Alerte] ${nom} ne répond plus depuis >45s (Coupure de courant ou de Wi-Fi).`);
        ecrireHistorique(`${nom} : Délai d'attente dépassé (>45s sans signal).`, 'danger');
        infos.ws.terminate();
        infos.ws = null;
        changementDetecte = true;
      } else if (infos.ws.readyState === WebSocket.OPEN) {
        try {
          infos.ws.ping();
        } catch (e) {
          // Ignorer erreur de ping
        }
      }
    }
  }

  if (changementDetecte) {
    diffuserMiseAJourWeb();
  }
}, 15000);

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

  // URLs avec forecast_hours=48 pour obtenir directement les 48 prochaines heures
  const urls = [
    `https://api.open-meteo.com/v1/meteofrance?latitude=${lat}&longitude=${lon}&hourly=precipitation&forecast_hours=48&timezone=Europe%2FParis`,
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation&models=meteofrance_arome&forecast_hours=48&timezone=Europe%2FParis`
  ];

  let reponse = null;
  let reponseSucces = false;

  for (const url of urls) {
    try {
      reponse = await fetch(url, {
        headers: {
          'User-Agent': 'KinconyMeteoFranceApp/2.1 (Contact: domotique@fletre.fr)'
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

    let pluieTotale = 0;
    if (data.hourly && Array.isArray(data.hourly.precipitation)) {
      for (let i = 0; i < 48 && i < data.hourly.precipitation.length; i++) {
        const val = data.hourly.precipitation[i];
        if (typeof val === 'number' && !isNaN(val)) {
          pluieTotale += val;
        }
      }
    }

    infos.pluiePrevue = pluieTotale.toFixed(1);
    console.log(`[Météo-France AROME Succès] ${nomCarte} : ${infos.pluiePrevue} mm prévus sur 48h.`);

    if (infos.ws && infos.ws.readyState === WebSocket.OPEN) {
      infos.ws.send("METEO:" + infos.pluiePrevue);
    }

    evaluerRisqueDebordement(nomCarte);
    diffuserMiseAJourWeb();
  } catch (erreur) {
    infos.dernierEchecMeteo = maintenant;
    console.log(`[Erreur Météo-France AROME ${nomCarte}] :`, erreur.message);
  }
}

function evaluerRisqueDebordement(nomCarte) {
  const infos = registreCartes.get(nomCarte);
  if (!infos || !infos.ws || infos.ws.readyState !== WebSocket.OPEN) return;
  if (infos.modeAutoMeteo === false) return;
  if (infos.pluiePrevue === undefined || isNaN(parseFloat(infos.pluiePrevue))) return;

  const pluieTotale = parseFloat(infos.pluiePrevue);
  let actionMeteoRequise = false;
  const surfaceToit = infos.surface !== undefined ? infos.surface : 0;
  const capaciteMax = infos.capaciteMax || 3000;
  
  if (surfaceToit > 0 && infos.volume !== undefined && capaciteMax > 0) {
     const pluieLitrePrevu = pluieTotale * surfaceToit; 
     const espaceLibre = Math.max(0, capaciteMax - infos.volume);
     
     if (pluieLitrePrevu > espaceLibre + 50) {
        actionMeteoRequise = true;
        const surplus = pluieLitrePrevu - espaceLibre;
        infos.arretMeteoVolumeCible = Math.max(0, infos.volume - surplus);

        const relais1Allume = (infos.etat & 1) !== 0;
        if (!relais1Allume) {
           infos.ws.send("R1_ON");
           infos.etat = infos.etat | 1;
           ecrireHistorique(`${nomCarte} : DANGER DÉBORDEMENT AROME (${pluieLitrePrevu.toFixed(0)}L attendus pour ${espaceLibre.toFixed(0)}L libres). Ouverture Vanne (R1) jusqu'à ${infos.arretMeteoVolumeCible.toFixed(0)}L.`, 'danger');
        }
     }
  } else if (pluieTotale > 10 && surfaceToit === 0) {
     actionMeteoRequise = true;
     const relais1Allume = (infos.etat & 1) !== 0;
     if (!relais1Allume) {
       infos.ws.send("R1_ON");
       infos.etat = infos.etat | 1;
       ecrireHistorique(`${nomCarte} : Alerte Pluie Classique AROME (>10mm) -> Ouverture Vanne (R1).`, 'warning');
     }
  }

  if (!actionMeteoRequise) {
    const relais1Allume = (infos.etat & 1) !== 0;
    if (relais1Allume && infos.arretMeteoVolumeCible !== undefined) {
       infos.ws.send("R1_OFF");
       infos.etat = infos.etat & ~1;
       ecrireHistorique(`${nomCarte} : Risque Météo Écarté -> Fermeture Vanne (R1).`, 'success');
       delete infos.arretMeteoVolumeCible;
    }
  }
}

async function verifierPluieGlobal() {
  for (const [nom] of registreCartes.entries()) {
     await verifierPluieCarte(nom);
  }
}

// Boucle automatique de vérification toutes les 15 minutes
setInterval(verifierPluieGlobal, 900000);

// --- DÉMARRAGE DU SERVEUR WEB ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Serveur] En écoute sur le port ${PORT}`);
  ecrireHistorique(`Serveur Eau-Pilot démarré et prêt sur le port ${PORT}.`, 'info');
});
