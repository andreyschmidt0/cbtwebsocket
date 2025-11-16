import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';         // <-- ADICIONADO
import { createServer, Server as HttpServer } from 'http';   // <-- ADICIONADO
import cors from 'cors';             // <-- ADICIONADO
import { QueueManager } from './managers/queue-manager';
import { ReadyManager } from './managers/ready-manager';
import { HOSTManager } from './managers/host-manager';
import { ValidationManager } from './managers/validation-manager';
import { LobbyManager } from './managers/lobby-manager';
import { QueuePlayer, ReadyPlayer } from './types';
import { prismaRanked, prismaGame } from './database/prisma';
import { log } from './utils/logger';
import { getRedisClient } from './database/redis-client';
import crypto from 'crypto';

// ... (Interfaces: AuthenticatedWebSocket, WSMessage, etc. - Sem mudanças) ...
interface AuthenticatedWebSocket extends WebSocket {
  oidUser?: number;
  username?: string;
  discordId?: string;
  isAlive?: boolean;
}

interface WSMessage {
  type: string;
  payload?: any;
}

interface TokenValidationParams {
  token: string;
  oidUser: number;
  discordId?: string;
}

interface TokenValidationResult {
  valid: boolean;
  discordId?: string;
  reason?: string;
}


/**
 * Servidor WebSocket para Ranked Matchmaking
 * Gerencia conexões e mensagens dos jogadores
 */
export class RankedWebSocketServer {
  private redis = getRedisClient();
  private wss: WebSocketServer;
  private clients: Map<number, AuthenticatedWebSocket> = new Map();
  private heartbeatInterval?: NodeJS.Timeout;

  // Managers
  private queueManager: QueueManager;
  private readyManager: ReadyManager;
  private hostManager: HOSTManager;
  private validationManager: ValidationManager;
  private lobbyManager: LobbyManager;

  // Servidor HTTP e App Express
  private app: express.Express;         // <-- ADICIONADO
  private httpServer: HttpServer;     // <-- ADICIONADO

