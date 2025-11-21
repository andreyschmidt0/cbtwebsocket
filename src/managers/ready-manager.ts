import { WebSocket } from 'ws'
import { getRedisClient } from '../database/redis-client'
import { prismaRanked } from '../database/prisma'
import { log } from '../utils/logger'
import { ReadyPlayer } from '../types'

interface ReadyCheck {
  matchId: string
  players: Map<number, ReadyPlayer>
  timeout: NodeJS.Timeout
  startedAt: number
  expiresAt: number
  status?: 'PENDING' | 'COMPLETING'
}

export class ReadyManager {
  private activeChecks: Map<string, ReadyCheck> = new Map()
  private redis: ReturnType<typeof getRedisClient>
  private readonly READY_TIMEOUT = 20000 // 20 segundos (conforme documentação)

  // --- CORREÇÃO 1: Atualizar a assinatura do callback ---
  private onReadyCompleteCallback?: (matchId: string, lobbyData: any) => void
  private onReadyFailedCallback?: (
    matchId: string,
    reason: string,
    causeOidUser: number,
    acceptedPlayers: ReadyPlayer[],
    allPlayerIds: number[]
  ) => void
  private onReadyUpdateCallback?: (matchId: string, readyCount: number, totalPlayers: number, playerIds: number[]) => void

  constructor() {
    this.redis = getRedisClient()
    log('info', 'ReadyManager: Usando Redis singleton')
  }

  // Registrar callbacks
  onReadyComplete(callback: (matchId: string, lobbyData: any) => void): void { // <-- CORREÇÃO 1
    this.onReadyCompleteCallback = callback
  }

  onReadyFailed(callback: (
    matchId: string,
    reason: string,
    causeOidUser: number,
    acceptedPlayers: ReadyPlayer[],
    allPlayerIds: number[]
  ) => void): void {
    this.onReadyFailedCallback = callback
  }

  onReadyUpdate(callback: (matchId: string, readyCount: number, totalPlayers: number, playerIds: number[]) => void): void {
    this.onReadyUpdateCallback = callback
  }

  // Iniciar ready check (Redis-first)
  async startReadyCheck(matchId: string, playerIds: number[]): Promise<void> {
    const now = Date.now()
    const expiresAt = now + this.READY_TIMEOUT

    const playerMap = new Map<number, ReadyPlayer>()
    playerIds.forEach(oidUser => {
      playerMap.set(oidUser, {
        oidUser,
        username: `Player${oidUser}`,
        ws: null as any,
        team: 'UNKNOWN',
        status: 'PENDING'
      })
    })

    const timeout = setTimeout(() => {
      this.handleTimeout(matchId)
    }, this.READY_TIMEOUT)

    this.activeChecks.set(matchId, { matchId, players: playerMap, timeout, startedAt: now, expiresAt, status: 'PENDING' })

    const redisKey = `match:${matchId}:ready`
    const pipeline = this.redis.multi()
    for (const oidUser of playerIds) {
      pipeline.hSet(redisKey, oidUser.toString(), 'PENDING')
    }
    pipeline.hSet(redisKey, '_startedAt', now.toString())
    pipeline.hSet(redisKey, '_expiresAt', expiresAt.toString())
    pipeline.hSet(redisKey, '_totalPlayers', playerIds.length.toString())
    pipeline.expire(redisKey, 120)
    await pipeline.exec()

    log('info', `Ready check iniciado para match ${matchId} (${playerIds.length} jogadores, 20s) [REDIS]`)
  }

