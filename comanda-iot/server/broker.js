// Broker MQTT local opcional (alternativa ao broker.hivemq.com).
// TCP 1883 -> celular (IoT MQTT Panel), ESP32 e gateway | WebSocket 8083 -> navegador
const net = require('net');
const http = require('http');
const { WebSocketServer, createWebSocketStream } = require('ws');
const { Aedes } = require('aedes');

(async () => {
  const aedes = await Aedes.createBroker();
  net.createServer(aedes.handle).listen(1883, () => console.log('MQTT  (TCP)       : porta 1883'));
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer, handleProtocols: (p) => (p.has('mqtt') ? 'mqtt' : false) });
  wss.on('connection', (sock) => aedes.handle(createWebSocketStream(sock)));
  httpServer.listen(8083, () => console.log('MQTT  (WebSocket) : porta 8083'));
  aedes.on('client', (c) => console.log('+ cliente', c.id));
  aedes.on('clientDisconnect', (c) => console.log('- cliente', c.id));
})();
