// Script de teste para simular convites de amizade e convites de party/lobby
// Usa o mesmo modelo do test-players.js (conexões WebSocket "fake-token" em dev)
//
// Como usar:
// 1) NODE_ENV=development node src/test-friends-and-party.js
// 2) Ajuste WS_URL se necessário.

const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://localhost:3001';

// Defina quantos bots quiser; aqui usamos 3 para demonstrar:
// - Bot A envia convite de amizade para Bot B
// - Bot A cria party e convida Bot B
// - Bot B aceita o convite de party
const bots = [
  { oidUser: 1201, username: 'BotA', discordId: 'botA#0001' },
  { oidUser: 1202, username: 'BotB', discordId: 'botB#0002' },
  { oidUser: 1203, username: 'BotC', discordId: 'botC#0003' }, // opcional
];

// Mapa para guardar sockets e partyIds
const sockets = new Map();
let partyId = null;

bots.forEach((bot) => {
  const ws = new WebSocket(WS_URL);
  sockets.set(bot.oidUser, ws);

  ws.on('open', () => {
    console.log(`[${bot.username}] conectado`);
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.log(`[${bot.username}] recebeu não-JSON:`, data.toString());
      return;
    }

    if (msg.type === 'AUTH_REQUIRED') {
      ws.send(
        JSON.stringify({
          type: 'AUTH',
          payload: {
            oidUser: bot.oidUser,
            token: 'fake-token', // permitido em dev (ver ranked-websocket-server validateAuthToken)
            username: bot.username,
            discordId: bot.discordId,
          },
        })
      );
    }

    if (msg.type === 'AUTH_SUCCESS') {
      console.log(`[${bot.username}] AUTH_SUCCESS`);

      // BotA: cria party e convida BotB
      if (bot.oidUser === bots[0].oidUser) {
        ws.send(JSON.stringify({ type: 'PARTY_CREATE' }));
      }

      // Envia pedido de amizade para o próximo bot (ciclo simples)
      const target = bots.find((b) => b.oidUser !== bot.oidUser);
      if (target) {
        ws.send(
          JSON.stringify({
            type: 'FRIEND_SEND',
            payload: { targetOidUser: target.oidUser, targetLogin: target.username },
          })
        );
        console.log(`[${bot.username}] Enviou FRIEND_SEND para ${target.username}`);
      }
    }

    if (msg.type === 'PARTY_UPDATED') {
      const pid = msg.payload?.party?.id;
      if (pid) {
        partyId = pid;
        console.log(`[${bot.username}] PARTY_UPDATED id=${pid} membros=${msg.payload.party.members?.join(',')}`);
      }
    }

    if (msg.type === 'PARTY_INVITE') {
      const inviter = msg.payload?.inviterName || msg.payload?.inviterOidUser;
      console.log(`[${bot.username}] Recebeu PARTY_INVITE de ${inviter}`);
      // Bot B aceita convite automaticamente
      if (bot.oidUser === bots[1].oidUser && msg.payload?.partyId) {
        ws.send(
          JSON.stringify({
            type: 'PARTY_ACCEPT_INVITE',
            payload: { partyId: msg.payload.partyId },
          })
        );
        console.log(`[${bot.username}] Aceitou convite para party ${msg.payload.partyId}`);
      }
    }

    if (msg.type === 'PARTY_INVITE_SENT') {
      console.log(`[${bot.username}] Convite de party enviado para ${msg.payload?.targetOidUser}`);
    }

    if (msg.type === 'FRIEND_REQUEST') {
      console.log(`[${bot.username}] Recebeu pedido de amizade de ${msg.payload?.requesterOidUser}`);
      ws.send(
        JSON.stringify({
          type: 'FRIEND_ACCEPT',
          payload: { requesterOidUser: msg.payload?.requesterOidUser },
        })
      );
    }

    if (msg.type === 'FRIEND_ERROR' || msg.type === 'PARTY_ERROR') {
      console.warn(`[${bot.username}] ${msg.type}:`, msg.payload);
    }
  });

  ws.on('close', () => {
    console.log(`[${bot.username}] desconectado`);
  });

  ws.on('error', (err) => {
    console.error(`[${bot.username}] erro:`, err.message);
  });
});

// Depois que a party for criada pelo BotA, manda convite para BotB
setInterval(() => {
  if (partyId) {
    const wsLeader = sockets.get(bots[0].oidUser);
    if (wsLeader && wsLeader.readyState === WebSocket.OPEN) {
      wsLeader.send(
        JSON.stringify({
          type: 'PARTY_INVITE',
          payload: { targetOidUser: bots[1].oidUser },
        })
      );
      console.log(`[${bots[0].username}] Reforçando convite de party para ${bots[1].username}`);
    }
  }
}, 5000);