  constructor() {
    // 1. Criar App Express e Servidor HTTP
    this.app = express();
    this.httpServer = createServer(this.app);

    // 2. Configurar CORS (Cross-Origin Resource Sharing)
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
    // Permitir seu frontend, 'null' (para testes locais file://) e localhost
    const corsOrigins = [FRONTEND_URL, 'null', 'http://localhost:3001'];
    
    log('debug', `🌐 CORS Permitido para: ${FRONTEND_URL}`);
    
    this.app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin || corsOrigins.includes(origin)) {
            callback(null, true);
          } else {
            log('warn', `❌ CORS Bloqueado: ${origin}`);
            callback(new Error('Requisição não permitida pelo CORS'));
          }
        },
        credentials: true
      })
    );

    // 3. Rota de Health Check (para Fly.io ou outros serviços)
    this.app.get('/health', (_req, res) => {
      res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    
    // 4. Anexar o WebSocketServer ao Servidor HTTP
    this.wss = new WebSocketServer({ server: this.httpServer });

    // 5. Inicializar todos os managers
    this.queueManager = new QueueManager();
    this.readyManager = new ReadyManager();
    this.hostManager = new HOSTManager();
    this.lobbyManager = new LobbyManager();
    this.validationManager = new ValidationManager({
      onMatchCompleted: async (matchId, result) => {
        log('debug', `✅ Match ${matchId} validado! Vencedor: ${result.winner}`);

		await this.redis.publish("discord:actions", JSON.stringify({ type: 'DELETE_CHANNELS', matchId: matchId }));

        // Busca jogadores e stats da partida (inclui MMR já atualizado)
        const matchPlayers = await prismaRanked.$queryRaw<any[]>`
          SELECT 
            mp.oidUser,
            mp.team,
            ISNULL(mp.kills, 0) as kills,
            ISNULL(mp.deaths, 0) as deaths,
            ISNULL(mp.assists, 0) as assists,
            ISNULL(mp.headshots, 0) as headshots,
            ISNULL(mp.mmrChange, 0) as mmrChange,
            ISNULL(rs.eloRating, 1000) as currentMMR,
            u.NickName as username
          FROM BST_MatchPlayer mp
          LEFT JOIN BST_RankedUserStats rs ON rs.oidUser = mp.oidUser
          LEFT JOIN COMBATARMS.dbo.CBT_User u ON u.oiduser = mp.oidUser
          WHERE mp.matchId = ${matchId}
        `;

        let recipientIds = matchPlayers.map(p => p.oidUser);
        if (recipientIds.length === 0) {
          const fallbackPlayers = await prismaRanked.$queryRaw<any[]>`
            SELECT oidUser FROM BST_MatchPlayer WHERE matchId = ${matchId}
          `;
          recipientIds = fallbackPlayers.map(p => p.oidUser);
        }

        const abandonmentSet = new Set(result.abandonments);
        const playerSummaries = matchPlayers.map(player => {
          const kills = Number(player.kills) || 0;
          const deaths = Number(player.deaths) || 0;
          const assists = Number(player.assists) || 0;
          const headshots = Number(player.headshots) || 0;
          const mmrChange = Number(player.mmrChange) || 0;
          const newMMR = Number(player.currentMMR) || 0;
          const oldMMR = newMMR - mmrChange;
          const kdRatio = deaths > 0 ? parseFloat((kills / deaths).toFixed(2)) : kills;
          const didWin = result.winner ? player.team === result.winner : null;

          // Adiciona recompensas com base nas suas regras
          const rewards = {
            cash: didWin === true ? 50 : 0,
            clanExp: didWin === true ? 10 : 5 // 5 por jogar, +5 por vencer
          };

          return {
            oidUser: player.oidUser,
            username: player.username || `Player ${player.oidUser}`,
            team: player.team,
            result: didWin === null ? 'PENDING' : (didWin ? 'WIN' : 'LOSS'),
            abandoned: abandonmentSet.has(player.oidUser),
            mmr: {
              old: oldMMR,
              new: newMMR,
              change: mmrChange
            },
            stats: {
              kills,
              deaths,
              assists,
              headshots,
              kdRatio
            },
            rewards: rewards
          };
        });

        // Notifica jogadores sobre resultado (futuro: modal de confirmação)
        this.sendToPlayers(
          recipientIds,
          {
            type: 'MATCH_ENDED',
            payload: {
              matchId,
              winner: result.winner,
              abandonments: result.abandonments,
              players: playerSummaries
            }
          }
        );
      },
      onMatchTimeout: async (matchId) => {
        log('warn', `⏰ Match ${matchId} timeout - sem logs suficientes`);

        // ... (lógica de onMatchTimeout - sem mudanças) ...
        const players = await prismaRanked.$queryRaw<any[]>`
          SELECT oidUser FROM BST_MatchPlayer WHERE matchId = ${matchId}
        `;

        this.sendToPlayers(
          players.map(p => p.oidUser),
          {
            type: 'MATCH_CANCELLED',
            payload: {
              matchId,
              reason: 'timeout',
              message: 'Partida não detectada no sistema (timeout de validação)'
            }
          }
        );
      },
      onMatchInvalid: async (matchId, reason) => {
        log('warn', `❌ Match ${matchId} inválido: ${reason}`);

        // ... (lógica de onMatchInvalid - sem mudanças) ...
        const players = await prismaRanked.$queryRaw<any[]>`
          SELECT oidUser FROM BST_MatchPlayer WHERE matchId = ${matchId}
        `;

        this.sendToPlayers(
          players.map(p => p.oidUser),
          {
            type: 'MATCH_INVALID',
            payload: {
              matchId,
              reason,
              message: `Partida cancelada: ${reason}`
            }
          }
        );
      }
    });

    // 6. Configurar Callbacks
    this.setupManagerCallbacks();

    // Callback para quando o HOSTManager aborta a sala (timeout ou falha do host)
    this.hostManager.onHostAborted(async (matchId, hostOidUser, reason, playerIds = []) => {
      // ... (lógica de onHostAborted - sem mudanças) ...
      log('warn', `HOST abortado para match ${matchId} (hostOidUser=${hostOidUser}, reason=${reason})`);

      // Snapshot de fila para preservar prioridades
      const snapshotByPlayer: Record<number, { queuedAt?: number; classes?: QueuePlayer['classes'] }> = {};
      try {
        const snapshotRaw = await this.redis.get(`match:${matchId}:queueSnapshot`);
        if (snapshotRaw) {
          const parsed = JSON.parse(snapshotRaw);
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              if (entry && typeof entry.oidUser === 'number') {
                snapshotByPlayer[entry.oidUser] = {
                  queuedAt: entry.queuedAt,
                  classes: entry.classes
                };
              }
            }
          }
        }
      } catch (err) {
        log('warn', `Falha ao carregar snapshot da fila para match ${matchId}`, err);
      }

      // Remove o host da fila (ele não deve voltar automaticamente)
      await this.queueManager.removeFromQueue(hostOidUser);
      this.sendToPlayer(hostOidUser, {
        type: 'HOST_FAILED',
        payload: { reason }
      });

      // Persiste prioridade para cada jogador e notifica retorno à fila
      for (const oid of playerIds) {
        if (oid === hostOidUser) continue;

        const snapshotEntry = snapshotByPlayer[oid];
        if (snapshotEntry) {
          try {
            await this.redis.set(
              `requeue:ranked:${oid}`,
              JSON.stringify({
                queuedAt: snapshotEntry.queuedAt,
                classes: snapshotEntry.classes
              }),
              { EX: 600 }
            );
          } catch (err) {
            log('warn', `Falha ao preparar dados de requeue para player ${oid}`, err);
          }
        }

        this.sendToPlayer(oid, {
          type: 'REQUEUE',
          payload: {
            message: 'O host não criou a sala. Você voltou para a fila.',
            reason,
            queuedAt: snapshotEntry?.queuedAt || Date.now()
          }
        });
      }

      try {
        await this.redis.del(`match:${matchId}:queueSnapshot`);
      } catch { }
    });

    // 7. Configurar o Servidor WebSocket
    this.setupWebSocketServer();
    this.startHeartbeat();

    log('debug', `🚀 Ranked WebSocket Server pronto.`);
  }

  /**
   * Método para iniciar o servidor e escutar na porta
   */
  public listen(port: number | string): void {
    this.httpServer.listen(port, () => {
      log('debug', `🚀 Servidor escutando na porta ${port}`);
    });
  }

  /**
   * Configurar callbacks dos managers
   */
  private setupManagerCallbacks(): void {
    // ... (Todo o seu método setupManagerCallbacks - sem mudanças) ...
    // Conecta QueueManager com ReadyManager
    this.queueManager.setReadyManager(this.readyManager)

    // Callback quando QueueManager encontrar match
    this.queueManager.onMatchFound((matchId: string, players: QueuePlayer[], teams: any) => {
      log('debug', `📢 Notificando 10 jogadores sobre match ${matchId}`)

      for (const player of players) {
        const team = teams.ALPHA.find((t: QueuePlayer) => t.oidUser === player.oidUser) ? 'ALPHA' : 'BRAVO'

        this.sendToPlayer(player.oidUser, {
          type: 'MATCH_FOUND',
          payload: {
            matchId,
            team,
            players: players.map((p: QueuePlayer) => ({
              username: p.username,
              mmr: p.mmr
            })),
            timeout: 60 // 60 segundos para aceitar
          }
        })
      }
    })

// Callback quando ReadyManager completar (todos aceitaram)
    this.readyManager.onReadyComplete(async (matchId, lobbyData) => {
      log('debug', `📢 Ready check completo! Criando lobby para match ${matchId}...`)

      try {
        // CORREÇÃO: Não precisamos mais consultar o BST_MatchPlayer.
        // Os dados dos jogadores e times vêm diretamente do 'lobbyData'
        // (que o ReadyManager leu do 'lobby:temp:${matchId}' do Redis).
        
        const matchPlayers = lobbyData.players; // Array de QueuePlayer
        const teamsData = lobbyData.teams; // { ALPHA: [QueuePlayer], BRAVO: [QueuePlayer] }

        if (!matchPlayers || !teamsData) {
          log('error', `❌ Erro fatal ao criar lobby: lobbyData incompleto vindo do ReadyManager`, lobbyData);
          return;
        }

        log('debug', `ℹ️ Match ${matchId} tem ${matchPlayers.length} jogadores`)

        // Separa times e anonimiza usernames
        // (Buscamos o MMR real do objeto, não mais o '1000' fixo)
        const teams = {
          ALPHA: teamsData.ALPHA.map((p: any, index: number) => ({
            oidUser: p.oidUser,
            username: `Player ${index + 1}`,
            mmr: Number(p.mmr) || 1000
          })),
          BRAVO: teamsData.BRAVO.map((p: any, index: number) => ({
            oidUser: p.oidUser,
            username: `Player ${index + 1}`,
            mmr: Number(p.mmr) || 1000
          }))
        }

        log('debug', `⚔️ Times: ALPHA=${teams.ALPHA.length}, BRAVO=${teams.BRAVO.length}`)

        // Cria lobby (no LobbyManager)
        await this.lobbyManager.createLobby(matchId, teams)

        // Usa os playerIds do lobbyData
        const playerIds = matchPlayers.map((p: any) => p.oidUser)

        log('debug', `🏁 Enviando LOBBY_READY para ${playerIds.length} jogadores: ${playerIds.join(', ')}`)

        // Redireciona todos para a página da lobby
        this.sendToPlayers(playerIds, {
          type: 'LOBBY_READY',
          payload: {
            matchId,
            redirectTo: `/lobby/${matchId}`
          }
        })

        log('debug', `✅ LOBBY_READY enviado com sucesso para match ${matchId}`)
      } catch (error) {
        log('error', `❌ Erro ao criar lobby para match ${matchId}:`, error)
      }
    })

    // Callback quando ReadyManager falhar
    // @ts-ignore (Ajustando para os parâmetros corretos que o manager parece enviar)
this.readyManager.onReadyFailed(async (
      matchId: string,
      reason: string,
      causeOidUser: number,
      _acceptedPlayers: ReadyPlayer[], // Jogadores que clicaram 'sim'
      allPlayerIds: number[] // TODOS os 10 jogadores do match
    ) => {
      log('warn', `❌ Ready check for match ${matchId} failed. Reason: ${reason}, Caused by: ${causeOidUser}`);

      // 1. Notifica TODOS os 10 jogadores originais sobre o cancelamento
      this.sendToPlayers(allPlayerIds, {
        type: 'READY_CHECK_FAILED',
        payload: {
          matchId,
          reason,
          declinedPlayer: causeOidUser
        }
      });

      // 2. Recoloca na fila os jogadores (corrigido para usar a lógica de snapshot)
      log('debug', `[ReadyFailed ${matchId}] Buscando snapshot da fila...`);
      const snapshotByPlayer: Record<number, { queuedAt?: number; classes?: QueuePlayer['classes'] }> = {};
      try {
        // Busca os dados da fila (classes, queuedAt) que salvamos no QueueManager
        const snapshotRaw = await this.redis.get(`match:${matchId}:queueSnapshot`);
        if (snapshotRaw) {
          const parsed = JSON.parse(snapshotRaw);
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              if (entry && typeof entry.oidUser === 'number') {
                snapshotByPlayer[entry.oidUser] = {
                  queuedAt: entry.queuedAt,
                  classes: entry.classes
                };
              }
            }
          }
        }
      } catch (err) {
        log('warn', `Falha ao carregar snapshot da fila para match ${matchId}`, err);
      }

      // 2b. Recoloca todos os jogadores (exceto o que causou a falha)
      for (const oid of allPlayerIds) {
        // Não recoloca o jogador que causou a falha (seja por recusar ou timeout)
        if (oid === causeOidUser) continue;

        const snapshotEntry = snapshotByPlayer[oid];
        
        // Salva os dados de prioridade no Redis para o próximo QUEUE_JOIN
        if (snapshotEntry) {
          try {
            await this.redis.set(
              `requeue:ranked:${oid}`,
              JSON.stringify({
                queuedAt: snapshotEntry.queuedAt,
                classes: snapshotEntry.classes
              }),
              { EX: 600 } // 10 minutos para reconectar e entrar na fila
            );
          } catch (err) {
            log('warn', `Falha ao preparar dados de requeue para player ${oid}`, err);
          }
        }

        // Notifica o cliente para voltar à fila
        this.sendToPlayer(oid, {
          type: 'REQUEUE',
          payload: {
            message: 'Um jogador recusou a partida. Você foi colocado de volta na fila.',
            reason,
            // Envia o tempo de fila original para o cliente recalcular o timer
            queuedAt: snapshotEntry?.queuedAt || Date.now() 
          }
        });
      }

      // 3. Limpa o snapshot da partida que falhou
      try {
        await this.redis.del(`match:${matchId}:queueSnapshot`);
      } catch { }
    });

    // Callback quando um jogador aceita (atualiza contador)
    this.readyManager.onReadyUpdate((matchId, readyCount, totalPlayers, playerIds) => {
      log('debug', `📢 Broadcasting ready update: ${readyCount}/${totalPlayers} para match ${matchId}`)

      // Envia READY_UPDATE para todos os jogadores do match
      this.sendToPlayers(playerIds, {
        type: 'READY_UPDATE',
        payload: {
          matchId,
          playersReady: readyCount,
          totalPlayers
        }
      })
    })

    // Callback quando mapa for selecionado na lobby
  this.lobbyManager.onMapSelected(async (matchId, mapId) => {
      log('debug', `🗺️ Mapa ${mapId} selecionado para match ${matchId}, iniciando HOST selection...`)

      // Atualiza o BST_RankedMatch com o nome (string) do mapa selecionado
      try {
        await prismaRanked.$executeRaw`
          UPDATE BST_RankedMatch
          SET map = ${mapId}
          WHERE id = ${matchId} AND status = 'ready'
        `
      } catch (err) {
        log('error', `Falha ao salvar o mapa ${mapId} no BST_RankedMatch ${matchId}`, err);
      }

      const lobby = this.lobbyManager.getLobby(matchId)
      if (!lobby) return

      const playerIds = [...lobby.teams.ALPHA, ...lobby.teams.BRAVO].map(p => p.oidUser)

      // Notifica que mapa foi selecionado e inicia host selection
      this.sendToPlayers(playerIds, {
        type: 'MAP_SELECTED',
        payload: {
          matchId,
          mapId,
          message: 'Mapa selecionado! Aguardando criação de sala...'
        }
      })

      // Busca dados do match para HOST selection
    const alphaPlayers = lobby.teams.ALPHA;
      const bravoPlayers = lobby.teams.BRAVO;

      // Prepara players para HOSTManager
      const hostPlayers = [...alphaPlayers, ...bravoPlayers].map((p: any) => {
        // p.username é o nome anônimo (ex: "Player 1").
        // Precisamos do username *real* para o HostManager notificar o host.
        // O username real está no nosso 'clients' Map, salvo durante o handleAuth.
        const client = this.clients.get(p.oidUser);
        
        return {
          oidUser: p.oidUser,
          username: client?.username || p.username, // Usa o username real
          team: alphaPlayers.some(ap => ap.oidUser === p.oidUser) ? 'ALPHA' : 'BRAVO',
          mmr: Number(p.mmr) || 1000,
          ws: client || null // Passa o WebSocket real
        }
      })

      // Busca o mapNumber correto do mapPool
      const mapPool = this.lobbyManager.getRankedMapPool();
      const selectedMapData = mapPool.find(m => m.mapId === mapId);
      const mapNumber = selectedMapData ? selectedMapData.mapNumber : null;

      if (!mapNumber) {
        log('error', `Falha crítica: MapID ${mapId} não encontrado no mapPool.`);
        // TODO: Abortar o match aqui?
        return;
      }

      // Inicia HOST selection com o mapNumber correto
      await this.hostManager.startHostSelection(matchId, hostPlayers as any, mapNumber);
    })

    // Callback quando houver atualização de veto
    this.lobbyManager.onVetoUpdate((matchId, lobby) => {
      const playerIds = [...lobby.teams.ALPHA, ...lobby.teams.BRAVO].map(p => p.oidUser)

      // Notifica todos jogadores sobre atualização do veto
      this.sendToPlayers(playerIds, {
        type: 'VETO_UPDATE',
        payload: {
          matchId,
          vetoedMaps: lobby.vetoedMaps,
          vetoHistory: lobby.vetoHistory,
          currentTurn: lobby.currentTurn,
          timeRemaining: lobby.timeRemaining,
          selectedMap: lobby.selectedMap,
          status: lobby.status
        }
      })
    })

    // Callback quando mudar o turno
    this.lobbyManager.onTurnChange((matchId, newTurn, timeRemaining) => {
      const lobby = this.lobbyManager.getLobby(matchId)
      if (!lobby) return

      const playerIds = [...lobby.teams.ALPHA, ...lobby.teams.BRAVO].map(p => p.oidUser)

      log('debug', `🔄 Turno alterado para ${newTurn} - ${timeRemaining}s`)

      this.sendToPlayers(playerIds, {
        type: 'TURN_CHANGE',
        payload: {
          matchId,
          currentTurn: newTurn,
          timeRemaining
        }
      })
    })

    // Callback quando HOSTManager selecionar HOST
    this.hostManager.onHostSelected(async (matchId, hostOidUser, hostUsername, mapNumber) => {
      log('debug', `📢 Notificando jogadores sobre HOST: ${hostUsername}`)

      const notifyPlayers = async (players: { oidUser: number }[]) => {
        const hostPassword = await this.redis.get(`match:${matchId}:hostPassword`)
        for (const p of players) {
          if (p.oidUser === hostOidUser) {
            this.sendToPlayer(p.oidUser, {
              type: 'HOST_SELECTED',
              payload: {
                matchId,
                hostOidUser,
                hostUsername,
                mapNumber,
                message: 'Você foi selecionado como HOST! Crie a sala no jogo.',
                timeout: 120,
                password: hostPassword
              }
            })
          } else {
            this.sendToPlayer(p.oidUser, {
              type: 'HOST_WAITING',
              payload: {
                matchId,
                hostOidUser,
                hostUsername,
                mapNumber,
                message: `Aguardando ${hostUsername} criar a sala...`
              }
            })
          }
        }
      }

      const lobby = this.lobbyManager.getLobby(matchId)
      if (lobby) {
        const players = [...lobby.teams.ALPHA, ...lobby.teams.BRAVO].map(p => ({ oidUser: p.oidUser }))
        await notifyPlayers(players)
        return
      }

      prismaRanked.$queryRaw<any[]>`
        SELECT oidUser FROM BST_MatchPlayer WHERE matchId = ${matchId}
      `
        .then(notifyPlayers)
        .catch(err => log('warn', `Falha ao notificar HOST_SELECTED: ${err}`))
    })

    // Callback quando sala for confirmada
  this.hostManager.onRoomConfirmed(async (matchId, roomId, mapNumber) => {
      log('debug', `📢 Sala confirmada! Notificando jogadores (Room: ${roomId}, Mapa: ${mapNumber})`)

      // --- INÍCIO DA CORREÇÃO ---
      // Pega os jogadores do lobby em memória, NÃO do SQL
      const lobby = this.lobbyManager.getLobby(matchId);
      if (!lobby) {
        log('error', `Falha crítica: Lobby ${matchId} não encontrado ao confirmar sala.`);
        return;
      }
      const playerIds = [
        ...lobby.teams.ALPHA.map(p => p.oidUser),
        ...lobby.teams.BRAVO.map(p => p.oidUser)
      ];

	try {
			// Prepara dados dos times com os Discord IDs (essencial para o bot)
			const getTeamDiscordIds = (team: 'ALPHA' | 'BRAVO') => {
			  return lobby.teams[team].map(p => {
				const client = this.clients.get(p.oidUser);
				return { oidUser: p.oidUser, discordId: client?.discordId };
			  }).filter(p => p.discordId); // Filtra quem não tem discordId
			};

			const teamsPayload = {
			  alpha: getTeamDiscordIds('ALPHA'),
			  bravo: getTeamDiscordIds('BRAVO')
			};

			await this.redis.publish("discord:actions", JSON.stringify({
			  type: 'CREATE_CHANNELS',
			  matchId: matchId,
			  teams: teamsPayload
			}));
		  } catch (e) {
			log('error', `Falha ao publicar CREATE_CHANNELS no Redis para match ${matchId}`, e);
		  }

      // Recupera senha do Redis
      const hostPassword = await this.redis.get(`match:${matchId}:hostPassword`);
      // Envia HOST_CONFIRMED para TODOS os 10 jogadores
      this.sendToPlayers(playerIds, {
        type: 'HOST_CONFIRMED',
        payload: {
          matchId,
          roomId,
          mapNumber,
          password: hostPassword,
          message: `⚔️ SALA CRIADA! Entre agora no jogo (Room #${roomId}, Mapa ${mapNumber}) Senha: ${hostPassword}`
        }
      });

      // 🔍 INICIA VALIDAÇÃO DA PARTIDA (agora com 10 playerIds)
      await this.validationManager.startValidation(
        matchId,
        mapNumber,
        new Date(), // startedAt
        playerIds
      );
      log('debug', `🔍 Validação iniciada para match ${matchId} (${playerIds.length} jogadores)`);
  });
  }

  /**
   * Configurar servidor WebSocket
   */
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: AuthenticatedWebSocket) => {
      // ... (Toda a sua lógica de 'connection', 'message', 'close', etc. - sem mudanças) ...
      log('debug', '🔌 Nova conexão WebSocket')

      ws.isAlive = true

      ws.on('pong', () => {
        ws.isAlive = true
      })

      ws.on('message', (data: Buffer) => {
        this.handleMessage(ws, data)
      })

      ws.on('close', () => {
        this.handleDisconnect(ws)
      })

      ws.on('error', (error) => {
        log('error', '❌ Erro no WebSocket', error)
      })

      // Solicita autenticação
      this.sendMessage(ws, {
        type: 'AUTH_REQUIRED',
        payload: { message: 'Envie AUTH com oidUser e token' }
      })
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((client) => {
        const socket = client as AuthenticatedWebSocket
        if (socket.isAlive === false) {
          log('warn', `⚠️ Encerrando conexão inativa (${socket.oidUser ?? 'unknown'})`)
          socket.terminate()
          return
        }

        socket.isAlive = false
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.ping()
          } catch (error) {
            log('warn', 'Falha ao enviar ping para cliente', error)
          }
        }
      })
    }, 30000)
  }

  /**
   * Processar mensagem recebida
   */
  private async handleMessage(ws: AuthenticatedWebSocket, data: Buffer): Promise<void> {
    // ... (Todo o seu método handleMessage - sem mudanças) ...
    try {
      const message: WSMessage = JSON.parse(data.toString())
      // Aceita tanto 'payload' quanto 'data' (compatibilidade)
      const payload = message.payload || (message as any).data
      log('debug', `📬 ${message.type}`, { data: payload }) // <-- MUDANÇA: 'info' para 'debug'

      switch (message.type) {
        case 'AUTH':
          await this.handleAuth(ws, payload)
          break

        case 'QUEUE_JOIN':
          await this.handleQueueJoin(ws, payload)
          break

        case 'QUEUE_LEAVE':
          await this.handleQueueLeave(ws)
          break

        case 'READY_ACCEPT':
          await this.handleReadyAccept(ws, payload)
          break

        case 'READY_DECLINE':
          await this.handleReadyDecline(ws, payload)
          break

        case 'HOST_ROOM_CREATED':
          await this.handleHostRoomCreated(ws, payload)
          break

        case 'HOST_FAILED':
          await this.handleHostFailed(ws, payload)
          break

        case 'LOBBY_JOIN':
          await this.handleLobbyJoin(ws, payload)
          break

        case 'MAP_VETO':
          await this.handleMapVeto(ws, payload)
          break

        case 'MAP_VOTE':
          await this.handleMapVote(ws, payload)
          break

        case 'CHAT_SEND':
          await this.handleChatSend(ws, payload)
          break
		  
		case 'LOBBY_REQUEST_SWAP':
          await this.handleLobbyRequestSwap(ws, payload)
          break
		  
		case 'LOBBY_ACCEPT_SWAP':
          await this.handleLobbyAcceptSwap(ws, payload)
          break
		  
		case 'LOBBY_ACCEPT_VOICE_TRANSFER':
		  if (ws.oidUser && ws.discordId && payload.matchId) {
			this.redis.publish("discord:actions", JSON.stringify({
			  type: 'MOVE_PLAYER',
			  oidUser: ws.oidUser,
			  discordId: ws.discordId,
			  matchId: payload.matchId
			}));
		  }
		  break;

        default:
          log('warn', `⚠️ Mensagem desconhecida: ${message.type}`)
          this.sendError(ws, 'Tipo de mensagem inválido')
      }
    } catch (error) {
      log('error', '❌ Erro ao processar mensagem', error)
      this.sendError(ws, 'Erro ao processar mensagem')
    }
  }

  /**
   * AUTH - Autenticação do jogador
   */
  private async handleAuth(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleAuth - sem mudanças) ...
    const { oidUser, token, username, discordId } = payload

    if (!oidUser || !token) {
      this.sendMessage(ws, {
        type: 'AUTH_FAILED',
        payload: { message: 'oidUser e token obrigatórios' }
      })
      return ws.close()
    }

    // 🔐 PROTEÇÃO 1: Verifica se já existe uma conexão ativa com o mesmo oidUser
    const existingConnection = this.clients.get(oidUser)
    if (existingConnection && existingConnection.readyState === WebSocket.OPEN) {
      log('warn', `⚠️ Tentativa de conexão duplicada: ${oidUser} já está conectado`)
      this.sendMessage(ws, {
        type: 'AUTH_FAILED',
        payload: {
          reason: 'ALREADY_CONNECTED',
          message: 'Você já está conectado em outra aba/janela. Apenas uma conexão é permitida por vez.'
        }
      })
      return ws.close()
    }

    const tokenValidation = await this.validateAuthToken({ token, oidUser, discordId })
    if (!tokenValidation.valid) {
      log('warn', `?? Token inválido para oidUser=${oidUser} (${tokenValidation.reason || 'UNKNOWN'})`)
      this.sendMessage(ws, {
        type: 'AUTH_FAILED',
        payload: {
          reason: tokenValidation.reason || 'INVALID_TOKEN',
          message: 'Token inválido ou sessão expirada'
        }
      })
      return ws.close()
    }

    const normalizedDiscordId = discordId || tokenValidation.discordId

    ws.oidUser = oidUser
    ws.discordId = normalizedDiscordId

    // Busca NickName real do banco de dados para garantir consistência
    try {
      // Usa tabela do jogo no banco COMBATARMS (cross-database, mesmo servidor)
      const user = await prismaGame.$queryRaw<any[]>`
          SELECT NickName FROM CBT_User WHERE oiduser = ${oidUser}
        `

      if (user && user.length > 0 && user[0].NickName) {
        ws.username = user[0].NickName
        log('debug', `✅ Username validado do banco: ${ws.username}`)
      } else {
        log('warn', `⚠️ NickName não encontrado no banco para ${oidUser}, usando fallback`)
        ws.username = username || `Player${oidUser}`
      }
    } catch (error) {
      log('warn', `⚠️ Erro ao buscar NickName do banco para ${oidUser}, usando fallback:`, error)
      ws.username = username || `Player${oidUser}`
    }

    this.clients.set(oidUser, ws)

    log('debug', `✅ ${ws.username} (${oidUser}) autenticado${normalizedDiscordId ? ` [Discord: ${normalizedDiscordId}]` : ''}`)

    this.sendMessage(ws, {
      type: 'AUTH_SUCCESS',
      payload: { oidUser, username: ws.username }
    })
  }

  /**
   * QUEUE_JOIN - Jogador entra na fila
   */
  private async handleQueueJoin(ws: AuthenticatedWebSocket, payload?: any): Promise<void> {
    // ... (Todo o seu método handleQueueJoin - sem mudanças) ...
    if (!ws.oidUser) {
      return this.sendError(ws, 'Não autenticado')
    }

    try {
      let queuedAtOverride: number | undefined = payload?.queuedAt
      let classesOverride = payload?.classes
      let requeueKey: string | null = null

      try {
        const key = `requeue:ranked:${ws.oidUser}`
        const raw = await this.redis.get(key)
        if (raw) {
          requeueKey = key
          const data = JSON.parse(raw)
          if (!queuedAtOverride && typeof data?.queuedAt === 'number') {
            queuedAtOverride = data.queuedAt
          }
          if (!classesOverride && data?.classes) {
            classesOverride = data.classes
          }
        }
      } catch (err) {
        log('warn', `Falha ao recuperar dados de requeue para ${ws.oidUser}`, err)
      }

      let playerMMR = 1000
      try {
        const [mmrRow] = await prismaRanked.$queryRaw<{ eloRating: number | null }[]>`
          SELECT ISNULL(eloRating, 1000) as eloRating
          FROM BST_RankedUserStats
          WHERE oidUser = ${ws.oidUser}
        `
        const mmrValue = Number(mmrRow?.eloRating)
        if (!Number.isNaN(mmrValue)) {
          playerMMR = mmrValue
        }
      } catch (mmrError) {
        log('warn', `Falha ao buscar MMR para ${ws.oidUser}, usando default 1000`, mmrError)
      }

      const playerData: QueuePlayer = {
        oidUser: ws.oidUser,
        username: ws.username || `Player${ws.oidUser}`,
        mmr: playerMMR,
        discordId: ws.discordId, // Passa discordId para validação anti-multi-accounting
        classes: classesOverride || { primary: 'T3', secondary: 'SMG' },
        queuedAt: queuedAtOverride,
        joinedAt: Date.now(),
      }

      const validation = await this.queueManager.addToQueue(playerData)

      if (!validation.valid) {
        if (requeueKey) {
          await this.redis.expire(requeueKey, 600).catch(() => { })
        }
        return this.sendMessage(ws, {
          type: 'QUEUE_FAILED',
          payload: {
            reason: validation.reason,
            endsAt: validation.endsAt,
            until: validation.until
          }
        })
      }

      if (requeueKey) {
        await this.redis.del(requeueKey).catch(() => { })
      }

      log('debug', `✅ ${ws.username} entrou na fila`)

      const queueSize = this.queueManager.getQueueSize()

      this.sendMessage(ws, {
        type: 'QUEUE_JOINED',
        payload: {
          queueSize,
          estimatedWait: queueSize * 6, // ~6 segundos por jogador
          queuedAt: playerData.queuedAt
        }
      })

      // O QueueManager já tem matchmaking automático interno (polling a cada 5s)

    } catch (error) {
      log('error', '❌ Erro ao entrar na fila', error)
      this.sendError(ws, 'Erro ao entrar na fila')
    }
  }

  /**
   * QUEUE_LEAVE - Jogador sai da fila
   */
  private async handleQueueLeave(ws: AuthenticatedWebSocket): Promise<void> {
    // ... (Todo o seu método handleQueueLeave - sem mudanças) ...
    if (!ws.oidUser) return

    await this.queueManager.removeFromQueue(ws.oidUser)

    log('debug', `❌ ${ws.username} saiu da fila`)

    this.sendMessage(ws, {
      type: 'QUEUE_LEFT',
      payload: {}
    })
  }

  /**
   * READY_ACCEPT - Jogador aceita match
   */
  private async handleReadyAccept(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleReadyAccept - sem mudanças) ...
    if (!ws.oidUser) return
    const { matchId } = payload || {}
    if (!matchId) {
      return this.sendError(ws, 'matchId ausente em READY_ACCEPT')
    }

    await this.readyManager.handleReady(String(matchId), ws.oidUser)
    log('debug', `✅ ${ws.username} aceitou match ${matchId}`)

    this.sendMessage(ws, {
      type: 'READY_ACCEPTED',
      payload: { matchId }
    })
  }

