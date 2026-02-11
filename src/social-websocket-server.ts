import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import { createServer, Server as HttpServer } from 'http';
import cors from 'cors';
import { FriendManager } from './managers/friend-manager';
import { PartyManager } from './managers/party-manager';
import { QuartetManager } from './managers/quartet-manager';
import { TournamentInviteManager } from './managers/tournament-invite-manager';
import { PaymentManager } from './managers/payment-manager';
import { prismaGame } from './database/prisma';
import { log } from './utils/logger';
import { getRedisClient } from './database/redis-client';

/**
 * Interface para WebSocket autenticado
 */
interface AuthenticatedWebSocket extends WebSocket {
  oidUser?: number;
  username?: string;
  isAlive?: boolean;
  tabId?: string;
}

interface WSMessage {
  type: string;
  payload?: any;
}

interface TokenValidationParams {
  token: string;
  oidUser: number;
}

interface TokenValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Servidor WebSocket Social
 * Gerencia apenas funcionalidades sociais: Amigos, Quarteto e Party
 *
 * IMPORTANTE: Implementa "Tab Replacement" - nova conexão substitui a anterior
 */
export class SocialWebSocketServer {
  private redis = getRedisClient();
  private subscriber: any;
  private wss: WebSocketServer;
  private clients: Map<number, AuthenticatedWebSocket> = new Map();
  private heartbeatInterval?: NodeJS.Timeout;

  // Managers
  private friendManager: FriendManager;
  private partyManager: PartyManager;
  private quartetManager: QuartetManager;
  private tournamentInviteManager: TournamentInviteManager;
  private paymentManager: PaymentManager;

  // Servidor HTTP e App Express
  private app: express.Express;
  private httpServer: HttpServer;

