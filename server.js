const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- VOTRE CODE SECRET ICI ---
const CODE_SECRET = "manaca";

// Création de la page web avec écran de verrouillage
app.get('/', (req, res) => {
  let boutonsHTML = '';
  for(let i=1; i<=6; i++) {
    boutonsHTML += `
    <div class="card">
      <h3>Relais ${i}</h3>
      <button class="btn-on" onclick="envoyerOrdre('R${i}_ON')">ON</button>
      <button class="btn-off" onclick="envoyerOrdre('R${i}_OFF')">OFF</button>
    </div>`;
  }

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard Sécurisé</title>
    <style>
      body { font-family: Arial, sans-serif; text-align: center; background-color: #f4f4f9; padding: 20px;}
      .container { display: flex; flex-wrap: wrap; justify-content: center; gap: 15px; max-width: 800px; margin: auto; }
      .card { background: white; padding: 15px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 120px; }
      button { padding: 10px; margin: 5px 0; font-size: 16px; border: none; border-radius: 5px; cursor: pointer; width: 100%; font-weight: bold;}
      .btn-on { background-color: #4CAF50; color: white;}
      .btn-off { background-color: #f44336; color: white;}
      
      /* Styles pour l'écran de connexion */
      #ecran-login { margin-top: 50px; }
      #pin-input { padding: 10px; font-size: 20px; width: 150px; text-align: center; margin-bottom: 15px; border: 2px solid #ccc; border-radius: 5px;}
      .btn-login { background-color: #2196F3; color: white; width: auto; padding: 10px 30px;}
      
      /* On cache le tableau de bord au démarrage */
      #ecran-app { display: none; }
    </style>
  </head>
  <body>

    <div id="ecran-login">
      <h2>Verrouillage de sécurité</h2>
      <p>Entrez votre code PIN pour accéder aux relais :</p>
      <input type="password" id="pin-input" placeholder="****">
      <br>
      <button class="btn-login" onclick="validerPin()">Déverrouiller</button>
    </div>

    <div id="ecran-app">
      <h1>Mes 6 Relais</h1>
      <div class="container">
        ${boutonsHTML}
      </div>
    </div>

    <script>
      let codePin = "";
      const ws = new WebSocket('wss://' + window.location.host);
      
      // Fonction pour masquer l'écran de connexion et afficher les boutons
      function validerPin() {
        codePin = document.getElementById('pin-input').value;
        document.getElementById('ecran-login').style.display = 'none';
        document.getElementById('ecran-app').style.display = 'block';
      }

      function envoyerOrdre(ordre) {
        if (ws.readyState === WebSocket.OPEN) {
          // On envoie le mot de passe collé à l'ordre (ex: 1234-R1_ON)
          ws.send(codePin + '-' + ordre);
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

// Le "Vigile" du serveur : Gestion des connexions et vérification du PIN
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    const data = message.toString();
    const prefixeAttendu = CODE_SECRET + '-';
    
    // Si le message commence bien par le code secret (ex: "1234-")
    if (data.startsWith(prefixeAttendu)) {
      // On découpe la chaîne pour ne garder que l'ordre propre (ex: "R1_ON")
      const ordrePropre = data.substring(prefixeAttendu.length);
      console.log('Ordre autorisé transmis : ' + ordrePropre);
      
      // On transmet l'ordre validé à la carte ESP32
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(ordrePropre);
        }
      });
    } else {
      console.log('Tentative bloquée (Mauvais code) : ' + data);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Serveur sécurisé démarré sur le port ' + PORT);
});
