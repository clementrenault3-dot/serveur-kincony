const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Création de la page web avec les 6 relais
app.get('/', (req, res) => {
  let boutonsHTML = '';
  // Boucle pour créer les 6 boutons automatiquement
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
    <title>Contrôle KinCony</title>
    <style>
      body { font-family: Arial, sans-serif; text-align: center; background-color: #f4f4f9; padding: 20px;}
      .container { display: flex; flex-wrap: wrap; justify-content: center; gap: 15px; max-width: 800px; margin: auto; }
      .card { background: white; padding: 15px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 120px; }
      button { padding: 10px; margin: 5px 0; font-size: 16px; border: none; border-radius: 5px; cursor: pointer; width: 100%; font-weight: bold;}
      .btn-on { background-color: #4CAF50; color: white;}
      .btn-off { background-color: #f44336; color: white;}
    </style>
  </head>
  <body>
    <h1>Mes 6 Relais</h1>
    <div class="container">
      ${boutonsHTML}
    </div>
    <script>
      const ws = new WebSocket('wss://' + window.location.host);
      function envoyerOrdre(ordre) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(ordre);
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

// Gestion des connexions WebSockets
wss.on('connection', (ws) => {
  console.log('Nouvelle connexion active !');
  ws.on('message', (message) => {
    const ordre = message.toString();
    console.log('Ordre reçu : ' + ordre);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(ordre);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Serveur démarré sur le port ' + PORT);
});