/**
   * LOBBY_REQUEST_SWAP - Jogador solicita troca com um colega
   */
  private async handleLobbyRequestSwap(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser || !ws.username) return;
    const { matchId, targetOidUser } = payload;
    if (!matchId || !targetOidUser) return;

    const lobby = this.lobbyManager.getLobby(matchId);
    if (!lobby) return;

    // Envia a solicitação APENAS para o jogador alvo
    this.sendToPlayer(targetOidUser, {
      type: 'LOBBY_SWAP_REQUESTED',
      payload: {
        matchId,
        requestingOidUser: ws.oidUser,
        requestingUsername: ws.username
      }
    });
  }

  /**
   * LOBBY_ACCEPT_SWAP - Jogador aceita uma solicitação de troca
   */
  private async handleLobbyAcceptSwap(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const accepterOidUser = ws.oidUser;
    const { matchId, requestingOidUser } = payload;
    if (!matchId || !requestingOidUser) return;

    // 1. Executa a troca no LobbyManager (que atualiza o Redis)
    const success = await this.lobbyManager.executeRoleSwap(matchId, accepterOidUser, requestingOidUser);

    if (!success) {
      this.sendError(ws, 'Falha ao processar a troca.');
      return;
    }

    // 2. Após a troca, precisamos ATUALIZAR o estado de TODOS os jogadores no lobby.
    // A forma mais fácil de re-sincronizar é forçar um 'LOBBY_JOIN' para todos.
    const lobby = this.lobbyManager.getLobby(matchId);
    if (!lobby) return;

    const allPlayerIds = [
      ...lobby.teams.ALPHA.map(p => p.oidUser),
      ...lobby.teams.BRAVO.map(p => p.oidUser)
    ];

    for (const oid of allPlayerIds) {
      const client = this.clients.get(oid);
      if (client && client.readyState === WebSocket.OPEN) {
        // Re-chama o handleLobbyJoin para este cliente, que enviará LOBBY_DATA atualizado
        await this.handleLobbyJoin(client, { matchId });
      }
    }
  }

  /**
   * READY_DECLINE - Jogador recusa match
   */
  private async handleReadyDecline(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleReadyDecline - sem mudanças) ...
    if (!ws.oidUser) return

    const { matchId } = payload || {}
    if (!matchId) {
      return this.sendError(ws, 'matchId ausente em READY_DECLINE')
    }

    log('debug', `❌ ${ws.username} recusou match ${matchId}`)

    // Notifica o ReadyManager; ele cancela o match e dispara onReadyFailed
    await this.readyManager.handleDecline(String(matchId), ws.oidUser)

    // Confirma ao declinante
    this.sendMessage(ws, {
      type: 'READY_DECLINED',
      payload: { matchId }
    })

    // Incremental cooldown por recusas de ready
    try {
      const key = `decline:count:${ws.oidUser}`
      const count = await this.redis.incr(key)
      // Define janela de 24h para o contador (se ainda não existir)
      const ttl = await this.redis.ttl(key)
      if (ttl < 0) {
        await this.redis.expire(key, 24 * 60 * 60)
      }

      let seconds = 0
      if (count === 1) seconds = 60
      else if (count === 2) seconds = 5 * 60
      else seconds = 60 * 60

      const endsAt = Date.now() + seconds * 1000
      await this.redis.set(`cooldown:${ws.oidUser}`, String(endsAt), { EX: seconds })

      // Notifica cliente para bloquear botão localmente
      this.sendMessage(ws, {
        type: 'COOLDOWN_SET',
        payload: { reason: 'DECLINED_READY', seconds, endsAt }
      })
    } catch (e) {
      log('warn', 'Falha ao aplicar cooldown de decline', e)
    }
  }

  /**
   * HOST_ROOM_CREATED - HOST criou sala
   */
  private async handleHostRoomCreated(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleHostRoomCreated - sem mudanças) ...
    if (!ws.oidUser) return

    const { matchId, roomId, mapNumber } = payload

    await this.hostManager.confirmHostRoom(matchId, ws.oidUser, roomId, mapNumber)

    log('debug', `🏁 ${ws.username} criou sala ${roomId} (match ${matchId})`)

    this.sendMessage(ws, {
      type: 'HOST_CONFIRMED',
      payload: { matchId, roomId, mapNumber }
    })
  }

  /**
   * HOST_FAILED - HOST falhou em criar sala
   */
  private async handleHostFailed(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleHostFailed - sem mudanças) ...
    if (!ws.oidUser) return;
    const { matchId, reason } = payload || {};
    if (!matchId) return;
    await this.hostManager.abortByClient(matchId, ws.oidUser, reason || 'HOST_FAILED');
    this.sendMessage(ws, { type: 'HOST_FAILURE_ACKNOWLEDGED', payload: { matchId } });
  }

  /**
   * LOBBY_JOIN - Jogador entrou na lobby
   */
  private async handleLobbyJoin(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleLobbyJoin - sem mudanças) ...
    if (!ws.oidUser) return;
    const { matchId } = payload || {};
    if (!matchId) {
      this.sendError(ws, 'matchId ausente em LOBBY_JOIN');
      return;
    }
    const lobby = this.lobbyManager.getLobby(matchId);
    if (!lobby) {
      this.sendError(ws, 'Lobby não encontrada');
      return;
    }
    const isAlpha = lobby.teams.ALPHA.some(player => player.oidUser === ws.oidUser);
    const isBravo = lobby.teams.BRAVO.some(player => player.oidUser === ws.oidUser);
    const playerTeam: 'ALPHA' | 'BRAVO' | null = isAlpha ? 'ALPHA' : isBravo ? 'BRAVO' : null;
    if (!playerTeam) {
      log(
        'warn',
        `Tentativa de acesso nao autorizada a lobby ${matchId} por ${ws.username || ws.oidUser}`
      );
      this.sendMessage(ws, {
        type: 'LOBBY_UNAUTHORIZED',
        payload: {
          matchId,
          message: 'Voce nao esta autorizado a entrar nesta lobby.',
        },
      });
      return;
    }
    // Enrich with classes mapping (if available)
    let classesByPlayer: Record<number, any> = {}
    try {
      const cls = await this.redis.hGetAll(`match:${matchId}:classes`)
      if (cls) {
        for (const [k, v] of Object.entries(cls)) {
          try { classesByPlayer[parseInt(k, 10)] = JSON.parse(v as any) } catch { }
        }
      }
    } catch { }

    // *** INÍCIO DA CORREÇÃO DE SEGURANÇA ***
    // Filtra as classes para enviar APENAS as do time do jogador
    const filteredClassesByPlayer: Record<number, any> = {};
    if (playerTeam) {
      // playerTeam foi definido 20 linhas acima
      const teamPlayers = lobby.teams[playerTeam].map(p => p.oidUser);
      for (const oid of teamPlayers) {
        if (classesByPlayer[oid]) {
          filteredClassesByPlayer[oid] = classesByPlayer[oid];
        }
      }
    }
    // *** FIM DA CORREÇÃO DE SEGURANÇA ***
    const mapPool = this.lobbyManager.getRankedMapPool(); // <-- ADICIONE ESTA LINHA

    this.sendMessage(ws, {
      type: 'LOBBY_DATA',
      payload: {
        matchId: lobby.matchId,
        teams: lobby.teams,
        vetoedMaps: lobby.vetoedMaps,
        vetoHistory: lobby.vetoHistory,
        currentTurn: lobby.currentTurn,
        timeRemaining: lobby.timeRemaining,
        selectedMap: lobby.selectedMap,
        mapVotes: this.lobbyManager.getMapVotes(matchId),
        playerTeam,
        chatMessages: playerTeam ? lobby.chatMessages[playerTeam] : [],
        status: lobby.status,
        classesByPlayer: filteredClassesByPlayer, // <-- CORRIGIDO
        mapPool: mapPool // <-- ADICIONE ESTA LINHA
      }
    });
    log('debug', `🏰 ${ws.username} entrou na lobby ${matchId}`);
  }

  /**
   * MAP_VETO - Jogador vetou um mapa
   */
  private async handleMapVeto(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleMapVeto - sem mudanças) ...
    if (!ws.oidUser) return

    const { matchId, mapId } = payload

    const lobby = this.lobbyManager.getLobby(matchId)
    if (!lobby) {
      this.sendError(ws, 'Lobby não encontrada')
      return
    }

    // Determina o time do jogador
    const isAlpha = lobby.teams.ALPHA.some(p => p.oidUser === ws.oidUser)
    const isBravo = lobby.teams.BRAVO.some(p => p.oidUser === ws.oidUser)

    if (!isAlpha && !isBravo) {
      this.sendError(ws, 'Você não está nesta partida')
      return
    }

    const playerTeam: 'ALPHA' | 'BRAVO' = isAlpha ? 'ALPHA' : 'BRAVO'

    // Verifica se é a vez do time do jogador
    if (lobby.currentTurn !== playerTeam) {
      this.sendError(ws, `Não é a vez do seu time. Aguarde o time ${lobby.currentTurn}`)
      return
    }

    // Apenas o líder (primeiro da lista) pode vetar
    const leaderId = playerTeam === 'ALPHA' ? lobby.teams.ALPHA[0]?.oidUser : lobby.teams.BRAVO[0]?.oidUser
    if (leaderId && ws.oidUser !== leaderId) {
      this.sendError(ws, 'Apenas o líder do time pode vetar neste turno')
      return
    }

    // Executa o veto
    const success = await this.lobbyManager.vetoMap(matchId, playerTeam, mapId, 'PLAYER')

    if (!success) {
      this.sendError(ws, 'Erro ao vetar mapa')
      return
    }

    log('debug', `🚫 ${ws.username} (${playerTeam}) vetou ${mapId}`)

    // A atualização será enviada via callback onVetoUpdate
  }

  /**
   * MAP_VOTE - Jogador votou em um mapa (DEPRECATED - usar MAP_VETO)
   */
  private async handleMapVote(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleMapVote - sem mudanças) ...
    if (!ws.oidUser) return

    const { matchId, mapId } = payload

    const success = await this.lobbyManager.voteMap(matchId, ws.oidUser, mapId)
    if (!success) {
      this.sendError(ws, 'Erro ao registrar voto')
      return
    }

    const lobby = this.lobbyManager.getLobby(matchId)
    if (!lobby) return

    // Busca IDs dos jogadores do match
    const playerIds = [...lobby.teams.ALPHA, ...lobby.teams.BRAVO].map(p => p.oidUser)

    // Broadcast atualização de votos para todos na lobby
    this.sendToPlayers(playerIds, {
      type: 'MAP_UPDATE',
      payload: {
        selectedMap: lobby.selectedMap,
        mapVotes: this.lobbyManager.getMapVotes(matchId)
      }
    })

    log('debug', `🗳️ ${ws.username} votou em ${mapId} para match ${matchId}`)
  }

  /**
   * CHAT_SEND - Jogador enviou mensagem no chat
   */
  private async handleChatSend(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleChatSend - sem mudanças) ...
    if (!ws.oidUser || !ws.username) return

    const { matchId, message } = payload

    if (!message || message.trim().length === 0) {
      return
    }

    const chatResult = await this.lobbyManager.addChatMessage(matchId, ws.oidUser, message.trim())
    if (!chatResult) {
      this.sendError(ws, 'Erro ao enviar mensagem')
      return
    }

    const lobby = this.lobbyManager.getLobby(matchId)
    if (!lobby) return

    const targetPlayers =
      chatResult.team === 'ALPHA' ? lobby.teams.ALPHA : lobby.teams.BRAVO
    const playerIds = targetPlayers.map(p => p.oidUser)

    // Broadcast mensagem para todos na lobby
    this.sendToPlayers(playerIds, {
      type: 'CHAT_MESSAGE',
      payload: {
        team: chatResult.team,
        oidUser: chatResult.chatMessage.oidUser,
        username: chatResult.chatMessage.username,
        message: chatResult.chatMessage.message,
        timestamp: chatResult.chatMessage.timestamp
      }
    })
  }

  /**
   * Validação de Token
   */
