const WebSocket = require('ws');

const WS_URL = 'ws://localhost:3001'; // Altere para o endpoint do seu servidor

/**
 * Gera uma combinação de classes DETERMINÍSTICA para 8 bots.
 * Isso garante que todos os papéis (T1-T4) sejam preenchidos 2x.
 */
function gerarClasse(i) {
  // Lista de 8 loadouts específicos para garantir 2 de cada T1-T4
  const loadouts = [
    { primary: 'T2', secondary: 'SMG' },    // Bot 1
    { primary: 'T1', secondary: 'T2' },    // Bot 2
    { primary: 'T1', secondary: 'SMG' },    // Bot 3
    { primary: 'T2', secondary: 'T1' },    // Bot 4
    { primary: 'T3', secondary: 'SMG' },    // Bot 5
    { primary: 'T3', secondary: 'T4' },    // Bot 6
    { primary: 'T4', secondary: 'T3' },    // Bot 7
    { primary: 'T4', secondary: 'SMG' },    // Bot 8
  ];

  // Retorna o loadout específico para este bot (i-1 pois o loop começa em 1)
  return loadouts[i - 1];
}

// Loop alterado para 8 jogadores
for (let i = 1; i <= 8; i++) {
  const ws = new WebSocket(WS_URL);
  const oidUser = 1100 + i;
  const username = `BotPlayer${i}`;
  
  // Chama a nova função determinística
  const classes = gerarClasse(i); 
  
  const discordId = `botplayer${i}#000${i}`;

  ws.on('open', () => {
    // Aguarda AUTH_REQUIRED antes de autenticar
    console.log(`${username} conectado (Classes: ${classes.primary}/${classes.secondary})`);
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.log(`${username} recebeu (não JSON):`, data.toString());
      return;
    }
    
    // Descomente a linha abaixo se quiser ver TODAS as mensagens recebidas
    // console.log(`${username} recebeu:`, msg.type);

    if (msg.type === 'AUTH_REQUIRED') {
      ws.send(JSON.stringify({
        type: 'AUTH',
        payload: {
          oidUser,
          token: 'fake-token', // Valor fake para testes
          username,
          discordId
        }
      }));
    }
    
    if (msg.type === 'AUTH_SUCCESS') {
      ws.send(JSON.stringify({
        type: 'QUEUE_JOIN',
        payload: {
          classes // Envia as classes determinísticas
        }
      }));
      console.log(`-> ${username} entrou na fila.`);
    }

    // Responde automaticamente ao MATCH_FOUND com READY_ACCEPT
    if (msg.type === 'MATCH_FOUND' && msg.payload && msg.payload.matchId) {
      // Adiciona um delay aleatório para simular reação humana
      const reactionTime = 1000 + Math.floor(Math.random() * 2000); 
      
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'READY_ACCEPT',
          payload: { matchId: msg.payload.matchId }
        }));
        console.log(`✅ ${username} aceitou o match ${msg.payload.matchId}`);
      }, reactionTime);
    }

    // Log para outros eventos importantes
    if (msg.type === 'LOBBY_READY') {
      console.log(`🎉 ${username} está entrando no lobby ${msg.payload.matchId}`);
    }
    if (msg.type === 'REQUEUE') {
      console.log(`🔄 ${username} voltou para a fila (Motivo: ${msg.payload.reason || 'Falha no Ready'})`);
    }
    if (msg.type === 'HOST_SELECTED' && msg.payload?.hostOidUser === oidUser) {
      const roomId = Math.floor(100000 + Math.random() * 900000);
      const mapNumber = msg.payload?.mapNumber || 1;
      console.log(`🏠 ${username} foi selecionado como host do match ${msg.payload.matchId}. Criando sala ${roomId}...`);
      ws.send(JSON.stringify({
        type: 'HOST_ROOM_CREATED',
        payload: {
          matchId: msg.payload.matchId,
          roomId,
          mapNumber
        }
      }));
    }
  });

  ws.on('close', () => {
    console.log(`🔌 ${username} desconectado`);
  });

  ws.on('error', (err) => {
    // Ignora erros comuns de ECONNRESET que acontecem em testes locais
    if (err.message.includes('ECONNRESET')) {
      console.log(`🔌 ${username} desconectado (ECONNRESET)`);
    } else {
      console.error(`❌ ${username} erro:`, err.message);
    }
  });
}
