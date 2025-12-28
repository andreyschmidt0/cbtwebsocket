import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';         // <-- ADICIONADO
import { createServer, Server as HttpServer } from 'http';   // <-- ADICIONADO
import cors from 'cors';             // <-- ADICIONADO
import { QueueManager } from './managers/queue-manager';
import { ReadyManager } from './managers/ready-manager';
import { HOSTManager } from './managers/host-manager';
import { ValidationManager } from './managers/validation-manager';
import { LobbyManager } from './managers/lobby-manager';
import { FriendManager } from './managers/friend-manager';
import { PartyManager } from './managers/party-manager';
import { QuartetManager } from './managers/quartet-manager';
import { QueuePlayer, ReadyPlayer } from './types';
import { DiscordService } from './services/discord-service';
import { prismaRanked, prismaGame } from './database/prisma';
import { log } from './utils/logger';
import { getRedisClient } from './database/redis-client';
import crypto from 'crypto';
import { computeMatchmakingValue, formatTierLabel, getTierIndex, RankTier } from './rank/rank-tiers';

// ... (Interfaces: AuthenticatedWebSocket, WSMessage, etc. - Sem mudanças) ...
interface AuthenticatedWebSocket extends WebSocket {
  oidUser?: number;
  username?: string;
  discordId?: string;
  isAlive?: boolean;
  inviteFrom?: string | null;
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

// Erros de domínio para mapear UX/ações
const DOMAIN_ERRORS = {
  QUEUE_FAILED: {
    default: 'Não foi possível entrar na fila.',
  },
  LOBBY_MISSING: {
    default: 'Match indisponível, retornando à fila.'
  },
  READY_MISSING: {
    default: 'Match indisponível, retornando à fila.'
  },
  HOST_TIMEOUT: {
    default: 'Host não confirmou a sala a tempo.'
  },
  HOST_FAILED: {
    default: 'Falha ao criar sala.'
  },
  VALIDATION_TIMEOUT: {
    default: 'Partida não validada – sem perda de pontos.'
  },
  VALIDATION_INVALID: {
    default: 'Partida cancelada – abandonos podem ser penalizados.'
  },
  AUTH_INVALID: {
    default: 'Reautentique-se para continuar.'
  },
  LOBBY_UNAUTHORIZED: {
    default: 'Você não está autorizado a entrar nesta lobby.'
  }
} as const;


/**
 * Servidor WebSocket para Ranked Matchmaking
 * Gerencia conexões e mensagens dos jogadores
 */
export class RankedWebSocketServer {
  private redis = getRedisClient();
  private wss: WebSocketServer;
  private clients: Map<number, AuthenticatedWebSocket> = new Map();
  private heartbeatInterval?: NodeJS.Timeout;
  private discordService: DiscordService;

  // Managers
  private queueManager: QueueManager;
  private readyManager: ReadyManager;
  private hostManager: HOSTManager;
  private validationManager: ValidationManager;
  private lobbyManager: LobbyManager;
  private friendManager: FriendManager;
  private partyManager: PartyManager;
  private quartetManager: QuartetManager;

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
    // Rota rápida para verificar lobby ativa de um jogador
    this.app.get('/active-lobby/:oidUser', async (req, res) => {
      const oidUser = Number(req.params.oidUser);
      if (!oidUser) {
        return res.status(400).json({ error: 'oidUser inválido' });
      }
      try {
        const key = `player:${oidUser}:activeLobby`;
        const matchId = await this.redis.get(key);
        if (!matchId) {
          return res.status(404).json({ error: 'Nenhuma lobby ativa' });
        }
        const lobby = this.lobbyManager.getLobby(matchId);
        if (!lobby) {
          await this.redis.del(key);
          return res.status(404).json({ error: 'Lobby expirada' });
        }
        return res.status(200).json({ matchId, redirectTo: `/lobby/${matchId}` });
      } catch (err) {
        log('error', 'Falha ao checar lobby ativa', err);
        return res.status(500).json({ error: 'Erro ao checar lobby ativa' });
      }
    });
    
    // 4. Anexar o WebSocketServer ao Servidor HTTP
    this.wss = new WebSocketServer({ server: this.httpServer });