private async validateAuthToken(params: TokenValidationParams): Promise<TokenValidationResult> {
    // ... (Todo o seu método validateAuthToken - sem mudanças) ...
    const { token, oidUser, discordId } = params

    if (!token) {
      return { valid: false, reason: 'TOKEN_REQUIRED' }
    }

    // *** INÍCIO DA CORREÇÃO PARA TESTES ***
    // Permite que o script test-players.js funcione em modo de desenvolvimento
    if (process.env.NODE_ENV === 'development' && token === 'fake-token') {
      log('warn', `⚠️ AUTENTICAÇÃO DE TESTE (fake-token) APROVADA PARA ${oidUser}`);
      // Usa o discordId do payload ou gera um fallback
      return { valid: true, discordId: discordId || `bot${oidUser}` }; 
    }
    // *** FIM DA CORREÇÃO PARA TESTES ***


    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
    if (secret && this.looksLikeJwt(token)) {
      const jwtResult = this.verifyJwtToken(token, secret)
      if (jwtResult.valid && jwtResult.payload) {
        // ... (resto da sua função original)
        const payloadDiscordId =
          typeof jwtResult.payload.id === 'string'
            ? jwtResult.payload.id
            : typeof jwtResult.payload.sub === 'string'
              ? jwtResult.payload.sub
              : undefined

        if (discordId && payloadDiscordId && discordId !== payloadDiscordId) {
          return { valid: false, reason: 'TOKEN_MISMATCH' }
        }

        const loginTime = typeof jwtResult.payload.loginTime === 'number' ? jwtResult.payload.loginTime : undefined
        const jwtExpSeconds = typeof jwtResult.payload.exp === 'number' ? jwtResult.payload.exp : undefined
        const maxAgeMs = 24 * 60 * 60 * 1000

        if (loginTime && Date.now() - loginTime > maxAgeMs) {
          return { valid: false, reason: 'TOKEN_EXPIRED' }
        }

        if (!loginTime && jwtExpSeconds && Date.now() >= jwtExpSeconds * 1000) {
          return { valid: false, reason: 'TOKEN_EXPIRED' }
        }

        return { valid: true, discordId: discordId || payloadDiscordId }
      }

      if (jwtResult.reason === 'TOKEN_EXPIRED') {
        return { valid: false, reason: 'TOKEN_EXPIRED' }
      }
    }

    return this.validateSessionInDatabase(token, oidUser, discordId)
  }

  private looksLikeJwt(token: string): boolean {
    // ... (Método looksLikeJwt - sem mudanças) ...
    return token.includes('.') && token.split('.').length === 3
  }

  private verifyJwtToken(token: string, secret: string): { valid: boolean; payload?: Record<string, any>; reason?: string } {
    // ... (Método verifyJwtToken - sem mudanças) ...
    try {
      const parts = token.split('.')
      if (parts.length !== 3) {
        return { valid: false, reason: 'INVALID_FORMAT' }
      }

      const [header, payload, signature] = parts
      const signingInput = `${header}.${payload}`
      const expectedSignature = crypto.createHmac('sha256', secret).update(signingInput).digest()
      const providedSignature = Buffer.from(signature, 'base64url')

      if (providedSignature.length !== expectedSignature.length) {
        return { valid: false, reason: 'SIGNATURE_MISMATCH' }
      }

      if (!crypto.timingSafeEqual(providedSignature, expectedSignature)) {
        return { valid: false, reason: 'SIGNATURE_MISMATCH' }
      }

      const payloadJson = this.decodeBase64Url<Record<string, any>>(payload)
      if (!payloadJson) {
        return { valid: false, reason: 'INVALID_PAYLOAD' }
      }

      if (typeof payloadJson.exp === 'number' && Date.now() >= payloadJson.exp * 1000) {
        return { valid: false, reason: 'TOKEN_EXPIRED' }
      }

      return { valid: true, payload: payloadJson }
    } catch (error) {
      log('warn', 'Falha ao verificar JWT', error)
      return { valid: false, reason: 'JWT_ERROR' }
    }
  }

  private decodeBase64Url<T = Record<string, unknown>>(segment: string): T | null {
    // ... (Método decodeBase64Url - sem mudanças) ...
    try {
      const json = Buffer.from(segment, 'base64url').toString('utf-8')
      return JSON.parse(json) as T
    } catch {
      return null
    }
  }

  private async validateSessionInDatabase(token: string, oidUser: number, discordId?: string): Promise<TokenValidationResult> {
    // ... (Método validateSessionInDatabase - sem mudanças) ...
    try {
      const session = await prismaRanked.$queryRaw<{ strDiscordID: string | null }[]>`
        SELECT TOP 1 strDiscordID
        FROM COMBATARMS.dbo.CBT_UserAuth
        WHERE oidUser = ${oidUser}
      `

      if (!session || session.length === 0) {
        return { valid: false, reason: 'USER_NOT_FOUND' }
      }

      const storedDiscordId = session[0].strDiscordID?.trim()
      if (!storedDiscordId) {
        return { valid: false, reason: 'ACCOUNT_NOT_LINKED' }
      }

      const expectedDiscord = (discordId || (!this.looksLikeJwt(token) ? token : undefined))?.trim()
      if (expectedDiscord && storedDiscordId !== expectedDiscord) {
        return { valid: false, reason: 'TOKEN_MISMATCH' }
      }

      return { valid: true, discordId: storedDiscordId }
    } catch (error) {
      log('error', `Erro ao validar sessão para usuário ${oidUser}`, error)
      return { valid: false, reason: 'SESSION_CHECK_FAILED' }
    }
  }

  /**
   * Desconexão do jogador
   */
  private handleDisconnect(ws: AuthenticatedWebSocket): void {
    // ... (Todo o seu método handleDisconnect - sem mudanças) ...
    if (ws.oidUser) {
      log('debug', `🔌 ${ws.username} (${ws.oidUser}) desconectou`)

      if (this.queueManager.isInQueue(ws.oidUser)) {
        this.queueManager.removeFromQueue(ws.oidUser);
        log('debug', `🔄 ${ws.username} removido da fila devido à desconexão.`);
      }

      const matchWithPlayer = this.readyManager.findMatchIdByPlayer(ws.oidUser)
      if (matchWithPlayer) {
        this.readyManager.forceCancel(matchWithPlayer, 'PLAYER_DISCONNECTED', ws.oidUser).catch((error) => {
          log('warn', `Falha ao cancelar ready check ${matchWithPlayer} após desconexão`, error)
        })
      }

      const hostMatchId = this.hostManager.findMatchIdByHost(ws.oidUser)
      if (hostMatchId) {
        this.hostManager.abortByClient(hostMatchId, ws.oidUser, 'PLAYER_DISCONNECTED').catch((error) => {
          log('warn', `Falha ao abortar seleção de HOST ${hostMatchId} após desconexão`, error)
        })
      }

      this.clients.delete(ws.oidUser)
    }
  }

  /**
   * Enviar mensagem para um cliente
   */
  private sendMessage(ws: WebSocket, message: WSMessage): void {
    // ... (Todo o seu método sendMessage - sem mudanças) ...
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }

  /**
   * Enviar erro para um cliente
   */
  private sendError(ws: WebSocket, message: string): void {
    // ... (Todo o seu método sendError - sem mudanças) ...
    this.sendMessage(ws, {
      type: 'ERROR',
      payload: { message }
    })
  }

  /**
   * Broadcast para todos os clientes conectados
   */
  broadcast(message: WSMessage): void {
    // ... (Todo o seu método broadcast - sem mudanças) ...
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        this.sendMessage(client, message)
      }
    })
  }

  /**
   * Enviar mensagem para jogador específico
   */
  sendToPlayer(oidUser: number, message: WSMessage): boolean {
    // ... (Todo o seu método sendToPlayer - sem mudanças) ...
    const client = this.clients.get(oidUser)
    if (client && client.readyState === WebSocket.OPEN) {
      this.sendMessage(client, message)
      return true
    }
    return false
  }

  /**
   * Enviar para múltiplos jogadores
   */
  sendToPlayers(oidUsers: number[], message: WSMessage): void {
    // ... (Todo o seu método sendToPlayers - sem mudanças) ...
    oidUsers.forEach(oidUser => {
      this.sendToPlayer(oidUser, message)
    })
  }

  /**
   * Obter estatísticas
   */
  getStats(): { connectedPlayers: number, totalConnections: number } {
    // ... (Todo o seu método getStats - sem mudanças) ...
    return {
      connectedPlayers: this.clients.size,
      totalConnections: this.wss.clients.size
    }
  }

