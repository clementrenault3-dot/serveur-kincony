const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CODE_SECRET = "manaca"; // Votre code PIN
let dernierEtatRelais = 0;   // Stocke l'état des relais (0 à 255)
let dernierePresenceCarte = 0; // Timestamp du dernier signe de vie

app.get('/', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard KinCony</title>
    <style>
      body { font-family: Arial; text-align: center; background-color: #f4f4f9; padding: 20px;}
      .status-bar { padding: 10px; margin-bottom: 20px; border-radius: 5px; font-weight: bold; }
      .online { background-color: #d4edda; color: #155724; }
      .offline { background-color: #f8d7da; color: #721c24; }
      .container { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
      .card { background: white; padding: 15px; border-radius: 10px; width: 130px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
      .indicator { width: 15px; height: 15px; border-radius: 50%; display: inline-block; margin-right: 5px; }
      .on { background-color: #4CAF50; }
      .off { background-color: #bbb; }
      button { width: 100%; padding: 10px; margin-top: 10px; cursor: pointer; border-radius: 5px; border: none; font-weight: bold; color: white;}
      .btn-on { background-color: #4CAF50; }
      .btn-off { background-color: #f44336; }
      #ecran-app { display: none; }
    </style>
  </head>
  <body>
    <div id="ecran-login">
      <h2>PIN : <input type="password" id="pin-input" style="width:60px"> <button onclick="validerPin()">OK</button></h2>
    </div>

    <div id="ecran-app">
      <div id="status" class="status-bar offline">Carte déconnectée 🔴</div>
      <div class="container" id="relais-container"></div>
    </div>

    <script>
      let codePin = "";
      const ws = new WebSocket('wss://' + window.location.host);
      
      function validerPin() {
        codePin = document.getElementById('pin-input').value;
        document.getElementById('ecran-login').style.display = 'none';
        document.getElementById('ecran-app').style.display = 'block';
      }

      ws.onmessage = (event) => {
        const msg = event.data;
        if (msg.startsWith("STATUS:")) {
            const etat = parseInt(msg.split(":")[1]);
            const statusDiv = document.getElementById('status');
            statusDiv.innerHTML = "Carte en ligne 🟢";
            statusDiv.className = "status-bar online";
            majAffichage(etat);
        }
      };

      function majAffichage(etat) {
        let html = '';
        for(let i=1; i<=6; i++) {
          const estOn = (etat & (1 << (i-1)));
          html += \`<div class="card">
            <span class="indicator \${estOn ? 'on' : 'off'}"></span>Relais \${i}<br>
            <button class="\${estOn ? 'btn-off' : 'btn-on'}" onclick="envoyer('\${i}', '\${estOn ? 'OFF' : 'ON'}')">
              \${estOn ? 'ÉTEINDRE' : 'ALLUMER'}
            </button>
          </div>\`;
        }
        document.getElementById('relais-container').innerHTML = html;
      }

      function envoyer(r, s) { ws.send(codePin + "-R" + r + "_" + s); }
    </script>
  </body>
  </html>`;
  res.send(html);
});

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    const data = message.toString();
    // Si c'est la carte qui envoie son état
    if (data.startsWith("STATE:")) {
        dernierEtatRelais = data.split(":")[1];
        wss.clients.forEach(c => c.send("STATUS:" + dernierEtatRelais));
    } 
    // Si c'est un ordre avec PIN
    else if (data.startsWith(CODE_SECRET + "-")) {
        const ordre = data.substring(CODE_SECRET.length + 1);
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(ordre); });
    }
  });
});

server.listen(process.env.PORT || 3000);