    // 5. Inicializar todos os managers
    this.discordService = new DiscordService({
      botToken: process.env.DISCORD_BOT_TOKEN,
      guildId: process.env.DISCORD_GUILD_ID,
      teamCategoryId: process.env.DISCORD_TEAM_CATEGORY_ID,
      generalChannelId: process.env.DISCORD_GENERAL_CHANNEL_ID
    });
    this.queueManager = new QueueManager();
    this.readyManager = new ReadyManager();
    this.hostManager = new HOSTManager(this.discordService);
    this.lobbyManager = new LobbyManager();
    this.friendManager = new FriendManager();
    this.partyManager = new PartyManager();
    this.quartetManager = new QuartetManager();
    this.validationManager = new ValidationManager({
      onMatchCompleted: async (matchId, result) => {
        log('debug', `✅ Match ${matchId} validado! Vencedor: ${result.winner}`);

        try {
          await this.discordService.deleteChannelsByMatchId(matchId)
        } catch (err) {
          log('warn', `Falha ao remover canais do Discord para ${matchId}`, err)
        }

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
            ISNULL(rs.rankTier, 'BRONZE_3') as rankTier,
            ISNULL(rs.rankPoints, 0) as rankPoints,
            ISNULL(rs.eloRating, 0) as matchmakingRating,
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

        // Mantém a party viva para permitir requeue em grupo após o match
        await this.keepPartyAliveForPlayers(recipientIds);

        const abandonmentSet = new Set(result.abandonments);
        const playerSummaries = matchPlayers.map(player => {
            const kills = Number(player.kills) || 0;
            const deaths = Number(player.deaths) || 0;
            const assists = Number(player.assists) || 0;
            const headshots = Number(player.headshots) || 0;
            const mmrChange = Number(player.mmrChange) || 0;
            const storedTier = (player.rankTier as RankTier) || 'BRONZE_3';
            const storedPoints = Number(player.rankPoints ?? 0);
            const storedMatchValue = Number(player.matchmakingRating ?? 0);
            const currentMatchValue = storedMatchValue > 0
              ? storedMatchValue
              : computeMatchmakingValue(storedTier, storedPoints);
            const oldMatchValue = currentMatchValue - mmrChange;
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
                old: oldMatchValue,
                new: currentMatchValue,
                change: mmrChange
              },
              rank: {
                tier: storedTier,
                tierLabel: formatTierLabel(storedTier),
                points: storedPoints
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

        // Limpa lobby e chaves player:{oid}:activeLobby ap�s a partida encerrar
        try {
          await this.lobbyManager.removeLobby(matchId);
        } catch (err) {
          log('warn', `Falha ao limpar lobby ${matchId} ap�s MATCH_ENDED`, err);
        }
      },
      onMatchTimeout: async (matchId) => {
        log('warn', `? Match ${matchId} timeout - sem logs suficientes`);

        try {
          await this.discordService.deleteChannelsByMatchId(matchId)
        } catch (err) {
          log('warn', `Falha ao remover canais do Discord para ${matchId}`, err)
        }

        // ... (l¢gica de onMatchTimeout - sem mudan‡as) ...
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
              message: DOMAIN_ERRORS.VALIDATION_TIMEOUT.default
            }
          }
        );
      },

      onMatchInvalid: async (matchId, reason) => {
        log('warn', `❌ Match ${matchId} inválido: ${reason}`);

        try {
          await this.discordService.deleteChannelsByMatchId(matchId)
        } catch (err) {
          log('warn', `Falha ao remover canais do Discord para ${matchId}`, err)
        }

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
              message: DOMAIN_ERRORS.VALIDATION_INVALID.default
            }
          }
        );
      }
    });

    // 6. Configurar Callbacks
    this.setupManagerCallbacks();

    // Callback para quando o HOSTManager aborta a sala (timeout ou falha do host)
    this.hostManager.onHostAborted(async (matchId, hostOidUser, reason, playerIds = []) => {
      log('warn', `HOST abortado para match ${matchId} (hostOidUser=${hostOidUser}, reason=${reason})`);

      const snapshotByPlayer = await this.getQueueSnapshotByPlayer(matchId);

      // Remove o host da fila (ele não deve voltar automaticamente)
      await this.queueManager.removeFromQueue(hostOidUser);
      this.sendToPlayer(hostOidUser, {
        type: 'HOST_FAILED',
        payload: { reason }
      });

      const hostTimeout = reason === 'TIMEOUT';
      const message = hostTimeout
        ? 'O host não confirmou a sala no tempo. Voltamos para a fila.'
        : 'O host não criou a sala. Você voltou para a fila.';

      // Persiste prioridade para cada jogador e notifica retorno à fila
      for (const oid of playerIds) {
        if (oid === hostOidUser) continue;

        const snapshotEntry = snapshotByPlayer[oid];
        const queuedAtFallback = snapshotEntry?.queuedAt || Date.now();
        const classesFallback = snapshotEntry?.classes || null;

        try {
          await this.redis.set(
            `requeue:ranked:${oid}`,
            JSON.stringify({
              queuedAt: queuedAtFallback,
              classes: classesFallback
            }),
            { EX: 600 }
          );
        } catch (err) {
          log('warn', `Falha ao preparar dados de requeue para player ${oid}`, err);
        }

        this.sendToPlayer(oid, {
          type: 'REQUEUE',
          payload: {
            message,
            reason,
            queuedAt: queuedAtFallback
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
            timeout: 20 // 20 segundos para aceitar (documentação)
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

        // Separa times usando os nomes reais (anonimização será feita ao enviar ao cliente)
        const teams = {
          ALPHA: teamsData.ALPHA.map((p: any) => ({
            oidUser: p.oidUser,
            username: p.username,
            mmr: Number(p.mmr) || 1000
          })),
          BRAVO: teamsData.BRAVO.map((p: any) => ({
            oidUser: p.oidUser,
            username: p.username,
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
        const queuedAtFallback = snapshotEntry?.queuedAt || Date.now();
        const classesFallback = snapshotEntry?.classes || null;
        
        // Salva os dados de prioridade no Redis para o próximo QUEUE_JOIN
        try {
          await this.redis.set(
            `requeue:ranked:${oid}`,
            JSON.stringify({
              queuedAt: queuedAtFallback,
              classes: classesFallback
            }),
            { EX: 600 } // 10 minutos para reconectar e entrar na fila
          );
        } catch (err) {
          log('warn', `Falha ao preparar dados de requeue para player ${oid}`, err);
        }

        // Notifica o cliente para voltar à fila
        this.sendToPlayer(oid, {
          type: 'REQUEUE',
          payload: {
            message: 'Um jogador recusou a partida. Você foi colocado de volta na fila.',
            reason,
            // Envia o tempo de fila original para o cliente recalcular o timer
            queuedAt: queuedAtFallback
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
          discordId: client?.discordId,
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
      await this.hostManager.startHostSelection(matchId, hostPlayers as any, mapNumber, mapId);
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

        case 'HEARTBEAT':
          // Mantém a conexão viva e evita erro de tipo inválido
          ;(ws as AuthenticatedWebSocket).isAlive = true
          this.sendMessage(ws, { type: 'PONG' })
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
        case 'REQUEST_DISCORD_MOVE':
          await this.handleDiscordMoveRequest(ws, payload);
          break;

        case 'FRIEND_SEND':
          await this.handleFriendSend(ws, payload);
          break;
        case 'FRIEND_ACCEPT':
          await this.handleFriendAccept(ws, payload);
          break;
        case 'FRIEND_REJECT':
          await this.handleFriendReject(ws, payload);
          break;
        case 'FRIEND_REMOVE':
          await this.handleFriendRemove(ws, payload);
          break;
        case 'FRIEND_LIST':
          await this.handleFriendList(ws);
          break;
        case 'FRIEND_PENDING':
          await this.handleFriendPending(ws);
          break;

        case 'QUARTET_INVITE_SEND':
          await this.handleQuartetInviteSend(ws, payload);
          break;
        case 'QUARTET_INVITE_ACCEPT':
          await this.handleQuartetInviteAccept(ws, payload);
          break;
        case 'QUARTET_INVITE_REJECT':
          await this.handleQuartetInviteReject(ws, payload);
          break;
        case 'QUARTET_INVITE_REMOVE':
          await this.handleQuartetInviteRemove(ws, payload);
          break;
        case 'QUARTET_LIST_ACCEPTED':
          await this.handleQuartetListAccepted(ws);
          break;
        case 'QUARTET_LIST_PENDING':
          await this.handleQuartetListPending(ws);
          break;

        case 'PARTY_CREATE':
          await this.handlePartyCreate(ws);
          break;
        case 'PARTY_INVITE':
          await this.handlePartyInvite(ws, payload);
          break;
        case 'PARTY_ACCEPT_INVITE':
          await this.handlePartyAcceptInvite(ws, payload);
          break;
        case 'PARTY_DECLINE_INVITE':
          await this.handlePartyDeclineInvite(ws, payload);
          break;
        case 'PARTY_LEAVE':
          await this.handlePartyLeave(ws);
          break;
        case 'PARTY_KICK':
          await this.handlePartyKick(ws, payload);
          break;
        case 'PARTY_TRANSFER_LEAD':
          await this.handlePartyTransferLead(ws, payload);
          break;

        case 'LOBBY_ABANDON':
          await this.handleLobbyAbandon(ws, payload);
          break;

        default:
          log('warn', `⚠️ Mensagem desconhecida: ${message.type}`)
          this.sendError(ws, 'Tipo de mensagem inválido')
      }
    } catch (error) {
      log('error', '❌ Erro ao processar mensagem', error)
      this.sendMessage(ws, {
        type: 'ERROR',
        payload: {
          reason: 'SERVICE_UNAVAILABLE',
          message: 'Servidor indisponível. Tente novamente em instantes.'
        }
      })
    }
  }

  /**
   * AUTH - Autenticação do jogador
   */
  private async handleAuth(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    // ... (Todo o seu método handleAuth - sem mudanças) ...
    const { oidUser, token, username, discordId } = payload

    // Debug: log origem e dados do AUTH recebido
    const incomingSocket: any = (ws as any)._socket;
    log(
      'debug',
      `[AUTH] received oidUser=${oidUser} discordId=${discordId ?? 'n/a'} remote=${incomingSocket?.remoteAddress ?? 'unknown'}:${incomingSocket?.remotePort ?? 'n/a'}`
    )

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
      const existingSocket: any = (existingConnection as any)._socket;
      log('warn', `[AUTH] Duplicate connection for oidUser=${oidUser} existingRemote=${existingSocket?.remoteAddress ?? 'unknown'}:${existingSocket?.remotePort ?? 'n/a'} existingState=${existingConnection.readyState} newRemote=${incomingSocket?.remoteAddress ?? 'unknown'}:${incomingSocket?.remotePort ?? 'n/a'}`)
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
          message: DOMAIN_ERRORS.AUTH_INVALID.default
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
    log('debug', `[AUTH] Registered client oidUser=${oidUser}. Connected count=${this.clients.size}`)

    log('debug', `✅ ${ws.username} (${oidUser}) autenticado${normalizedDiscordId ? ` [Discord: ${normalizedDiscordId}]` : ''}`)

    this.sendMessage(ws, {
      type: 'AUTH_SUCCESS',
      payload: { oidUser, username: ws.username }
    })

    // Reenvia estado de party (suporte a F5)
    try {
      const partyId = await this.partyManager.getPartyIdByPlayer(oidUser);
      if (partyId) {
        const party = await this.partyManager.getParty(partyId);
        if (party) {
          this.sendMessage(ws, { type: 'PARTY_UPDATED', payload: { party } });
        }
      }
    } catch (err) {
      log('warn', `Falha ao reemitir PARTY_UPDATED para ${oidUser}`, err);
    }

    // Se o jogador tinha uma lobby ativa, reenvia os dados completos (suporte a F5)
    try {
      const activeLobbyId = await this.redis.get(`player:${oidUser}:activeLobby`);
      if (activeLobbyId) {
        log('debug', `[AUTH] Reenviando LOBBY_DATA para ${oidUser} (lobby ${activeLobbyId})`);
        await this.handleLobbyJoin(ws, { matchId: activeLobbyId });
      }
      // Mantém a party viva (renova TTL) se existir
      const partyId = await this.partyManager.getPartyIdByPlayer(oidUser);
      if (partyId) {
        await this.partyManager.refreshPartyTtl(partyId);
      }
    } catch (err) {
      log('warn', `Falha ao reemitir LOBBY_DATA pós-AUTH para ${oidUser}`, err);
    }
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

      let playerRankTier: RankTier = 'BRONZE_3'
      let playerRankPoints = 0
      let playerMMR = 0
      try {
        const [mmrRow] = await prismaRanked.$queryRaw<{ rankTier: string | null; rankPoints: number | null; eloRating: number | null }[]>`
          SELECT 
            ISNULL(rankTier, 'BRONZE_3') as rankTier,
            ISNULL(rankPoints, 0) as rankPoints,
            ISNULL(eloRating, 0) as eloRating
          FROM BST_RankedUserStats
          WHERE oidUser = ${ws.oidUser}
        `
        if (mmrRow) {
          playerRankTier = (mmrRow.rankTier as RankTier) || 'BRONZE_3'
          playerRankPoints = Number(mmrRow.rankPoints ?? 0)
          const storedRating = Number(mmrRow.eloRating ?? 0)
          playerMMR = storedRating > 0
            ? storedRating
            : computeMatchmakingValue(playerRankTier, playerRankPoints)
        } else {
          playerMMR = computeMatchmakingValue(playerRankTier, playerRankPoints)
        }
      } catch (mmrError) {
        log('warn', `Falha ao buscar rank para ${ws.oidUser}, usando valores padr��o`, mmrError)
        playerMMR = computeMatchmakingValue(playerRankTier, playerRankPoints)
      }
      if (!playerMMR) {
        playerMMR = computeMatchmakingValue(playerRankTier, playerRankPoints)
      }

      let partyId: string | null = null
      let partyMembers: number[] | undefined = undefined
      try {
        const partyFromIndex = await this.partyManager.getPartyIdByPlayer(ws.oidUser)
        if (partyFromIndex) {
          const party = await this.partyManager.getParty(partyFromIndex)
          if (party && party.members.includes(ws.oidUser)) {
            partyId = party.id
            partyMembers = party.members
          }
        }
      } catch (err) {
        log('warn', `Falha ao recuperar party para ${ws.oidUser}`, err)
      }

      const memberIds = partyMembers && partyMembers.length > 0 ? partyMembers : [ws.oidUser];
      const queuedAtShared = queuedAtOverride || Date.now();

      // Valida party (tier/cooldown/fila) antes de adicionar
      if (partyId && memberIds.length > 1) {
        const partyCheck = await this.checkPartyEligibility(memberIds, partyId)
        if (!partyCheck.ok) {
          return this.sendMessage(ws, {
            type: 'QUEUE_FAILED',
            payload: {
              reason: partyCheck.reason,
              endsAt: partyCheck.endsAt,
              offender: partyCheck.offender
            }
          })
        }
      }

      // Helper para obter stats de um jogador (mmr/tier/points)
      const fetchPlayerStats = async (oid: number) => {
        let rankTier: RankTier = 'BRONZE_3';
        let rankPoints = 0;
        let mmr = 0;
        try {
          const [row] = await prismaRanked.$queryRaw<{ rankTier: string | null; rankPoints: number | null; eloRating: number | null }[]>`
            SELECT 
              ISNULL(rankTier, 'BRONZE_3') as rankTier,
              ISNULL(rankPoints, 0) as rankPoints,
              ISNULL(eloRating, 0) as eloRating
            FROM BST_RankedUserStats
            WHERE oidUser = ${oid}
          `;
          if (row) {
            rankTier = (row.rankTier as RankTier) || 'BRONZE_3';
            rankPoints = Number(row.rankPoints ?? 0);
            const storedRating = Number(row.eloRating ?? 0);
            mmr = storedRating > 0
              ? storedRating
              : computeMatchmakingValue(rankTier, rankPoints);
          } else {
            mmr = computeMatchmakingValue(rankTier, rankPoints);
          }
        } catch (mmrError) {
          log('warn', `Falha ao buscar MMR para ${oid}`, mmrError);
          mmr = computeMatchmakingValue(rankTier, rankPoints);
        }
        return { rankTier, rankPoints, mmr };
      };

      const addedMembers: number[] = [];

      for (const memberId of memberIds) {
        const { rankTier, rankPoints, mmr } = memberId === ws.oidUser
          ? { rankTier: playerRankTier, rankPoints: playerRankPoints, mmr: playerMMR }
          : await fetchPlayerStats(memberId);

        const username = memberId === ws.oidUser
          ? (ws.username || `Player${memberId}`)
          : await this.getUsername(memberId);

        const memberData: QueuePlayer = {
          oidUser: memberId,
          username,
          mmr,
          rankTier,
          rankPoints,
          discordId: memberId === ws.oidUser ? ws.discordId : undefined,
          classes: memberId === ws.oidUser ? (classesOverride || { primary: 'T3', secondary: 'SMG' }) : { primary: 'T3', secondary: 'SMG' },
          queuedAt: queuedAtShared,
          joinedAt: Date.now(),
          partyId,
          partyMembers: memberIds,
        };

        const validation = await this.queueManager.addToQueue(memberData);
        if (!validation.valid) {
          for (const added of addedMembers) {
            await this.queueManager.removeFromQueue(added).catch(() => {});
          }
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
        addedMembers.push(memberId);
      }

      if (requeueKey) {
        await this.redis.del(requeueKey).catch(() => { })
      }

      log('debug', `✅ ${ws.username} entrou na fila`)

      const queueSize = this.queueManager.getQueueSize()

      // Notifica todos da party (ou só o próprio) que entraram na fila
      for (const memberId of memberIds) {
        const client = memberId === ws.oidUser ? ws : this.clients.get(memberId);
        if (client && client.readyState === WebSocket.OPEN) {
          this.sendMessage(client, {
            type: 'QUEUE_JOINED',
            payload: {
              queueSize,
              estimatedWait: queueSize * 6, // ~6 segundos por jogador
              queuedAt: queuedAtShared
            }
          });
        }
      }

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
    if (!ws.oidUser) return

    let memberIds: number[] = [ws.oidUser]
    try {
      const partyId = await this.partyManager.getPartyIdByPlayer(ws.oidUser)
      if (partyId) {
        const party = await this.partyManager.getParty(partyId)
        if (party?.members?.length) {
          memberIds = party.members
        }
      }
    } catch {}

    for (const memberId of memberIds) {
      await this.queueManager.removeFromQueue(memberId)
      const client = memberId === ws.oidUser ? ws : this.clients.get(memberId)
      if (client && client.readyState === WebSocket.OPEN) {
        this.sendMessage(client, {
          type: 'QUEUE_LEFT',
          payload: {}
        })
      }
    }

    log('debug', `❌ ${ws.username} (party ${memberIds.join(',')}) saiu da fila`)
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

    // Se o ready expirou/sumiu, requeue automático
    if (!this.readyManager.getActiveCheck(String(matchId)) && !this.lobbyManager.getLobby(String(matchId))) {
      await this.handleLobbyOrReadyExpired(String(matchId), 'READY_MISSING', ws.oidUser ? [ws.oidUser] : [])
      return
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
    if (!ws.oidUser) return;
    const {
      matchId,
      targetOidUser,
      requestingOidUser,
      requestingTeam,
      tier
    } = payload || {};
    if (!matchId || !targetOidUser) return;

    const lobby = this.lobbyManager.getLobby(matchId);
    if (!lobby) return;

    const requesterId = requestingOidUser || ws.oidUser;
    const targetTeam = lobby.teams.ALPHA.some(p => p.oidUser === targetOidUser)
      ? 'ALPHA'
      : lobby.teams.BRAVO.some(p => p.oidUser === targetOidUser)
        ? 'BRAVO'
        : null;
    const derivedRequesterTeam = requestingTeam
      || (lobby.teams.ALPHA.some(p => p.oidUser === requesterId)
        ? 'ALPHA'
        : lobby.teams.BRAVO.some(p => p.oidUser === requesterId)
          ? 'BRAVO'
          : null);

    if (targetTeam && derivedRequesterTeam && targetTeam !== derivedRequesterTeam) {
      this.sendError(ws, 'Troca invalida: jogadores precisam estar no mesmo time.');
      return;
    }

    let tierLabel: string | undefined = tier;
    if (!tierLabel) {
      try {
        const rawClass = await this.redis.hGet(`match:${matchId}:classes`, String(requesterId));
        if (rawClass) {
          const parsed = JSON.parse(rawClass);
          tierLabel = parsed?.assignedRole || parsed?.primary || parsed?.secondary;
        }
      } catch (error) {
        log('warn', `Falha ao obter classe do jogador ${requesterId} para swap`, error);
      }
    }

    const requesterName =
      ws.username
      || [...lobby.teams.ALPHA, ...lobby.teams.BRAVO].find(p => p.oidUser === requesterId)?.username
      || `Player ${requesterId}`;

    this.sendToPlayer(targetOidUser, {
      type: 'LOBBY_SWAP_REQUESTED',
      payload: {
        matchId,
        requestingOidUser: requesterId,
        requestingUsername: requesterName,
        tier: tierLabel,
        team: derivedRequesterTeam || targetTeam
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

    // NOVO: Notifica todos os jogadores sobre a troca completada (para limpar animações)
    for (const oid of allPlayerIds) {
      this.sendToPlayer(oid, {
        type: 'LOBBY_SWAP_COMPLETED',
        payload: {
          matchId,
          swappedPlayers: [accepterOidUser, requestingOidUser]
        }
      });
    }

    // Re-sincroniza o estado da lobby para todos
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

    // Se o ready expirou/sumiu, requeue automático
    if (!this.readyManager.getActiveCheck(String(matchId)) && !this.lobbyManager.getLobby(String(matchId))) {
      await this.handleLobbyOrReadyExpired(String(matchId), 'READY_MISSING', ws.oidUser ? [ws.oidUser] : [])
      return
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

      // Escalonamento diario: 2a recusa = 5min, 3a = 15min, 4a = 30min, 5+ = 60min
      let seconds = 0
      if (count === 2) seconds = 5 * 60
      else if (count === 3) seconds = 15 * 60
      else if (count === 4) seconds = 30 * 60
      else if (count >= 5) seconds = 60 * 60

      if (seconds > 0) {
        const endsAt = Date.now() + seconds * 1000
        await this.redis.set(`cooldown:${ws.oidUser}`, String(endsAt), { EX: seconds })

        // Notifica cliente para bloquear botao localmente
        this.sendMessage(ws, {
          type: 'COOLDOWN_SET',
          payload: { reason: 'DECLINED_READY', seconds, endsAt, count }
        })
      }
    } catch (e) {
      log('warn', 'Falha ao aplicar cooldown de decline', e)
    }
  }

  /**
   * FRIEND_SEND - Envia solicitação de amizade
   */
  private async handleFriendSend(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    // AdiÇ½o de amigos agora Ç¸ feita apenas via NickName (sem enviar oid direto)
    const targetOidUser = await this.resolveTargetUserIdByNickname(payload);
    if (!targetOidUser) {
      return this.sendError(ws, 'TARGET_REQUIRED');
    }
    const result = await this.friendManager.sendRequest(ws.oidUser, targetOidUser);
    if (!result.ok) {
      return this.sendMessage(ws, { type: 'FRIEND_ERROR', payload: { reason: result.reason } });
    }

    this.sendMessage(ws, { type: 'FRIEND_REQUEST_SENT', payload: { targetOidUser } });

    const targetClient = this.clients.get(targetOidUser);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
      const requesterName = ws.username || (await this.getUsername(ws.oidUser));
      this.sendMessage(targetClient, {
        type: 'FRIEND_REQUEST',
        payload: { requesterOidUser: ws.oidUser, requesterName }
      });
    }
  }

  private async handleFriendAccept(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const requesterOidUser = Number(payload?.requesterOidUser);
    if (!requesterOidUser) {
      return this.sendError(ws, 'REQUESTER_REQUIRED');
    }
    const result = await this.friendManager.accept(requesterOidUser, ws.oidUser);
    if (!result.ok) {
      return this.sendMessage(ws, { type: 'FRIEND_ERROR', payload: { reason: result.reason } });
    }

    const selfName = ws.username || (await this.getUsername(ws.oidUser));
    const requesterName = await this.getUsername(requesterOidUser);

    this.sendMessage(ws, {
      type: 'FRIEND_ACCEPTED',
      payload: { oidUser: requesterOidUser, username: requesterName }
    });

    const requesterClient = this.clients.get(requesterOidUser);
    if (requesterClient && requesterClient.readyState === WebSocket.OPEN) {
      this.sendMessage(requesterClient, {
        type: 'FRIEND_ACCEPTED',
        payload: { oidUser: ws.oidUser, username: selfName }
      });
    }
  }

  private async handleFriendReject(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const requesterOidUser = Number(payload?.requesterOidUser);
    if (!requesterOidUser) {
      return this.sendError(ws, 'REQUESTER_REQUIRED');
    }
    const result = await this.friendManager.reject(requesterOidUser, ws.oidUser);
    if (!result.ok) {
      return this.sendMessage(ws, { type: 'FRIEND_ERROR', payload: { reason: result.reason } });
    }
    this.sendMessage(ws, { type: 'FRIEND_REJECTED', payload: { requesterOidUser } });
  }

  private async handleFriendRemove(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const targetOidUser = await this.resolveTargetUserId(payload);
    if (!targetOidUser) {
      return this.sendError(ws, 'TARGET_REQUIRED');
    }
    const result = await this.friendManager.remove(ws.oidUser, targetOidUser);
    if (!result.ok) {
      return this.sendMessage(ws, { type: 'FRIEND_ERROR', payload: { reason: result.reason } });
    }
    this.sendMessage(ws, { type: 'FRIEND_REMOVED', payload: { oidUser: targetOidUser } });
    const targetClient = this.clients.get(targetOidUser);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
      this.sendMessage(targetClient, { type: 'FRIEND_REMOVED', payload: { oidUser: ws.oidUser } });
    }
  }

  private async handleFriendList(ws: AuthenticatedWebSocket): Promise<void> {
    if (!ws.oidUser) {
      return this.sendMessage(ws, {
        type: 'FRIEND_ERROR',
        payload: { reason: 'NOT_AUTHENTICATED' }
      });
    }
    try {
      const friends = await this.friendManager.listFriends(ws.oidUser);
      this.sendMessage(ws, { type: 'FRIEND_LIST', payload: { friends } });
    } catch (err) {
      const reason = (err as Error).message === 'DATABASE_TIMEOUT' ? 'DATABASE_TIMEOUT' : 'INTERNAL_ERROR';
      this.sendMessage(ws, { type: 'FRIEND_ERROR', payload: { reason } });
    }
  }

  private async handleFriendPending(ws: AuthenticatedWebSocket): Promise<void> {
    if (!ws.oidUser) {
      return this.sendMessage(ws, {
        type: 'FRIEND_ERROR',
        payload: { reason: 'NOT_AUTHENTICATED' }
      });
    }
    try {
      const pending = await this.friendManager.listPending(ws.oidUser);
      this.sendMessage(ws, { type: 'FRIEND_PENDING', payload: { pending } });
    } catch (err) {
      const reason = (err as Error).message === 'DATABASE_TIMEOUT' ? 'DATABASE_TIMEOUT' : 'INTERNAL_ERROR';
      this.sendMessage(ws, { type: 'FRIEND_ERROR', payload: { reason } });
    }
  }

  /**
   * QUARTET HANDLERS - Gerenciamento de convites de quarteto
   */
  private async handleQuartetInviteSend(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const targetOidUser = await this.resolveTargetUserIdByNickname(payload);
    if (!targetOidUser) {
      return this.sendError(ws, 'TARGET_REQUIRED');
    }

    const rawTargetPos = Number(payload?.targetPos);

    // Validação: targetPos é OBRIGATÓRIO e deve ser 1, 2 ou 3
    if (rawTargetPos !== 1 && rawTargetPos !== 2 && rawTargetPos !== 3) {
      return this.sendMessage(ws, {
        type: 'QUARTET_ERROR',
        payload: { reason: 'INVALID_POSITION' }
      });
    }

    const targetPos = rawTargetPos as 1 | 2 | 3;

    const result = await this.quartetManager.sendInvite(ws.oidUser, targetOidUser, targetPos);
    if (!result.ok) {
      return this.sendMessage(ws, { type: 'QUARTET_ERROR', payload: { reason: result.reason } });
    }

    this.sendMessage(ws, { type: 'QUARTET_INVITE_SENT', payload: { targetOidUser, targetPos } });

    const targetClient = this.clients.get(targetOidUser);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
      const requesterName = ws.username || (await this.getUsername(ws.oidUser));
      this.sendMessage(targetClient, {
        type: 'QUARTET_INVITE_REQUEST',
        payload: { requesterOidUser: ws.oidUser, requesterName, targetPos }
      });
    }
  }

  private async handleQuartetInviteAccept(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const requesterOidUser = Number(payload?.requesterOidUser);
    if (!requesterOidUser) {
      return this.sendError(ws, 'REQUESTER_REQUIRED');
    }
    const result = await this.quartetManager.acceptInvite(requesterOidUser, ws.oidUser);
    if (!result.ok) {
      return this.sendMessage(ws, { type: 'QUARTET_ERROR', payload: { reason: result.reason } });
    }

    const selfName = ws.username || (await this.getUsername(ws.oidUser));
    const requesterName = await this.getUsername(requesterOidUser);

    this.sendMessage(ws, {
      type: 'QUARTET_INVITE_ACCEPTED',
      payload: { oidUser: requesterOidUser, username: requesterName }
    });

    const requesterClient = this.clients.get(requesterOidUser);
    if (requesterClient && requesterClient.readyState === WebSocket.OPEN) {
      this.sendMessage(requesterClient, {
        type: 'QUARTET_INVITE_ACCEPTED',
        payload: { oidUser: ws.oidUser, username: selfName }
      });
    }
  }

  private async handleQuartetInviteReject(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const requesterOidUser = Number(payload?.requesterOidUser);
    if (!requesterOidUser) {
      return this.sendError(ws, 'REQUESTER_REQUIRED');
    }
    const result = await this.quartetManager.rejectInvite(requesterOidUser, ws.oidUser);
    if (!result.ok) {
      return this.sendMessage(ws, { type: 'QUARTET_ERROR', payload: { reason: result.reason } });
    }
    this.sendMessage(ws, { type: 'QUARTET_INVITE_REJECTED', payload: { requesterOidUser } });
  }

  private async handleQuartetInviteRemove(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const targetOidUser = await this.resolveTargetUserId(payload);
    if (!targetOidUser) {
      return this.sendError(ws, 'TARGET_REQUIRED');
    }
    const result = await this.quartetManager.removeInvite(ws.oidUser, targetOidUser);
    if (!result.ok) {
      return this.sendMessage(ws, { type: 'QUARTET_ERROR', payload: { reason: result.reason } });
    }
    this.sendMessage(ws, { type: 'QUARTET_INVITE_REMOVED', payload: { oidUser: targetOidUser } });
    const targetClient = this.clients.get(targetOidUser);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
      this.sendMessage(targetClient, { type: 'QUARTET_INVITE_REMOVED', payload: { oidUser: ws.oidUser } });
    }
  }

  private async handleQuartetListAccepted(ws: AuthenticatedWebSocket): Promise<void> {
    if (!ws.oidUser) {
      return this.sendMessage(ws, {
        type: 'QUARTET_ERROR',
        payload: { reason: 'NOT_AUTHENTICATED' }
      });
    }
    try {
      const accepted = await this.quartetManager.listAcceptedInvites(ws.oidUser);
      this.sendMessage(ws, { type: 'QUARTET_LIST_ACCEPTED', payload: { accepted } });
    } catch (err) {
      const reason = (err as Error).message === 'DATABASE_TIMEOUT' ? 'DATABASE_TIMEOUT' : 'INTERNAL_ERROR';
      this.sendMessage(ws, { type: 'QUARTET_ERROR', payload: { reason } });
    }
  }

  private async handleQuartetListPending(ws: AuthenticatedWebSocket): Promise<void> {
    if (!ws.oidUser) {
      return this.sendMessage(ws, {
        type: 'QUARTET_ERROR',
        payload: { reason: 'NOT_AUTHENTICATED' }
      });
    }
    try {
      const pending = await this.quartetManager.listPendingInvites(ws.oidUser);
      this.sendMessage(ws, { type: 'QUARTET_LIST_PENDING', payload: { pending } });
    } catch (err) {
      const reason = (err as Error).message === 'DATABASE_TIMEOUT' ? 'DATABASE_TIMEOUT' : 'INTERNAL_ERROR';
      this.sendMessage(ws, { type: 'QUARTET_ERROR', payload: { reason } });
    }
  }

  /**
   * Obtém o username de um jogador
   * IMPORTANTE: Sempre retorna um username válido (nunca null/undefined)
   * Se não encontrado, retorna fallback "Player{oidUser}"
   */
  private async getUsername(oidUser: number): Promise<string> {
    const client = this.clients.get(oidUser);
    if (client?.username && client.username.trim().length > 0) {
      return client.username.trim();
    }

    try {
      const row = await prismaGame.$queryRaw<any[]>`
        SELECT TOP 1 NickName FROM CBT_User WHERE oiduser = ${oidUser} AND NickName IS NOT NULL
      `;

      const nickname = row?.[0]?.NickName;
      if (nickname && typeof nickname === 'string' && nickname.trim().length > 0) {
        return nickname.trim();
      }
    } catch (err) {
      log('warn', `Erro ao buscar username para oidUser ${oidUser}`, err);
    }

    // Fallback quando username não é encontrado ou é inválido
    return `Player${oidUser}`;
  }

  private async resolveTargetUserId(payload: any): Promise<number | null> {
    const direct = Number(payload?.targetOidUser);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const targetLogin = (payload?.targetLogin as string | undefined)?.trim();
    if (!targetLogin) return null;
    try {
      const rows = await prismaGame.$queryRaw<any[]>`
        SELECT TOP 1 oiduser FROM CBT_User WHERE NickName = ${targetLogin}
      `;
      if (rows && rows[0]?.oiduser) {
        return Number(rows[0].oiduser);
      }
    } catch (err) {
      log('warn', `Falha ao resolver targetLogin ${targetLogin}`, err);
    }
    return null;
  }

  // Resolver target apenas por NickName (adição de amigos)
  private async resolveTargetUserIdByNickname(payload: any): Promise<number | null> {
    const targetLogin =
      (payload?.targetLogin as string | undefined)?.trim() ||
      (payload?.targetNickname as string | undefined)?.trim() ||
      (payload?.nickname as string | undefined)?.trim() ||
      (payload?.nick as string | undefined)?.trim();

    if (!targetLogin) return null;

    try {
      const rows = await prismaGame.$queryRaw<any[]>`
        SELECT TOP 1 oiduser FROM CBT_User WHERE NickName = ${targetLogin}
      `;
      if (rows && rows[0]?.oiduser) {
        return Number(rows[0].oiduser);
      }
    } catch (err) {
      log('warn', `Falha ao resolver NickName ${targetLogin}`, err);
    }
    return null;
  }

  // =========================
  // PARTY HANDLERS
  // =========================

  private async handlePartyCreate(ws: AuthenticatedWebSocket): Promise<void> {
    if (!ws.oidUser) return;
    const existingPartyId = await this.partyManager.getPartyIdByPlayer(ws.oidUser);
    if (existingPartyId) {
      const party = await this.partyManager.getParty(existingPartyId);
      if (party) {
        this.sendMessage(ws, { type: 'PARTY_UPDATED', payload: { party } });
        return;
      }
    }
    const party = await this.partyManager.createParty(ws.oidUser);
    this.sendMessage(ws, { type: 'PARTY_UPDATED', payload: { party } });
  }

  private async handlePartyInvite(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const targetOidUser = Number(payload?.targetOidUser);
    if (!targetOidUser) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'TARGET_REQUIRED' } });
    }
    const deletePairKey = async (id1: number, id2: number) => {
      try {
        const a = Math.min(id1, id2);
        const b = Math.max(id1, id2);
        await this.redis.del(`party:invitepair:${a}:${b}`);
      } catch (err) {
        log('warn', `Falha ao limpar chave de convite (${id1}, ${id2})`, err);
      }
    };
    const partyId = await this.partyManager.getPartyIdByPlayer(ws.oidUser);
    if (!partyId) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'NO_PARTY' } });
    }
    const party = await this.partyManager.getParty(partyId);
    if (!party || party.leaderId !== ws.oidUser) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'NOT_LEADER' } });
    }
    if (party.members.length >= 2) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'PARTY_FULL' } });
    }

    // Evita convites duplicados/cruzados entre o mesmo par de jogadores
    const requesterId = ws.oidUser as number;
    const cleanupInvitePair = async () => deletePairKey(requesterId, targetOidUser);
    try {
      const a = Math.min(requesterId, targetOidUser);
      const b = Math.max(requesterId, targetOidUser);
      const pairKey = `party:invitepair:${a}:${b}`;
      const exists = await this.redis.get(pairKey);
      if (exists) {
        return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'INVITE_ALREADY_SENT' } });
      }
      await this.redis.set(pairKey, '1', { EX: 300 }); // 5 min
    } catch (err) {
      log('warn', `Falha ao registrar par de convite (${ws.oidUser}, ${targetOidUser})`, err);
    }

    const eligibility = await this.checkPartyInviteConstraints(ws.oidUser, targetOidUser, party.id);
    if (!eligibility.ok) {
      await cleanupInvitePair();
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: eligibility.reason, endsAt: eligibility.endsAt, offender: eligibility.offender } });
    }
    const targetClient = this.clients.get(targetOidUser);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
      const inviterName = ws.username || (await this.getUsername(ws.oidUser));
      this.sendMessage(targetClient, {
        type: 'PARTY_INVITE',
        payload: { partyId, inviterOidUser: ws.oidUser, inviterName }
      });
      this.sendMessage(ws, { type: 'PARTY_INVITE_SENT', payload: { targetOidUser } });
    } else {
      await cleanupInvitePair();
      this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'TARGET_OFFLINE' } });
    }
  }

  private async handlePartyAcceptInvite(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const partyId = payload?.partyId as string;
    if (!partyId) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'PARTY_ID_REQUIRED' } });
    }

    // Se já estiver em outra party, remove antes de aceitar o convite atual
    const existing = await this.partyManager.getPartyIdByPlayer(ws.oidUser);
    if (existing && existing !== partyId) {
      // Se o jogador era líder da party antiga, desfaça a party inteira
      const oldPartyState = await this.partyManager.getParty(existing);
      if (oldPartyState && oldPartyState.leaderId === ws.oidUser) {
        for (const memberId of oldPartyState.members) {
          this.sendToPlayer(memberId, { type: 'PARTY_LEFT', payload: { partyId: existing } });
        }
        await this.partyManager.deleteParty(existing);
      } else {
        const oldParty = await this.partyManager.removeMember(existing, ws.oidUser);
        this.sendMessage(ws, { type: 'PARTY_LEFT', payload: { partyId: existing } });
        if (oldParty) {
          this.broadcastPartyUpdate(oldParty);
        }
      }
    } else if (existing === partyId) {
      // Já está na mesma party - apenas envia estado
      const current = await this.partyManager.getParty(partyId);
      if (current) {
        this.sendMessage(ws, { type: 'PARTY_UPDATED', payload: { party: current } });
      }
      return;
    }

    // Evita convites cruzados duplicados: se o alvo já tem convite pendente para o líder, considere aceitar direto
    if (ws.inviteFrom === partyId) {
      // noop; segue fluxo normal
    }

    const party = await this.partyManager.addMember(partyId, ws.oidUser);
    if (!party) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'PARTY_NOT_FOUND' } });
    }
    if (party.members.length > 2) {
      await this.partyManager.removeMember(partyId, ws.oidUser);
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'PARTY_FULL' } });
    }
    const eligibility = await this.checkPartyInviteConstraints(party.leaderId, ws.oidUser, partyId);
    if (!eligibility.ok) {
      await this.partyManager.removeMember(partyId, ws.oidUser);
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: eligibility.reason, endsAt: eligibility.endsAt, offender: eligibility.offender } });
    }
    // Limpa chave de convite após aceitar
    try {
      const a = Math.min(party.leaderId, ws.oidUser);
      const b = Math.max(party.leaderId, ws.oidUser);
      await this.redis.del(`party:invitepair:${a}:${b}`);
    } catch (err) {
      log('warn', `Falha ao limpar par de convite ao aceitar (${party.leaderId}, ${ws.oidUser})`, err);
    }
    this.broadcastPartyUpdate(party);
  }

  private async handlePartyDeclineInvite(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const inviterOidUser = Number(payload?.inviterOidUser);
    if (!inviterOidUser) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'INVITER_REQUIRED' } });
    }

    // Limpa o par de convite para permitir reenvio imediato
    try {
      const a = Math.min(inviterOidUser, ws.oidUser);
      const b = Math.max(inviterOidUser, ws.oidUser);
      await this.redis.del(`party:invitepair:${a}:${b}`);
    } catch (err) {
      log('warn', `Falha ao limpar par de convite ao recusar (${inviterOidUser}, ${ws.oidUser})`, err);
    }

    // Notifica o líder que a pessoa recusou (se estiver online)
    const inviterClient = this.clients.get(inviterOidUser);
    if (inviterClient && inviterClient.readyState === WebSocket.OPEN) {
      this.sendMessage(inviterClient, {
        type: 'PARTY_INVITE_DECLINED',
        payload: { targetOidUser: ws.oidUser }
      });
    }
  }

  private async handlePartyLeave(ws: AuthenticatedWebSocket): Promise<void> {
    if (!ws.oidUser) return;
    const partyId = await this.partyManager.getPartyIdByPlayer(ws.oidUser);
    if (!partyId) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'NO_PARTY' } });
    }

    // Se a party estava na fila, remove todos antes de alterar a party
    await this.removePartyFromQueue(partyId);

    // Limpa convites pendentes enviados por este jogador (evita bloquear reenvio)
    await this.clearPartyInvitesForUser(ws.oidUser);

    const party = await this.partyManager.removeMember(partyId, ws.oidUser);
    if (!party) {
      // Party deletada
      this.sendMessage(ws, { type: 'PARTY_LEFT', payload: { partyId } });
      return;
    }
    this.sendMessage(ws, { type: 'PARTY_LEFT', payload: { partyId } });
    this.broadcastPartyUpdate(party);
  }

  private async handlePartyKick(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const targetOidUser = Number(payload?.targetOidUser);
    if (!targetOidUser) return;
    const partyId = await this.partyManager.getPartyIdByPlayer(ws.oidUser);
    if (!partyId) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'NO_PARTY' } });
    }
    const party = await this.partyManager.getParty(partyId);
    if (!party || party.leaderId !== ws.oidUser) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'NOT_LEADER' } });
    }

    // Se a party estava na fila, remove todos antes de alterar a party
    await this.removePartyFromQueue(partyId);

    const updated = await this.partyManager.removeMember(partyId, targetOidUser);
    try {
      const a = Math.min(ws.oidUser, targetOidUser);
      const b = Math.max(ws.oidUser, targetOidUser);
      await this.redis.del(`party:invitepair:${a}:${b}`);
    } catch (err) {
      log('warn', `Falha ao limpar par de convite ao kick (${ws.oidUser}, ${targetOidUser})`, err);
    }
    this.sendMessage(ws, { type: 'PARTY_KICKED', payload: { oidUser: targetOidUser } });
    const targetClient = this.clients.get(targetOidUser);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
      this.sendMessage(targetClient, { type: 'PARTY_KICKED', payload: { oidUser: targetOidUser } });
    }
    if (updated) {
      this.broadcastPartyUpdate(updated);
    }
  }

  private async handlePartyTransferLead(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const targetOidUser = Number(payload?.targetOidUser);
    if (!targetOidUser) return;
    const partyId = await this.partyManager.getPartyIdByPlayer(ws.oidUser);
    if (!partyId) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'NO_PARTY' } });
    }
    const party = await this.partyManager.getParty(partyId);
    if (!party || party.leaderId !== ws.oidUser) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'NOT_LEADER' } });
    }
    const updated = await this.partyManager.transferLead(partyId, targetOidUser);
    if (!updated) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'TRANSFER_FAILED' } });
    }
    this.broadcastPartyUpdate(updated);
  }

  /**
   * Remove todas as chaves de convite de party envolvendo o usuário.
   */
  private async clearPartyInvitesForUser(userId: number): Promise<void> {
    try {
      for await (const key of this.redis.scanIterator({ MATCH: 'party:invitepair:*', COUNT: 100 })) {
        const parts = String(key).split(':');
        const ids = parts.slice(-2).map((p) => Number(p));
        if (ids.some((id) => id === userId)) {
          try {
            await this.redis.del(String(key));
          } catch (err) {
            log('warn', `Falha ao remover chave de convite ${key} para usuário ${userId}`, err);
          }
        }
      }
    } catch (err) {
      log('warn', `Falha ao varrer convites pendentes para ${userId}`, err);
    }
  }

  private broadcastPartyUpdate(party: { id: string; members: number[]; leaderId: number }): void {
    for (const oid of party.members) {
      const client = this.clients.get(oid);
      if (client && client.readyState === WebSocket.OPEN) {
        this.sendMessage(client, { type: 'PARTY_UPDATED', payload: { party } });
      }
    }
  }

  /**
   * Remove todos os membros da party da fila, caso estejam em matchmaking.
   * Evita inconsistÍncia quando alguém sai/kicka enquanto a party já estava na fila.
   */
  private async removePartyFromQueue(partyId: string): Promise<void> {
    const party = await this.partyManager.getParty(partyId);
    if (!party) return;

    for (const memberId of party.members) {
      if (this.queueManager.isInQueue(memberId)) {
        await this.queueManager.removeFromQueue(memberId);
        this.sendToPlayer(memberId, { type: 'QUEUE_LEFT' });
      }
    }
  }

  /**
   * Verifica se todos os membros da party podem entrar na fila
   */
  private async checkPartyEligibility(members: number[], partyId: string): Promise<{ ok: boolean; reason?: string; offender?: number; endsAt?: number }> {
    if (!members || members.length === 0) return { ok: true }

    // 1) Checa cooldown
    for (const oid of members) {
      try {
        const cooldownRaw = await this.redis.get(`cooldown:${oid}`)
        if (cooldownRaw) {
          const endsAt = parseInt(cooldownRaw, 10)
          if (!Number.isNaN(endsAt) && endsAt > Date.now()) {
            return { ok: false, reason: 'PARTY_MEMBER_COOLDOWN', offender: oid, endsAt }
          }
        }
      } catch {}
    }

    // 2) Checa se algum membro já está na fila
    for (const oid of members) {
      if (this.queueManager.isInQueue(oid)) {
        return { ok: false, reason: 'PARTY_MEMBER_IN_QUEUE', offender: oid }
      }
    }

    // 3) Checa distância de tier (máximo 2 tiers)
    try {
      const ranks = await prismaRanked.$queryRawUnsafe<{ oidUser: number; rankTier: string | null; rankPoints: number | null }[]>(
        `SELECT oidUser, ISNULL(rankTier, 'BRONZE_3') as rankTier, ISNULL(rankPoints, 0) as rankPoints
         FROM BST_RankedUserStats
         WHERE oidUser IN (${members.join(',')})`
      );
      const tierById = new Map<number, RankTier>()
      ranks.forEach(r => tierById.set(r.oidUser, (r.rankTier as RankTier) || 'BRONZE_3'))
      // fallback se não vier do banco
      members.forEach(id => {
        if (!tierById.has(id)) tierById.set(id, 'BRONZE_3')
      })

      const tiers = Array.from(tierById.values())
      const indices = tiers.map(getTierIndex)
      const maxDiff = Math.max(...indices) - Math.min(...indices)
      if (maxDiff > 2) {
        return { ok: false, reason: 'PARTY_TIER_MISMATCH' }
      }
    } catch (err) {
      log('warn', `Falha ao validar tiers da party ${partyId}`, err)
    }

    // 4) Checa se todos os membros estão CONECTADOS ao WebSocket
    for (const oid of members) {
      const client = this.clients.get(oid)
      if (!client || client.readyState !== WebSocket.OPEN) {
        return { ok: false, reason: 'PARTY_MEMBER_OFFLINE', offender: oid }
      }
    }

    return { ok: true }
  }

  /**
   * Valida convite/entrada na party (cooldown, fila, tier distante)
   */
  private async checkPartyInviteConstraints(inviterOid: number, targetOid: number, partyId: string): Promise<{ ok: boolean; reason?: string; offender?: number; endsAt?: number }> {
    // 1) cooldown no alvo
    try {
      const cooldownRaw = await this.redis.get(`cooldown:${targetOid}`)
      if (cooldownRaw) {
        const endsAt = parseInt(cooldownRaw, 10)
        if (!Number.isNaN(endsAt) && endsAt > Date.now()) {
          return { ok: false, reason: 'PARTY_MEMBER_COOLDOWN', offender: targetOid, endsAt }
        }
      }
    } catch {}

    // 2) alvo já na fila
    if (this.queueManager.isInQueue(targetOid)) {
      return { ok: false, reason: 'PARTY_MEMBER_IN_QUEUE', offender: targetOid }
    }

    // 3) distância de tier (max 2)
    try {
      const rows = await prismaRanked.$queryRawUnsafe<{ oidUser: number; rankTier: string | null; rankPoints: number | null }[]>(
        `SELECT oidUser, ISNULL(rankTier, 'BRONZE_3') as rankTier, ISNULL(rankPoints, 0) as rankPoints
         FROM BST_RankedUserStats
         WHERE oidUser IN (${[inviterOid, targetOid].join(',')})`
      );
      const tierById = new Map<number, RankTier>()
      rows.forEach(r => tierById.set(r.oidUser, (r.rankTier as RankTier) || 'BRONZE_3'))
      if (!tierById.has(inviterOid)) tierById.set(inviterOid, 'BRONZE_3')
      if (!tierById.has(targetOid)) tierById.set(targetOid, 'BRONZE_3')
      const indices = [inviterOid, targetOid].map(id => getTierIndex(tierById.get(id) as RankTier))
      const diff = Math.max(...indices) - Math.min(...indices)
      if (diff > 2) {
        return { ok: false, reason: 'PARTY_TIER_MISMATCH' }
      }
    } catch (err) {
      log('warn', `Falha ao validar tiers para party ${partyId}`, err)
    }

    return { ok: true }
  }

  /**
   * LOBBY_ABANDON - Jogador desistiu da lobby antes da partida começar
   */
  private async handleLobbyAbandon(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;

    const { matchId } = payload || {};
    if (!matchId) {
      this.sendError(ws, 'matchId ausente em LOBBY_ABANDON');
      return;
    }

    const lobby = this.lobbyManager.getLobby(matchId);
    const redisStatus = await this.redis.get(`match:${matchId}:status`).catch(() => null);
    const inProgress = this.validationManager.isValidating(matchId) || redisStatus === 'in-progress';
    const shouldPenalize = true; // Sempre penaliza abandono de lobby

    // Aplica punição incremental (mesma base do decline de READY, mas com janelas 30m/2h/24h)
    if (shouldPenalize) {
      const penalty = await this.applyAbandonPenalty(ws.oidUser);
      if (penalty.seconds > 0) {
        this.sendMessage(ws, {
          type: 'COOLDOWN_SET',
          payload: {
            reason: 'ABANDON_MATCH',
            seconds: penalty.seconds,
            endsAt: penalty.endsAt,
            count: penalty.count
          }
        });
      }
      try {
        await this.lobbyManager.clearActiveLobbyForPlayers([ws.oidUser]);
      } catch {}
    }

    // Caso 3: partida já em andamento - apenas penaliza e encerra
    if (inProgress) {
      return;
    }

    // Caso 1/2: fase de vetos ou criação de sala - cancela lobby e requeueia os outros 9
    let playerIds: number[] = [];
    if (lobby) {
      playerIds = [
        ...lobby.teams.ALPHA.map(p => p.oidUser),
        ...lobby.teams.BRAVO.map(p => p.oidUser)
      ];
    }
    if (playerIds.length === 0) {
      playerIds = await this.getMatchPlayerIds(matchId);
    }
    if (playerIds.length === 0) {
      this.sendError(ws, 'Lobby/Match não encontrado para abandono');
      return;
    }

    const snapshotByPlayer = await this.getQueueSnapshotByPlayer(matchId);
    const requeueMessage = 'Um jogador desistiu da lobby. Você voltou para a fila.';

    for (const oid of playerIds) {
      if (oid === ws.oidUser) continue; // apenas os outros retornam para a fila
      const entry = snapshotByPlayer[oid];
      const queuedAt = entry?.queuedAt || Date.now();
      const classes = entry?.classes || null;

      try {
        await this.redis.set(
          `requeue:ranked:${oid}`,
          JSON.stringify({ queuedAt, classes }),
          { EX: 600 }
        );
      } catch (err) {
        log('warn', `Falha ao preparar requeue (LOBBY_ABANDON) para player ${oid}`, err);
      }

      this.sendToPlayer(oid, {
        type: 'REQUEUE',
        payload: {
          message: requeueMessage,
          reason: 'LOBBY_ABANDON',
          queuedAt
        }
      });
    }

    // Mantém a party viva para que possam voltar juntos à fila
    await this.keepPartyAliveForPlayers(playerIds);

    // Limpa estado de lobby/host e artefatos de Redis mesmo que o host não tenha criado sala
    if (lobby) {
      await this.lobbyManager.removeLobby(matchId);
    }
    try {
      await this.hostManager.forceAbortByMatch(matchId, 'ABANDON_LOBBY');
    } catch (err) {
      log('warn', `Falha ao abortar host para ${matchId} após abandono`, err);
    }

    // Cleanup adicional defensivo para evitar chaves órfãs
    const cleanupKeys = [
      `match:${matchId}:status`,
      `match:${matchId}:queueSnapshot`,
      `match:${matchId}:ready`,
      `match:${matchId}:classes`,
      `match:${matchId}:host`,
      `match:${matchId}:hostPassword`,
      `match:${matchId}:room`,
      `room:${matchId}`,
      `lobby:temp:${matchId}`,
      `lobby:${matchId}:state`,
      `lobby:${matchId}:vetos`,
      `lobby:${matchId}:votes`,
      `lobby:${matchId}:selectedMap`
    ];
    try {
      if (cleanupKeys.length) {
        await this.redis.del(cleanupKeys);
      }
    } catch (err) {
      log('warn', `Falha ao limpar chaves da lobby ${matchId} após abandono`, err);
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
      this.sendError(ws, DOMAIN_ERRORS.LOBBY_UNAUTHORIZED.default);
      return;
    }
    const lobby = this.lobbyManager.getLobby(matchId);
    if (!lobby) {
      // Lobby expirou/sumiu: avisa o cliente e requeue automático com fallback
      this.sendMessage(ws, {
        type: 'LOBBY_NOT_FOUND',
        payload: {
          matchId,
          message: 'Lobby indisponível. Você voltará para a fila.'
        }
      });
      await this.handleLobbyOrReadyExpired(matchId, 'LOBBY_MISSING', ws.oidUser ? [ws.oidUser] : []);
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

    const buildAnonymizedTeams = (viewerTeam: 'ALPHA' | 'BRAVO') => {
      let opponentCounter = 1
      const anonymized = {
        ALPHA: [] as typeof lobby.teams.ALPHA,
        BRAVO: [] as typeof lobby.teams.BRAVO
      }

      ;(['ALPHA', 'BRAVO'] as const).forEach(teamKey => {
        anonymized[teamKey] = lobby.teams[teamKey].map(player => {
          const isTeammate = teamKey === viewerTeam
          const username = isTeammate
            ? player.username
            : `Player ${String(opponentCounter++).padStart(2, '0')}`

          return {
            ...player,
            username
          }
        })
      })

      return anonymized
    }

    const teamsForClient = buildAnonymizedTeams(playerTeam)
    const mapPool = this.lobbyManager.getRankedMapPool(); // <-- ADICIONE ESTA LINHA

    this.sendMessage(ws, {
      type: 'LOBBY_DATA',
      payload: {
        matchId: lobby.matchId,
        teams: teamsForClient,
        vetoedMaps: lobby.vetoedMaps,
        vetoHistory: lobby.vetoHistory,
        currentTurn: lobby.currentTurn,
        timeRemaining: lobby.timeRemaining,
        selectedMap: lobby.selectedMap,
        mapVotes: this.lobbyManager.getMapVotes(matchId),
        playerTeam,
        chatMessages: playerTeam ? lobby.chatMessages[playerTeam] : [],
        generalChatMessages: playerTeam ? this.buildGeneralChatHistory(lobby, playerTeam) : [],
        status: lobby.status,
        classesByPlayer: filteredClassesByPlayer, // <-- CORRIGIDO
        mapPool: mapPool, // <-- ADICIONE ESTA LINHA
        discord: this.discordService.getGeneralChannelInfo()
      }
    });
    log('debug', `🏰 ${ws.username} entrou na lobby ${matchId}`);
  }
  /**
   * REQUEST_DISCORD_MOVE / LOBBY_ACCEPT_VOICE_TRANSFER - mover jogador para o canal do time no Discord
   */
  private async handleDiscordMoveRequest(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return

    const matchId = payload?.matchId as string | undefined
    const respond = (success: boolean, reason?: string, channelId?: string) => {
      this.sendMessage(ws, {
        type: 'DISCORD_MOVE_RESULT',
        payload: { matchId, success, reason, channelId }
      })
    }

    if (!matchId) {
      respond(false, 'MATCH_ID_MISSING')
      return
    }

    const lobby = this.lobbyManager.getLobby(matchId)
    if (!lobby) {
      respond(false, 'LOBBY_NOT_FOUND')
      return
    }

    const isAlpha = lobby.teams.ALPHA.some(p => p.oidUser === ws.oidUser)
    const isBravo = lobby.teams.BRAVO.some(p => p.oidUser === ws.oidUser)
    const team: 'ALPHA' | 'BRAVO' | null = isAlpha ? 'ALPHA' : isBravo ? 'BRAVO' : null

    if (!team) {
      respond(false, 'NOT_IN_LOBBY')
      return
    }

    if (!ws.discordId) {
      respond(false, 'MISSING_DISCORD_ID')
      return
    }

    const moveResult = await this.discordService.movePlayerToTeamChannel(matchId, team, ws.discordId)

    respond(moveResult.ok, moveResult.reason, moveResult.channelId)
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
      this.sendError(ws, 'Falha ao registrar veto, tente novamente')
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
      this.sendError(ws, 'Falha ao registrar veto, tente novamente')
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

    const { matchId, message, channel } = payload
    const normalizedChannel: 'TEAM' | 'GENERAL' = channel === 'GENERAL' ? 'GENERAL' : 'TEAM'

    if (!message || message.trim().length === 0) {
      return
    }

    const chatResult = await this.lobbyManager.addChatMessage(matchId, ws.oidUser, message.trim(), normalizedChannel)
    if (!chatResult) {
      this.sendError(ws, 'Falha ao registrar mensagem no chat, tente novamente')
      return
    }

    const lobby = this.lobbyManager.getLobby(matchId)
    if (!lobby) return

    if (normalizedChannel === 'TEAM') {
      const targetPlayers =
        chatResult.team === 'ALPHA' ? lobby.teams.ALPHA : lobby.teams.BRAVO
      const playerIds = targetPlayers.map(p => p.oidUser)

      this.sendToPlayers(playerIds, {
        type: 'CHAT_MESSAGE',
        payload: {
          channel: 'TEAM',
          team: chatResult.team,
          oidUser: chatResult.chatMessage.oidUser,
          username: chatResult.chatMessage.username,
          message: chatResult.chatMessage.message,
          timestamp: chatResult.chatMessage.timestamp
        }
      })
      return
    }

    // Canal geral: envia para todos com anonimiza��o de acordo com o time de quem recebe
    const allPlayers = [...lobby.teams.ALPHA, ...lobby.teams.BRAVO]
    for (const player of allPlayers) {
      const viewerTeam = lobby.teams.ALPHA.some(p => p.oidUser === player.oidUser) ? 'ALPHA' : 'BRAVO'
      const displayName = this.getChatDisplayName(lobby, viewerTeam, chatResult.team, chatResult.chatMessage)

      this.sendToPlayer(player.oidUser, {
        type: 'CHAT_MESSAGE',
        payload: {
          channel: 'GENERAL',
          team: chatResult.team,
          oidUser: chatResult.chatMessage.oidUser,
          username: displayName,
          message: chatResult.chatMessage.message,
          timestamp: chatResult.chatMessage.timestamp
        }
      })
    }
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

      // Limpa convites de party associados (caso fosse líder ou remetente de convites)
      this.clearPartyInvitesForUser(ws.oidUser).catch((err) => {
        log('warn', `Falha ao limpar convites de party na desconexão (${ws.oidUser})`, err);
      });

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

  private getChatDisplayName(
    lobby: any,
    viewerTeam: 'ALPHA' | 'BRAVO',
    senderTeam: 'ALPHA' | 'BRAVO',
    chatMessage: { oidUser: number; username: string }
  ): string {
    if (viewerTeam === senderTeam) {
      return chatMessage.username
    }
    const opponents = viewerTeam === 'ALPHA' ? lobby.teams.BRAVO : lobby.teams.ALPHA
    const index = opponents.findIndex((p: any) => p.oidUser === chatMessage.oidUser)
    const number = index >= 0 ? index + 1 : opponents.length + 1
    return `Player ${String(number).padStart(2, '0')}`
  }

  private buildGeneralChatHistory(lobby: any, viewerTeam: 'ALPHA' | 'BRAVO') {
    return lobby.generalChatMessages.map((msg: any) => ({
      channel: 'GENERAL',
      team: msg.team,
      oidUser: msg.oidUser,
      username: this.getChatDisplayName(lobby, viewerTeam, msg.team, msg),
      message: msg.message,
      timestamp: msg.timestamp
    }))
  }

  /**
   * Requeue automático quando lobby/ready sumirem
   */
  private async handleLobbyOrReadyExpired(matchId: string, reason: string, fallbackPlayerIds: number[] = []): Promise<void> {
    let playerIds = await this.getMatchPlayerIds(matchId);
    if (playerIds.length === 0 && fallbackPlayerIds.length > 0) {
      playerIds = fallbackPlayerIds;
    }
    if (playerIds.length === 0) {
      log('warn', `[LobbyExpired ${matchId}] Nenhum jogador encontrado para requeue`);
      return;
    }

    const snapshotByPlayer = await this.getQueueSnapshotByPlayer(matchId);
    await this.lobbyManager.clearActiveLobbyForPlayers(playerIds);

    for (const oid of playerIds) {
      const snapshotEntry = snapshotByPlayer[oid];
      const queuedAtFallback = snapshotEntry?.queuedAt || Date.now();
      const classesFallback = snapshotEntry?.classes || null;

      try {
        await this.redis.set(
          `requeue:ranked:${oid}`,
          JSON.stringify({
            queuedAt: queuedAtFallback,
            classes: classesFallback
          }),
          { EX: 600 }
        );
      } catch (err) {
        log('warn', `Falha ao preparar dados de requeue (lobby expired) para player ${oid}`, err);
      }

      this.sendToPlayer(oid, {
        type: 'REQUEUE',
        payload: {
          message: 'Match indisponível, retornando à fila.',
          reason,
          queuedAt: queuedAtFallback
        }
      });
    }

    await this.keepPartyAliveForPlayers(playerIds);

    try {
      await this.redis.del(`match:${matchId}:queueSnapshot`);
    } catch { }
  }

  private async getQueueSnapshotByPlayer(matchId: string): Promise<Record<number, { queuedAt?: number; classes?: QueuePlayer['classes'] }>> {
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
    return snapshotByPlayer;
  }

  /**
   * Aplica puni��o incremental por abandonar uma partida em andamento.
   */
  private async applyAbandonPenalty(oidUser: number): Promise<{ count: number; seconds: number; endsAt: number | null }> {
    const counterKey = `abandon:count:${oidUser}`;
    const count = await this.redis.incr(counterKey);
    const ttl = await this.redis.ttl(counterKey);
    if (ttl < 0) {
      await this.redis.expire(counterKey, 24 * 60 * 60); // janela de 24h
    }

    let seconds = 0;
    if (count === 1) seconds = 30 * 60; // 30 minutos
    else if (count === 2) seconds = 2 * 60 * 60; // 2 horas
    else seconds = 24 * 60 * 60; // 24 horas para 3+

    let endsAt: number | null = null;
    if (seconds > 0) {
      endsAt = Date.now() + seconds * 1000;
      await this.redis.set(`cooldown:${oidUser}`, String(endsAt), { EX: seconds });
    }

    log('warn', `Cooldown por abandono aplicado para ${oidUser}: count=${count}, seconds=${seconds}`);
    return { count, seconds, endsAt };
  }

  private async getMatchPlayerIds(matchId: string): Promise<number[]> {
    // Tenta pela hash de ready
    try {
      const readyEntries = await this.redis.hGetAll(`match:${matchId}:ready`);
      const ids = Object.keys(readyEntries || {})
        .filter(k => k && !k.startsWith('_'))
        .map(k => parseInt(k, 10))
        .filter(n => !Number.isNaN(n));
      if (ids.length > 0) return ids;
    } catch {}

    // Tenta pelo snapshot salvo
    try {
      const snapshotRaw = await this.redis.get(`match:${matchId}:queueSnapshot`);
      if (snapshotRaw) {
        const parsed = JSON.parse(snapshotRaw);
        if (Array.isArray(parsed)) {
          const ids = parsed
            .map((p: any) => (p && typeof p.oidUser === 'number' ? p.oidUser : null))
            .filter((n: number | null) => n !== null) as number[];
          if (ids.length > 0) return ids;
        }
      }
    } catch {}

    // Fallback vazio
    return [];
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
   * Renova o TTL e reenviA o estado da party para os jogadores informados (se houver party).
   * Ajuda a manter a dupla/grupo junta ao sair de uma partida/lobby e voltar à fila.
   */
  private async keepPartyAliveForPlayers(playerIds: number[]): Promise<void> {
    const processed = new Set<string>()
    for (const oid of playerIds) {
      const partyId = await this.partyManager.getPartyIdByPlayer(oid)
      if (!partyId || processed.has(partyId)) continue
      processed.add(partyId)
      try {
        await this.partyManager.refreshPartyTtl(partyId)
        const party = await this.partyManager.getParty(partyId)
        if (party) {
          this.broadcastPartyUpdate(party)
        }
      } catch (err) {
        log('warn', `Falha ao manter party viva (party ${partyId})`, err)
      }
    }
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