/**
   * Encerrar servidor (graceful shutdown)
   */
  async shutdown(): Promise<void> {
    log('debug', '🛑 Encerrando Ranked WebSocket Server...')

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = undefined
    }

    // Para managers (limpa timers e intervals)
    this.queueManager.stop()
    this.validationManager.stop()
    this.hostManager.clearAllAttempts()
    this.readyManager.clearAllChecks()
    this.lobbyManager.stop()

    // Notifica clientes antes de desconectar
    this.broadcast({
      type: 'SERVER_SHUTDOWN',
      payload: { message: 'Servidor sendo desligado' }
    })

    // Fecha todas as conexões WebSocket
    this.wss.clients.forEach((client) => {
      client.close(1000, 'Server shutdown')
    })
    this.wss.close()

    // --- AJUSTE ADICIONADO AQUI ---
    // Fecha o servidor HTTP e SÓ ENTÃO desliga o banco
    this.httpServer.close(async () => {
      log('debug', '🔌 Servidor HTTP encerrado.');
      
      // Desconecta banco de dados e Redis
      const { disconnectAll } = await import('./database/disconnect')
      await disconnectAll() //

      log('debug', '✅ Servidor encerrado com sucesso')
    });
  }
}


// Inicia servidor se executado diretamente
if (require.main === module) {
  // <-- Bloco 'if' inteiramente modificado
  const PORT = process.env.PORT || 3001;
  
  log('debug', '🔧 Iniciando CBT WebSocket Server...');
  log('debug', `📋 Configurações:`);
  log('debug', `   • Porta: ${PORT}`);
  log('debug', `   • Ambiente: ${process.env.NODE_ENV || 'development'}`);
  log('debug', `   • Database: ${process.env.DATABASE_URL ? 'Configurado' : 'NÃO CONFIGURADO'}`);
  log('debug', `   • Redis: ${process.env.REDIS_URL ? 'Configurado' : 'NÃO CONFIGURADO'}`);
  log('debug', `   • Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  
  // 1. Cria a instância do servidor (que agora cria o app/http/wss no construtor)
  const serverInstance = new RankedWebSocketServer();
  
  // 2. Inicia o servidor HTTP para escutar na porta
  serverInstance.listen(PORT);

  log('debug', `✅ Servidor iniciado com sucesso!`);
  log('debug', `🌐 WebSocket disponível em: ws://localhost:${PORT}`);
  log('debug', `🔗 HTTP API disponível em: http://localhost:${PORT}`);
  log('debug', `📊 Health check: http://localhost:${PORT}/health`);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    log('debug', '🛑 Encerrando (SIGTERM)...');
    await serverInstance.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    log('debug', '🛑 Encerrando (SIGINT)...');
    await serverInstance.shutdown();
    process.exit(0);
  });

  // Log stats a cada 30 segundos (nível DEBUG para evitar poluição de logs)
  setInterval(() => {
    const stats = serverInstance.getStats();
    log('debug', `📊 Stats: ${stats.connectedPlayers} jogadores conectados`);
  }, 30000);
}
