import { WebSocket } from 'ws'
import { getRedisClient } from '../database/redis-client'
import { log } from '../utils/logger'
import { prismaRanked } from '../database/prisma'

export interface HostPlayer {
  oidUser: number
  username: string
  ws: WebSocket | null
  mmr: number
}

interface HostAttempt {
  matchId: string
  players: HostPlayer[]
  currentHostIndex: number
  timeout: NodeJS.Timeout
  startedAt: number
  expiresAt: number
}

export class HOSTManager {
  private activeHosts: Map<string, HostAttempt> = new Map()
  private redis = getRedisClient()
  private readonly HOST_TIMEOUT = 120000 // 2 min
  private readonly HOST_COOLDOWN_SECONDS = 300 // 5 minutos

  private onHostSelectedCallback?: (matchId: string, hostOidUser: number, hostUsername: string, mapNumber: number) => void
  private onRoomConfirmedCallback?: (matchId: string, roomId: number, mapNumber: number) => void
  private onHostAbortedCallback?: (matchId: string, hostOidUser: number, reason: string, playerIds: number[]) => void

  constructor() {
    log('info', 'HOSTManager: usando Redis singleton')
  }

  // Callbacks
  onHostSelected(cb: (matchId: string, hostOidUser: number, hostUsername: string, mapNumber: number) => void): void {
    this.onHostSelectedCallback = cb
  }

  onRoomConfirmed(cb: (matchId: string, roomId: number, mapNumber: number) => void): void {
    this.onRoomConfirmedCallback = cb
  }

  onHostAborted(cb: (matchId: string, hostOidUser: number, reason: string, playerIds: number[]) => void): void {
    this.onHostAbortedCallback = cb
  }

  // Inicia seleção do HOST
  async startHostSelection(matchId: string, players: HostPlayer[], mapNumber: number): Promise<void> {
    // Caso o callback seja disparado novamente para o mesmo match (ex: mapa reemitido),
    // limpamos o timer anterior para garantir os 120s completos a partir deste ciclo.
    const previousAttempt = this.activeHosts.get(matchId)
    if (previousAttempt) {
      clearTimeout(previousAttempt.timeout)
      this.activeHosts.delete(matchId)
      log('warn', `Iniciando nova seleção de HOST para ${matchId}. Timer anterior descartado.`)
    }

    // Gera senha aleatória de 4 dígitos
    await this.redis.set(`match:${matchId}:hostPassword`, Math.floor(1000 + Math.random() * 9000).toString(), { EX: 7200 });
    const sorted = [...players].sort((a, b) => b.mmr - a.mmr)

    let hostPlayer: HostPlayer | undefined
    for (const candidate of sorted) {
      const inCooldown = await this.isHostInCooldown(candidate.oidUser)
      if (inCooldown) {
        log('warn', `Pulando ${candidate.username} como HOST (cooldown ativo)`)
        continue
      }
      hostPlayer = candidate
      break
    }

    if (!hostPlayer) {
      hostPlayer = sorted[0]
      log('warn', 'Todos os jogadores estão em cooldown de HOST. Selecionando mesmo assim.')
    }

    // --- GARANTA QUE ESTE BLOCO ESTÁ AQUI ---
    if (hostPlayer) {
      try {
        await prismaRanked.$executeRaw`
          UPDATE BST_RankedMatch
          SET hostOidUser = ${hostPlayer.oidUser}
          WHERE id = ${matchId} AND status = 'ready'
        `;
      } catch (error) {
        log('error', `Falha ao salvar hostOidUser ${hostPlayer.oidUser} no BST_RankedMatch ${matchId}`, error);
      }
    } else {
      log('error', `Nenhum hostPlayer encontrado para match ${matchId}`);
      return;
    }
    // --- FIM DO BLOCO ---

    // Timeout para criar sala
    const timeout = setTimeout(() => {
      this.handleHostTimeout(matchId).catch(() => {});
    }, this.HOST_TIMEOUT);

    const attempt: HostAttempt = {
      matchId,
      players: sorted,
      currentHostIndex: 0,
      timeout,
      startedAt: Date.now(),
      expiresAt: Date.now() + this.HOST_TIMEOUT,
    };
    this.activeHosts.set(matchId, attempt);

    // Salva estado mínimo no Redis (limpo no abort)
    await this.redis.set(`match:${matchId}:status`, 'awaiting-host', { EX: 7200 });

    // Gera roomId e salva junto com mapNumber
    const roomId = await this.generateRoomId(matchId);
    await this.redis.set(`match:${matchId}:room`, JSON.stringify({ roomId, mapNumber }), { EX: 7200 });
    await this.redis.set(
      `match:${matchId}:host`,
      JSON.stringify({ hostOidUser: hostPlayer.oidUser, hostUsername: hostPlayer.username, startedAt: attempt.startedAt, expiresAt: attempt.expiresAt }),
      { EX: 300 }
    );

    log('info', `HOST selecionado: ${hostPlayer.username} (match ${matchId}, sala ${roomId}, mapa ${mapNumber})`);

    if (this.onHostSelectedCallback) {
      this.onHostSelectedCallback(matchId, hostPlayer.oidUser, hostPlayer.username, roomId); // Passa o ID da SALA
    }

    if (hostPlayer.ws && hostPlayer.ws.readyState === WebSocket.OPEN) {
      // Recupera senha para enviar ao host
      const hostPassword = await this.redis.get(`match:${matchId}:hostPassword`);
      hostPlayer.ws.send(JSON.stringify({
        type: 'HOST_SELECTED',
        matchId,
        message: 'Você foi selecionado como HOST! Crie a sala no jogo.',
        timeout: 120,
        roomId: roomId,
        password: hostPassword,
      }));
    }
    for (const p of sorted) {
      if (p.oidUser === hostPlayer.oidUser) continue;
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({ type: 'HOST_WAITING', matchId, hostUsername: hostPlayer.username }));
      }
    }
  }