  constructor() {
    // 1. Criar App Express e Servidor HTTP
    this.app = express();
    this.httpServer = createServer(this.app);

    // 2. Configurar CORS
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
    const corsOrigins = [FRONTEND_URL, 'null', 'http://localhost:3001'];

    log('debug', `CORS Permitido para: ${FRONTEND_URL}`);

    this.app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin || corsOrigins.includes(origin)) {
            callback(null, true);
          } else {
            log('warn', `CORS Bloqueado: ${origin}`);
            callback(new Error('Requisicao nao permitida pelo CORS'));
          }
        },
        credentials: true
      })
    );

    // 3. Rota de Health Check
    this.app.get('/health', (_req, res) => {
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'social-websocket'
      });
    });

    // 4. Anexar o WebSocketServer ao Servidor HTTP
    this.wss = new WebSocketServer({ server: this.httpServer });

    // 5. Inicializar managers sociais
    this.friendManager = new FriendManager();
    this.partyManager = new PartyManager();
    this.quartetManager = new QuartetManager();
    this.tournamentInviteManager = new TournamentInviteManager();
    this.paymentManager = new PaymentManager();

    // 6. Configurar o Servidor WebSocket
    this.setupWebSocketServer();
    this.setupRedisSubscriber(); // Configurar subscriber Redis
    this.startHeartbeat();

    log('info', 'Social WebSocket Server pronto.');
  }

  /**
   * Configurar Redis Subscriber para eventos externos
   */
  private async setupRedisSubscriber() {
    try {
      this.subscriber = this.redis.duplicate();
      await this.subscriber.connect();
      
      // Subscreve a eventos sociais
      await this.subscriber.subscribe('social:events', (message: string) => {
        try {
          const event = JSON.parse(message);
          this.handleRedisEvent(event);
        } catch (err) {
          log('error', 'Erro ao processar evento Redis:', err);
        }
      });

      // Subscreve a eventos de pagamento
      await this.subscriber.subscribe('payment:events', (message: string) => {
        try {
          const event = JSON.parse(message);
          if (event.type === 'PAYMENT_CONFIRMED') {
            const { transactionId, externalId, ...rest } = event.payload;
            
            // Notifica usando o ID da Misticpay (transactionId)
            if (transactionId) {
              this.paymentManager.notifyPaymentConfirmed(transactionId.toString(), rest);
            }
            
            // Notifica usando o nosso ID (externalId) caso o front esteja assistindo ele
            if (externalId && externalId !== transactionId) {
              this.paymentManager.notifyPaymentConfirmed(externalId.toString(), rest);
            }
          }
        } catch (err) {
          log('error', 'Erro ao processar evento de pagamento Redis:', err);
        }
      });
      
      log('info', '📡 Redis Subscriber conectado (social:events, payment:events)');
    } catch (err) {
      log('error', '❌ Falha ao configurar Redis Subscriber:', err);
    }
  }

  /**
   * Processar eventos vindos do Redis (API Next.js -> WebSocket)
   */
  private handleRedisEvent(event: { type: string, payload: any }) {
    log('debug', `Evento Redis recebido: ${event.type}`, event.payload);

    if (event.type === 'TOURNAMENT_INVITE_RECEIVED') {
      const { targetOidUser } = event.payload;
      const client = this.clients.get(targetOidUser);
      
      if (client && client.readyState === WebSocket.OPEN) {
        log('info', `Encaminhando convite de torneio para ${targetOidUser}`);
        this.sendMessage(client, {
          type: 'TOURNAMENT_INVITE_RECEIVED',
          payload: event.payload
        });
      } else {
        log('debug', `Alvo ${targetOidUser} offline, convite nao entregue em tempo real.`);
      }
    }

    if (event.type === 'TOURNAMENT_INVITE_REMOVED') {
      const { targetOidUser } = event.payload;
      const client = this.clients.get(targetOidUser);
      
      if (client && client.readyState === WebSocket.OPEN) {
        log('info', `Notificando remocao de convite para ${targetOidUser}`);
        this.sendMessage(client, {
          type: 'TOURNAMENT_INVITE_REMOVED',
          payload: event.payload
        });
      }
    }

    if (event.type === 'USER_NOTIFICATION') {
      const { targetOidUser } = event.payload;
      const client = this.clients.get(Number(targetOidUser));
      
      if (client && client.readyState === WebSocket.OPEN) {
        log('info', `Encaminhando notificacao global para ${targetOidUser}`);
        this.sendMessage(client, {
          type: 'NOTIFICATION_RECEIVED',
          payload: event.payload
        });
      }
    }
  }

  /**
   * Iniciar o servidor e escutar na porta
   */
  public listen(port: number | string): void {
    this.httpServer.listen(port, () => {
      log('info', `Servidor Social escutando na porta ${port}`);
    });
  }

  /**
   * Configurar servidor WebSocket
   */
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: AuthenticatedWebSocket) => {
      log('debug', 'Nova conexao WebSocket');

      ws.isAlive = true;

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (data: Buffer) => {
        this.handleMessage(ws, data);
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        log('error', 'Erro no WebSocket', error);
      });

      // Solicita autenticacao
      this.sendMessage(ws, {
        type: 'AUTH_REQUIRED',
        payload: { message: 'Envie AUTH com oidUser e token' }
      });
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((client) => {
        const socket = client as AuthenticatedWebSocket;
        if (socket.isAlive === false) {
          log('warn', `Encerrando conexao inativa (${socket.oidUser ?? 'unknown'})`);
          socket.terminate();
          return;
        }

        socket.isAlive = false;
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.ping();
            
            // Renovar presenca no Redis
            if (socket.oidUser) {
              this.redis.setEx(`ws:presence:${socket.oidUser}`, 60, '1').catch(err => {
                log('error', `Erro ao renovar presenca para ${socket.oidUser}`, err);
              });
            }
          } catch (error) {
            log('warn', 'Falha ao enviar ping para cliente', error);
          }
        }
      });
    }, 30000);
  }

  /**
   * Processar mensagem recebida
   */
  private async handleMessage(ws: AuthenticatedWebSocket, data: Buffer): Promise<void> {
    try {
      const message: WSMessage = JSON.parse(data.toString());
      const payload = message.payload || (message as any).data;
      log('debug', `Mensagem: ${message.type}`, { data: payload });

      switch (message.type) {
        case 'AUTH':
          await this.handleAuth(ws, payload);
          break;

        case 'HEARTBEAT':
          ws.isAlive = true;
          this.sendMessage(ws, { type: 'PONG' });
          
          // Renovar presenca no Redis ao receber heartbeat
          if (ws.oidUser) {
            this.redis.setEx(`ws:presence:${ws.oidUser}`, 60, '1').catch(() => {});
          }
          break;

        // === FRIENDS ===
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

        // === QUARTET ===
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

        // === PARTY ===
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

        // === TOURNAMENT ===
        case 'TOURNAMENT_INVITE_SEND':
          await this.handleTournamentInviteSend(ws, payload);
          break;
        case 'TOURNAMENT_INVITE_ACCEPT':
          await this.handleTournamentInviteAccept(ws, payload);
          break;
        case 'TOURNAMENT_INVITE_REJECT':
          await this.handleTournamentInviteReject(ws, payload);
          break;
        case 'TOURNAMENT_INVITE_REMOVE':
          await this.handleTournamentInviteRemove(ws, payload);
          break;
        case 'TOURNAMENT_INVITE_LIST':
          await this.handleTournamentInviteList(ws);
          break;

        // === PAYMENT ===
        case 'PAYMENT_WATCH':
          if (payload?.transactionId) {
            this.paymentManager.watchTransaction(ws, payload.transactionId);
          }
          break;

        default:
          log('warn', `Mensagem desconhecida: ${message.type}`);
          this.sendError(ws, 'Tipo de mensagem invalido');
      }
    } catch (error) {
      log('error', 'Erro ao processar mensagem', error);
      this.sendMessage(ws, {
        type: 'ERROR',
        payload: {
          reason: 'SERVICE_UNAVAILABLE',
          message: 'Servidor indisponivel. Tente novamente em instantes.'
        }
      });
    }
  }

  /**
   * AUTH - Autenticacao do jogador
   * IMPORTANTE: Implementa TAB REPLACEMENT - nova conexao substitui a anterior
   */
  private async handleAuth(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    const { oidUser, token, username, tabId } = payload;

    const incomingSocket: any = (ws as any)._socket;
    log(
      'debug',
      `[AUTH] received oidUser=${oidUser} remote=${incomingSocket?.remoteAddress ?? 'unknown'}:${incomingSocket?.remotePort ?? 'n/a'}`
    );

    if (!oidUser || !token) {
      this.sendMessage(ws, {
        type: 'AUTH_FAILED',
        payload: { message: 'oidUser e token obrigatorios' }
      });
      return ws.close();
    }

    // Validar token
    const numericOidUser = Number(oidUser);
    const tokenValidation = await this.validateAuthToken({ token, oidUser: numericOidUser });
    if (!tokenValidation.valid) {
      log('warn', `Token invalido para oidUser=${oidUser} (${tokenValidation.reason || 'UNKNOWN'})`);
      this.sendMessage(ws, {
        type: 'AUTH_FAILED',
        payload: {
          reason: tokenValidation.reason || 'INVALID_TOKEN',
          message: 'Reautentique-se para continuar.'
        }
      });
      return ws.close();
    }

    // TAB REPLACEMENT: Se ja existe conexao, fechar a antiga e usar a nova
    const existingConnection = this.clients.get(numericOidUser);
    if (existingConnection && existingConnection.readyState === WebSocket.OPEN) {
      // Verifica se é a mesma aba reconectando
      if (existingConnection.tabId && tabId && existingConnection.tabId === tabId) {
        log('info', `[RECONNECT] Mesma aba reconectando para oidUser=${numericOidUser} (tabId=${tabId})`);
        existingConnection.close();
      } else {
        log('info', `[TAB_REPLACEMENT] Substituindo conexao antiga de oidUser=${numericOidUser}`);

        // Notificar a aba antiga que ela foi substituida
        this.sendMessage(existingConnection, {
          type: 'SESSION_REPLACED',
          payload: {
            message: 'Sua sessao foi substituida por uma nova aba/janela.',
            reason: 'NEW_TAB_OPENED'
          }
        });

        // Fechar a conexao antiga
        existingConnection.close();
      }
    }

    ws.oidUser = numericOidUser;
    ws.tabId = tabId;

    // Busca NickName real do banco de dados
    try {
      const user = await prismaGame.$queryRaw<any[]>`
        SELECT NickName FROM CBT_User WHERE oiduser = ${numericOidUser}
      `;

      if (user && user.length > 0 && user[0].NickName) {
        ws.username = user[0].NickName;
        log('debug', `Username validado do banco: ${ws.username}`);
      } else {
        log('warn', `NickName nao encontrado no banco para ${numericOidUser}, usando fallback`);
        ws.username = username || `Player${numericOidUser}`;
      }
    } catch (error) {
      log('warn', `Erro ao buscar NickName do banco para ${numericOidUser}, usando fallback:`, error);
      ws.username = username || `Player${numericOidUser}`;
    }

    this.clients.set(numericOidUser, ws);
    console.log(`[AUTH-DEBUG] Cliente registrado no Map: Key=${numericOidUser} (Type: ${typeof numericOidUser}) | Total Clients: ${this.clients.size}`);
    log('info', `${ws.username} (${numericOidUser}) autenticado. Conexoes ativas: ${this.clients.size}`);

    // Registrar presenca no Redis
    await this.redis.setEx(`ws:presence:${numericOidUser}`, 60, '1').catch(err => {
      log('error', `Erro ao registrar presenca para ${numericOidUser}`, err);
    });

    this.sendMessage(ws, {
      type: 'AUTH_SUCCESS',
      payload: { oidUser: numericOidUser, username: ws.username }
    });

    // Reenvia estado de party (suporte a F5/reconexao)
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
  }

  /**
   * Validar token de autenticacao
   */
  private async validateAuthToken(params: TokenValidationParams): Promise<TokenValidationResult> {
    const { token, oidUser } = params;

    try {
      // Token eh gerado pelo Next.js e armazenado no Redis
      const storedToken = await this.redis.get(`ws:token:${oidUser}`);

      
      if (!storedToken) {
        return { valid: false, reason: 'TOKEN_NOT_FOUND' };
      }
      
      if (storedToken !== token) {
        return { valid: false, reason: 'TOKEN_MISMATCH' };
      }

      return { valid: true };
    } catch (error) {
      log('error', 'Erro ao validar token:', error);
      return { valid: false, reason: 'VALIDATION_ERROR' };
    }
  }

  /**
   * Tratar desconexao
   */
  private handleDisconnect(ws: AuthenticatedWebSocket): void {
    if (ws.oidUser) {
      // So remove do Map se a conexao atual for a mesma registrada
      const currentConnection = this.clients.get(ws.oidUser);
      if (currentConnection === ws) {
        this.clients.delete(ws.oidUser);
        log('info', `${ws.username || ws.oidUser} desconectado. Conexoes ativas: ${this.clients.size}`);
        
        // Remover presenca do Redis
        this.redis.del(`ws:presence:${ws.oidUser}`).catch(() => {});
      } else {
        log('debug', `Conexao antiga de ${ws.oidUser} fechada (ja foi substituida)`);
      }
    }
  }

  // =========================
  // FRIEND HANDLERS
  // =========================

  private async handleFriendSend(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
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

  // =========================
  // QUARTET HANDLERS
  // =========================

  private async handleQuartetInviteSend(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;
    const targetOidUser = await this.resolveTargetUserIdByNickname(payload);
    if (!targetOidUser) {
      return this.sendError(ws, 'TARGET_REQUIRED');
    }

    const rawTargetPos = Number(payload?.targetPos);

    // Validacao: targetPos eh OBRIGATORIO e deve ser 1, 2 ou 3
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

    // Evita convites duplicados
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

    // Se ja estiver em outra party, remove antes
    const existing = await this.partyManager.getPartyIdByPlayer(ws.oidUser);
    if (existing && existing !== partyId) {
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
      const current = await this.partyManager.getParty(partyId);
      if (current) {
        this.sendMessage(ws, { type: 'PARTY_UPDATED', payload: { party: current } });
      }
      return;
    }

    const party = await this.partyManager.addMember(partyId, ws.oidUser);
    if (!party) {
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'PARTY_NOT_FOUND' } });
    }
    if (party.members.length > 2) {
      await this.partyManager.removeMember(partyId, ws.oidUser);
      return this.sendMessage(ws, { type: 'PARTY_ERROR', payload: { reason: 'PARTY_FULL' } });
    }

    // Limpa chave de convite apos aceitar
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

    // Limpa o par de convite
    try {
      const a = Math.min(inviterOidUser, ws.oidUser);
      const b = Math.max(inviterOidUser, ws.oidUser);
      await this.redis.del(`party:invitepair:${a}:${b}`);
    } catch (err) {
      log('warn', `Falha ao limpar par de convite ao recusar (${inviterOidUser}, ${ws.oidUser})`, err);
    }

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

    await this.clearPartyInvitesForUser(ws.oidUser);
    await this.removeFromPartyAndNotify(partyId, ws.oidUser, 'left');
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

    // Limpa o par de convite
    try {
      const a = Math.min(ws.oidUser, targetOidUser);
      const b = Math.max(ws.oidUser, targetOidUser);
      await this.redis.del(`party:invitepair:${a}:${b}`);
    } catch (err) {
      log('warn', `Falha ao limpar par de convite ao kick (${ws.oidUser}, ${targetOidUser})`, err);
    }

    this.sendMessage(ws, { type: 'PARTY_KICKED', payload: { oidUser: targetOidUser } });
    await this.removeFromPartyAndNotify(partyId, targetOidUser, 'kicked', ws.oidUser);
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

  // =========================
  // TOURNAMENT HANDLERS
  // =========================

  private async handleTournamentInviteSend(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;

    const { tournamentId, targetNickname, position } = payload;

    if (!tournamentId || !targetNickname || !position) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: 'MISSING_PARAMS' }
      });
    }

    const result = await this.tournamentInviteManager.sendInvite(
      ws.oidUser,
      Number(tournamentId),
      String(targetNickname).trim(),
      Number(position)
    );

    if (!result.ok) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: result.reason }
      });
    }

    // Notificar o líder que o convite foi enviado
    this.sendMessage(ws, {
      type: 'TOURNAMENT_INVITE_SENT',
      payload: {
        inviteId: result.inviteId,
        inscricaoId: result.inscricaoId,
        targetNickname,
        position
      }
    });

    // Buscar dados completos do convite para notificar o target
    const inviteData = await this.tournamentInviteManager.getInviteData(result.inviteId!);
    if (!inviteData) return;

    // Notificar o target via WebSocket (se estiver online)
    const targetOidUser = inviteData.oidUser;
    const targetClient = this.clients.get(targetOidUser);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
      this.sendMessage(targetClient, {
        type: 'TOURNAMENT_INVITE_RECEIVED',
        payload: {
          inviteId: inviteData.inviteId,
          tournamentId: inviteData.tournamentId,
          tournamentName: inviteData.tournamentName,
          inscricaoId: inviteData.inscricaoId,
          leaderOidUser: inviteData.leaderOidUser,
          leaderNickname: inviteData.leaderNickname,
          position: inviteData.position
        }
      });
    }
  }

  private async handleTournamentInviteAccept(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;

    const inviteId = Number(payload?.inviteId);
    if (!inviteId) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: 'INVITE_ID_REQUIRED' }
      });
    }

    // Buscar dados do convite antes de aceitar (para notificar o líder)
    const inviteData = await this.tournamentInviteManager.getInviteData(inviteId);
    if (!inviteData) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: 'INVITE_NOT_FOUND' }
      });
    }

    const result = await this.tournamentInviteManager.acceptInvite(inviteId, ws.oidUser);

    if (!result.ok) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: result.reason }
      });
    }

    // Notificar o jogador que aceitou
    this.sendMessage(ws, {
      type: 'TOURNAMENT_INVITE_RESPONSE_SENT',
      payload: { inviteId, accepted: true }
    });

    // Notificar o líder que o convite foi aceito
    const leaderClient = this.clients.get(inviteData.leaderOidUser);
    if (leaderClient && leaderClient.readyState === WebSocket.OPEN) {
      this.sendMessage(leaderClient, {
        type: 'TOURNAMENT_INVITE_ACCEPTED',
        payload: {
          inviteId,
          position: inviteData.position,
          playerNickname: inviteData.nickname,
          playerOidUser: inviteData.oidUser
        }
      });
    }
  }

  private async handleTournamentInviteReject(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;

    const inviteId = Number(payload?.inviteId);
    if (!inviteId) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: 'INVITE_ID_REQUIRED' }
      });
    }

    // Buscar dados do convite antes de recusar (para notificar o líder)
    const inviteData = await this.tournamentInviteManager.getInviteData(inviteId);
    if (!inviteData) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: 'INVITE_NOT_FOUND' }
      });
    }

    const result = await this.tournamentInviteManager.rejectInvite(inviteId, ws.oidUser);

    if (!result.ok) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: result.reason }
      });
    }

    // Notificar o jogador que recusou
    this.sendMessage(ws, {
      type: 'TOURNAMENT_INVITE_RESPONSE_SENT',
      payload: { inviteId, accepted: false }
    });

    // Notificar o líder que o convite foi recusado
    const leaderClient = this.clients.get(inviteData.leaderOidUser);
    if (leaderClient && leaderClient.readyState === WebSocket.OPEN) {
      this.sendMessage(leaderClient, {
        type: 'TOURNAMENT_INVITE_REJECTED',
        payload: {
          inviteId,
          position: inviteData.position,
          playerNickname: inviteData.nickname,
          playerOidUser: inviteData.oidUser
        }
      });
    }
  }

  private async handleTournamentInviteRemove(ws: AuthenticatedWebSocket, payload: any): Promise<void> {
    if (!ws.oidUser) return;

    const inviteId = Number(payload?.inviteId);
    if (!inviteId) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: 'INVITE_ID_REQUIRED' }
      });
    }

    // Buscar dados do convite antes de remover (para notificar o target)
    const inviteData = await this.tournamentInviteManager.getInviteData(inviteId);

    const result = await this.tournamentInviteManager.removeInvite(inviteId, ws.oidUser);

    if (!result.ok) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: result.reason }
      });
    }

    // Notificar o líder que o convite foi removido
    this.sendMessage(ws, {
      type: 'TOURNAMENT_INVITE_REMOVE_SUCCESS',
      payload: { inviteId, position: inviteData?.position }
    });

    // Notificar o target que o convite foi removido (se estiver online)
    if (result.targetOidUser) {
      const targetClient = this.clients.get(result.targetOidUser);
      if (targetClient && targetClient.readyState === WebSocket.OPEN) {
        this.sendMessage(targetClient, {
          type: 'TOURNAMENT_INVITE_REMOVED',
          payload: {
            inviteId,
            tournamentId: inviteData?.tournamentId,
            tournamentName: inviteData?.tournamentName
          }
        });
      }
    }
  }

  private async handleTournamentInviteList(ws: AuthenticatedWebSocket): Promise<void> {
    if (!ws.oidUser) {
      return this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: 'NOT_AUTHENTICATED' }
      });
    }

    try {
      const invites = await this.tournamentInviteManager.getPendingInvites(ws.oidUser);
      this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_LIST',
        payload: { invites }
      });
    } catch (err) {
      log('error', `Erro ao listar convites de torneio para ${ws.oidUser}:`, err);
      this.sendMessage(ws, {
        type: 'TOURNAMENT_INVITE_ERROR',
        payload: { reason: 'INTERNAL_ERROR' }
      });
    }
  }

  // =========================
  // UTILITY METHODS
  // =========================

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

  private async clearPartyInvitesForUser(userId: number): Promise<void> {
    try {
      for await (const key of this.redis.scanIterator({ MATCH: 'party:invitepair:*', COUNT: 100 })) {
        const parts = String(key).split(':');
        const ids = parts.slice(-2).map((p) => Number(p));
        if (ids.some((id) => id === userId)) {
          try {
            await this.redis.del(String(key));
          } catch (err) {
            log('warn', `Falha ao remover chave de convite ${key} para usuario ${userId}`, err);
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

  private async removeFromPartyAndNotify(
    partyId: string,
    removedOidUser: number,
    reason: 'left' | 'kicked' | 'disbanded',
    kickerOidUser?: number
  ): Promise<void> {
    const party = await this.partyManager.getParty(partyId);
    if (!party) return;

    // Se o lider saiu, disbanda a party
    if (party.leaderId === removedOidUser) {
      for (const memberId of party.members) {
        this.sendToPlayer(memberId, {
          type: 'PARTY_DISBANDED',
          payload: { partyId, reason: 'leader_left' }
        });
      }
      await this.partyManager.deleteParty(partyId);
      return;
    }

    // Remove o membro
    const updatedParty = await this.partyManager.removeMember(partyId, removedOidUser);

    // Notifica o removido
    const removedClient = this.clients.get(removedOidUser);
    if (removedClient && removedClient.readyState === WebSocket.OPEN) {
      if (reason === 'kicked') {
        this.sendMessage(removedClient, {
          type: 'PARTY_YOU_WERE_KICKED',
          payload: { partyId, kickerOidUser }
        });
      } else {
        this.sendMessage(removedClient, { type: 'PARTY_LEFT', payload: { partyId } });
      }
    }

    // Notifica os membros restantes
    if (updatedParty) {
      this.broadcastPartyUpdate(updatedParty);
    }
  }

  private sendToPlayer(oidUser: number, message: WSMessage): void {
    const client = this.clients.get(oidUser);
    if (client && client.readyState === WebSocket.OPEN) {
      this.sendMessage(client, message);
    }
  }

  private sendMessage(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    this.sendMessage(ws, {
      type: 'ERROR',
      payload: { message }
    });
  }
}

// =========================
// INICIALIZACAO
// =========================
import 'dotenv/config';
import { connectDatabase } from './database/prisma';

const PORT = process.env.PORT || 3001;

async function main() {
  try {
    // Conectar ao banco de dados
    await connectDatabase();

    // Iniciar servidor
    const server = new SocialWebSocketServer();
    server.listen(PORT);

    log('info', `Social WebSocket Server iniciado na porta ${PORT}`);
  } catch (error) {
    log('error', 'Falha ao iniciar servidor:', error);
    process.exit(1);
  }
}

main();