  // Jogador confirma ready
async handleReady(matchId: string, oidUser: number): Promise<void> {
    const check = this.activeChecks.get(matchId)

    // --- CADEADO (Lock) ---
    // Se o check não existe, OU se ele já está sendo completado, ignora
    if (!check || check.status === 'COMPLETING') {
      return
    }
    // --- FIM DO CADEADO ---

    const player = check.players.get(oidUser)
    if (!player) {
      log('warn', `Jogador ${oidUser} não está no match ${matchId}`)
      return
    }

    // Só atualiza se o status for PENDING
    if (player.status === 'PENDING') {
        player.status = 'READY'
        const redisKey = `match:${matchId}:ready`
        await this.redis.hSet(redisKey, oidUser.toString(), 'READY')

        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
          player.ws.send(JSON.stringify({ type: 'READY_CONFIRMED', matchId }))
        }

        const readyCount = Array.from(check.players.values()).filter(p => p.status === 'READY').length
        const totalPlayers = check.players.size
        log('info', `${player.username || `Player ${oidUser}`} aceitou (${readyCount}/${totalPlayers}) [REDIS]`)
        this.broadcastReadyStatus(check, readyCount, totalPlayers)

        if (readyCount === totalPlayers) {
            // --- CADEADO (Lock) ---
            // Verifica novamente o status para garantir que só execute UMA VEZ
            if (check.status === 'PENDING') {
              check.status = 'COMPLETING' // Define o "cadeado"
              await this.handleAllReady(matchId)
            }
            // --- FIM DO CADEADO ---
        }
    }
  }

  // Força cancelamento (quando alguém recusa)
  async forceCancel(matchId: string, reason: string, causeOidUser?: number): Promise<void> {
    const check = this.activeChecks.get(matchId)
    if (!check) return

    log('info', `Match ${matchId} cancelado à força. Razão: ${reason}`)
    const causer = causeOidUser ? check.players.get(causeOidUser) : undefined
    if (causer) causer.status = 'DECLINED'

    await this.cancelMatch(matchId, causeOidUser || -1, reason)
  }

  // Jogador recusa ready
  async handleDecline(matchId: string, oidUser: number): Promise<void> {
    const check = this.activeChecks.get(matchId)
    if (!check) return

    const player = check.players.get(oidUser)
    if (!player) return

    player.status = 'DECLINED'
    log('info', `${player.username} recusou o match ${matchId}`)

    await this.forceCancel(matchId, 'PLAYER_DECLINED', oidUser)
  }

  // Timeout do ready (20s)
  private async handleTimeout(matchId: string): Promise<void> {
    const check = this.activeChecks.get(matchId)
    if (!check) return

    const notReady = Array.from(check.players.values()).filter(p => p.status !== 'READY')
    if (notReady.length > 0) {
      log('info', `Timeout do match ${matchId} - ${notReady.length} jogador(es) não aceitaram`)
      await this.cancelMatch(matchId, notReady[0].oidUser, 'TIMEOUT')
    }
  }

  // Todos aceitaram: persiste e inicia próxima fase
  private async handleAllReady(matchId: string): Promise<void> {
    const check = this.activeChecks.get(matchId)
    if (!check) return

    clearTimeout(check.timeout)

    // --- CORREÇÃO 2: Garantir que 'lobbyData' e 'lobby' estão definidos ---
    const lobbyData = await this.redis.get(`lobby:temp:${matchId}`)
    if (!lobbyData) {
      log('error', `Lobby temporária ${matchId} não encontrada no Redis`)
      // Se a lobby sumiu, não podemos continuar. Cancelamos.
      await this.cancelMatch(matchId, -1, 'LOBBY_DATA_EXPIRED')
      return
    }
    
    // 'lobby' é necessário para o callback
    const lobby = JSON.parse(lobbyData)

    await prismaRanked.$executeRaw`
      INSERT INTO BST_RankedMatch (id, lobbyId, gameMode, map, maxPlayers, startedAt, status, createdAt)
      VALUES (${matchId}, ${matchId}, 'ranked', 'TBD', 10, GETDATE(), 'ready', GETDATE())
    `

    log('info', `Todos aceitaram! Match ${matchId} (BST_RankedMatch) criado. BST_MatchPlayer será preenchido no final.`)

    // Nós *lemos* o lobby:temp, mas só o deletamos *depois* do ValidationManager
    // await this.redis.del(`lobby:temp:${matchId}`) // <-- MOVIDO para ValidationManager
    await this.redis.del(`match:${matchId}:ready`)
    this.activeChecks.delete(matchId)

    // Passa o 'lobby' (que contém os dados dos jogadores) para o próximo passo
    if (this.onReadyCompleteCallback) this.onReadyCompleteCallback(matchId, lobby)
  }

  // Cancelar match (recusa/timeout)
  private async cancelMatch(matchId: string, causeOidUser: number, reason: string): Promise<void> {
    const check = this.activeChecks.get(matchId)
    if (!check) return

    clearTimeout(check.timeout)

    // captura ids antes de limpar
    const allPlayerIds = Array.from(check.players.keys())

    const redisKey = `match:${matchId}:ready`
    await this.redis.del(`lobby:temp:${matchId}`)
    await this.redis.del(redisKey)

    const acceptedPlayers = Array.from(check.players.values()).filter(p => p.status === 'READY')
    log('info', `Match ${matchId} cancelado (${reason}) - dados Redis deletados`)

    this.activeChecks.delete(matchId)

    if (this.onReadyFailedCallback) {
      this.onReadyFailedCallback(matchId, reason, causeOidUser, acceptedPlayers, allPlayerIds)
    }
  }

  // Broadcast status do ready
  private broadcastReadyStatus(check: ReadyCheck, readyCount: number, totalPlayers: number): void {
    if (this.onReadyUpdateCallback) {
      const playerIds = Array.from(check.players.keys())
      this.onReadyUpdateCallback(check.matchId, readyCount, totalPlayers, playerIds)
    }
  }

  getActiveCheck(matchId: string): ReadyCheck | undefined {
    return this.activeChecks.get(matchId)
  }

  findMatchIdByPlayer(oidUser: number): string | undefined {
    for (const [matchId, check] of this.activeChecks.entries()) {
      if (check.players.has(oidUser)) {
        return matchId
      }
    }
    return undefined
  }

  isInReadyCheck(matchId: string): boolean {
    return this.activeChecks.has(matchId)
  }

  async clearAllChecks(): Promise<void> {
    for (const [mid, check] of this.activeChecks.entries()) {
      clearTimeout(check.timeout)
      await this.redis.del(`match:${mid}:ready`)
    }
    this.activeChecks.clear()
    log('info', 'Todos os ready checks limpos')
  }
}