// Em src/managers/host-manager.ts
  async confirmHostRoom(matchId: string, oidUser: number, roomId: number, mapNumber: number): Promise<void> {
    const attempt = this.activeHosts.get(matchId)
    if (!attempt) return
    const host = attempt.players[attempt.currentHostIndex]
    if (!host || host.oidUser !== oidUser) return

    clearTimeout(attempt.timeout)

    // 1. Atualiza o SQL Server com os dados da sala
    try {
      await prismaRanked.$executeRaw`
        UPDATE BST_RankedMatch
        SET
          roomId = ${roomId},
          mapNumber = ${mapNumber},
          status = 'in-progress'
        WHERE
          id = ${matchId} AND status = 'ready'
      `
    } catch (error) {
      log('error', `Falha ao atualizar BST_RankedMatch ${matchId} com roomId ${roomId}`, error)
      // TODO: Lidar com falha de atualização (embora o fluxo continue via Redis)
    }

    // 2. Atualiza o Redis (como já fazia)
    await this.redis.set(`match:${matchId}:room`, JSON.stringify({ roomId, mapNumber }), { EX: 7200 }) //
    await this.redis.set(`match:${matchId}:status`, 'in-progress', { EX: 7200 }) //
    // --- FIM DA CORREÇÃO ---

    await this.redis.del(`match:${matchId}:host`)
    this.activeHosts.delete(matchId)

    log('info', `Sala confirmada para match ${matchId} (Room ${roomId}, Mapa ${mapNumber})`)
    if (this.onRoomConfirmedCallback) this.onRoomConfirmedCallback(matchId, roomId, mapNumber)
  // Repasse da senha será feito no callback do servidor principal
  }

  // Falha do HOST por ação do cliente
  async abortByClient(matchId: string, hostOidUser: number, reason: string): Promise<void> {
    const attempt = this.activeHosts.get(matchId)
    const playerIds = attempt ? attempt.players.map(p => p.oidUser) : []
    await this.applyHostCooldown(hostOidUser, reason)
    await this.abortAndCleanup(matchId, reason)
    if (this.onHostAbortedCallback) {
      this.onHostAbortedCallback(matchId, hostOidUser, reason, playerIds)
    }
  }

  // Timeout do HOST
  private async handleHostTimeout(matchId: string): Promise<void> {
    const attempt = this.activeHosts.get(matchId)
    if (!attempt) return
    const host = attempt.players[attempt.currentHostIndex]
    const elapsed = Date.now() - attempt.startedAt
    log('warn', `Timeout do HOST ${host?.username} no match ${matchId} (decorrido: ${(elapsed / 1000).toFixed(1)}s)`)
    await this.applyHostCooldown(host?.oidUser || 0, 'TIMEOUT')
    await this.abortAndCleanup(matchId, 'TIMEOUT')
    if (this.onHostAbortedCallback) {
      const ids = attempt.players.map(p => p.oidUser)
      this.onHostAbortedCallback(matchId, host?.oidUser || 0, 'TIMEOUT', ids)
    }
  }

  // Garante sem rotação (API presente, mas cancela)
  async rotateHost(matchId: string): Promise<void> {
    const attempt = this.activeHosts.get(matchId)
    if (!attempt) return
    const host = attempt.players[attempt.currentHostIndex]
    await this.applyHostCooldown(host?.oidUser || 0, 'HOST_FAILED')
    await this.abortAndCleanup(matchId, 'HOST_FAILED')
    if (this.onHostAbortedCallback) {
      const ids = attempt.players.map(p => p.oidUser)
      this.onHostAbortedCallback(matchId, host?.oidUser || 0, 'HOST_FAILED', ids)
    }
  }

  // Cleanup completo (Redis + memória)
  private async abortAndCleanup(matchId: string, reason: string): Promise<void> {
    const attempt = this.activeHosts.get(matchId)
    if (attempt) clearTimeout(attempt.timeout)

    log('warn', `Host abortado para ${matchId} (${reason}). Iniciando cleanup completo (Redis + SQL)...`)

    try {
      await prismaRanked.$executeRaw`
        UPDATE BST_RankedMatch
        SET 
          status = 'cancelled',
          endReason = ${reason},
          endedAt = GETDATE()
        WHERE id = ${matchId}
      `
      // --- Cleanup do Redis (como fizemos antes) ---
      log('debug', `[Cleanup ${matchId}] Deletando chaves do Redis...`)
      await this.redis.del(`match:${matchId}:host`)
      await this.redis.del(`match:${matchId}:status`)
      await this.redis.del(`match:${matchId}:endReason`)
      await this.redis.del(`match:${matchId}:room`)
      await this.redis.del(`match:${matchId}:queueSnapshot`)
      await this.redis.del(`match:${matchId}:classes`)
      await this.redis.del(`lobby:temp:${matchId}`)
      await this.redis.del(`lobby:${matchId}:state`)   // <--- Chave que você encontrou
      await this.redis.del(`lobby:${matchId}:vetos`)   // <--- Chave que você encontrou
      await this.redis.del(`lobby:${matchId}:votes`)
      await this.redis.del(`lobby:${matchId}:selectedMap`)
      await this.redis.del(`match:${matchId}:ready`)

      // Limpa da memória
      this.activeHosts.delete(matchId)
      
      log('warn', `Host abortado para ${matchId} (${reason}) – cleanup concluído`)

    } catch (error) {
      log('error', `Erro durante o cleanup para match ${matchId}`, error)
      // Mesmo com erro, remove da memória para não tentar de novo
      this.activeHosts.delete(matchId)
    }
  }

  // Utilitário: gerar room id (1–9999)
  private async generateRoomId(matchId: string): Promise<number> {
    const ts = Date.now()
    const base = parseInt(ts.toString().slice(-4))
    const roomId = (base % 9000) + 1000
    await this.redis.set(`room:${matchId}`, roomId.toString(), { EX: 7200 })
    return roomId
  }

  // Externos
  getActiveHost(matchId: string): HostAttempt | undefined { return this.activeHosts.get(matchId) }
  isInHostSelection(matchId: string): boolean { return this.activeHosts.has(matchId) }
  findMatchIdByHost(oidUser: number): string | undefined {
    for (const [matchId, attempt] of this.activeHosts.entries()) {
      const currentHost = attempt.players[attempt.currentHostIndex]
      if (currentHost?.oidUser === oidUser) {
        return matchId
      }
    }
    return undefined
  }

  private async isHostInCooldown(oidUser: number): Promise<boolean> {
    if (!oidUser) return false
    try {
      const ttl = await this.redis.ttl(`cooldown:host:${oidUser}`)
      return ttl > 0
    } catch (error) {
      log('warn', `Falha ao consultar cooldown de host para ${oidUser}`, error)
      return false
    }
  }

  private async applyHostCooldown(oidUser: number, reason: string): Promise<void> {
    if (!oidUser) return
    try {
      await this.redis.set(`cooldown:host:${oidUser}`, reason, { EX: this.HOST_COOLDOWN_SECONDS })
      log('warn', `Aplicando cooldown de HOST para ${oidUser} (${reason})`)
    } catch (error) {
      log('warn', `Falha ao aplicar cooldown de host para ${oidUser}`, error)
    }
  }

  async clearAllAttempts(): Promise<void> {
    for (const [mid, attempt] of this.activeHosts.entries()) {
      clearTimeout(attempt.timeout)
      await this.redis.del(`match:${mid}:host`)
      await this.redis.del(`match:${mid}:room`)
    }
    this.activeHosts.clear()
    log('info', 'Todas as tentativas de HOST limpas')
  }
}
