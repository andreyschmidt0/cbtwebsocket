// Script de teste: envia até 10 convites de amizade para os alvos especificados.
// Uso: NODE_ENV=development node src/test-friend-spam.js
// Ajuste WS_URL ou TARGETS conforme necessário.

const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://localhost:3001';
const TARGETS = [16271, 7662]; // ids que receberão os convites

// Cria até 10 bots com oidUser/username distintos
const bots = Array.from({ length: 10 }, (_, i) => ({
  oidUser: 1301 + i,
  username: `FriendBot${i + 1}`,
  discordId: `friendbot${i + 1}#000${i + 1}`,
}));

bots.forEach((bot) => {
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log(`[${bot.username}] conectado`);
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log(`[${bot.username}] recebeu não-JSON:`, data.toString());
      return;
    }

    if (msg.type === 'AUTH_REQUIRED') {
      ws.send(
        JSON.stringify({
          type: 'AUTH',
          payload: {
            oidUser: bot.oidUser,
            token: 'fake-token', // permitido em dev conforme validateAuthToken
            username: bot.username,
            discordId: bot.discordId,
          },
        })
      );
    }

    if (msg.type === 'AUTH_SUCCESS') {
      // Envia pedidos de amizade para todos os TARGETS
      TARGETS.forEach((targetId) => {
        ws.send(
          JSON.stringify({
            type: 'FRIEND_SEND',
            payload: { targetOidUser: targetId, targetLogin: String(targetId) },
          })
        );
        console.log(`[${bot.username}] Enviou FRIEND_SEND para ${targetId}`);
      });
    }

    if (msg.type === 'FRIEND_ERROR') {
      console.warn(`[${bot.username}] FRIEND_ERROR:`, msg.payload);
    }
    if (msg.type === 'FRIEND_REQUEST_SENT') {
      console.log(`[${bot.username}] FRIEND_REQUEST_SENT payload:`, msg.payload);
    }
  });

  ws.on('close', () => {
    console.log(`[${bot.username}] desconectado`);
  });

  ws.on('error', (err) => {
    console.error(`[${bot.username}] erro:`, err.message);
  });
});
