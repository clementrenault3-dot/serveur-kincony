const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

 Création de la page web envoyée au smartphone
app.get('', (req, res) = {
  const html = `
  !DOCTYPE html
  html
  head
    meta charset=UTF-8
    meta name=viewport content=width=device-width, initial-scale=1.0
    titleContrôle KinConytitle
    style
      body { font-family Arial; text-align center; background-color #f4f4f9; padding-top 20px;}
      button { padding 15px 30px; margin 10px; font-size 18px; border none; border-radius 5px; cursor pointer; color white;}
      .btn-on { background-color #4CAF50; }
      .btn-off { background-color #f44336; }
    style
  head
  body
    h1Contrôle Relais 1h1
    button class=btn-on onclick=envoyerOrdre('R1_ON')ALLUMERbutton
    button class=btn-off onclick=envoyerOrdre('R1_OFF')ÉTEINDREbutton

    script
       Le smartphone se connecte au WebSocket du serveur Hostinger
      const ws = new WebSocket('ws' + window.location.host);
      
      function envoyerOrdre(ordre) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(ordre);
        } else {
          alert(Déconnecté du serveur !);
        }
      }
    script
  body
  html
  `;
  res.send(html);
});

 Gestion des connexions WebSockets (Smartphone ou ESP32)
wss.on('connection', (ws) = {
  console.log('Nouvelle connexion active !');

  ws.on('message', (message) = {
    const ordre = message.toString();
    console.log('Ordre reçu  ' + ordre);

     Le serveur répète l'ordre à tous les appareils connectés (dont la carte ESP32)
    wss.clients.forEach((client) = {
      if (client.readyState === WebSocket.OPEN) {
        client.send(ordre);
      }
    });
  });
});

 Lancement du serveur (port 3000 par défaut, à adapter selon votre configuration Hostinger)
const PORT = process.env.PORT  3000;
server.listen(PORT, () = {
  console.log('Serveur démarré sur le port ' + PORT);
});