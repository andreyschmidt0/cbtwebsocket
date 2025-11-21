import { getRedisClient, isRedisReady } from '../database/redis-client'
import { prismaRanked, prismaGame } from '../database/prisma'
import { log } from '../utils/logger'
import { calculateRankChanges, RankCalculationPlayerInput, PlayerPenaltyImpact, PlayerRankState } from '../rank/rank-calculator'
import { computeMatchmakingValue, DEFAULT_TIER, getBackgroundIdForTier, RankTier } from '../rank/rank-tiers'
import { Prisma } from '@prisma/client'

interface MatchValidation {
  matchId: string
  mapNumber: number
  startedAt: Date
  lastCheck: Date
  attempts: number
  status: 'monitoring' | 'aggressive' | 'completed'
  expectedPlayers: number[]
}

interface MatchLog {
  oidUser: number
  MapNo: number
  isWin: boolean
  KillCnt: number
  DeadCnt: number
  HeadShotCnt: number
  Assist: number
  Exp: number
  Money: number
  Forfeited: number
  LogDate: Date
  BombsPlanted: number
  BombsDefused: number
}

interface ValidationResult {
  isValid: boolean
  winner: 'ALPHA' | 'BRAVO' | null
  abandonments: number[]
  logs: MatchLog[]
  reason?: string
}

type PlayerPenaltyReason = 'FORFEIT' | 'ZERO_REWARD' | 'NO_LOG'

interface PlayerPenaltyInfo {
  reason: PlayerPenaltyReason
  detectedAt: Date
  lastLogDate?: Date
  evidence?: 'FORFEITED' | 'ZERO_REWARD' | 'NO_LOG'
}

interface ValidationCallbacks {
  onMatchCompleted?: (matchId: string, result: ValidationResult) => Promise<void>
  onMatchTimeout?: (matchId: string) => Promise<void>
  onMatchInvalid?: (matchId: string, reason: string) => Promise<void>
}

function mapPenaltyToImpact(info?: PlayerPenaltyInfo): PlayerPenaltyImpact | undefined {
  if (!info) return undefined
  switch (info.reason) {
    case 'FORFEIT':
      return { points: -25, reason: info.reason }
    case 'ZERO_REWARD':
      return { points: -10, reason: info.reason }
    case 'NO_LOG':
      return { points: -5, reason: info.reason }
    default:
      return undefined
  }
}

/**
 * ValidationManager - Sistema ESCALÁVEL de validação de partidas
 */
export class ValidationManager {
  private activeMatches: Map<string, MatchValidation> = new Map()
  private normalPollingInterval?: NodeJS.Timeout
  private aggressivePollingInterval?: NodeJS.Timeout
  private callbacks: ValidationCallbacks
  private lastGlobalCheck: Date = new Date()
  private redis: ReturnType<typeof getRedisClient>
  private redisAvailable: boolean = false
  private playerPenalties: Map<string, Map<number, PlayerPenaltyInfo>> = new Map()
  private matchLogsCache: Map<string, Map<number, MatchLog>> = new Map()

  // Configurações
  private readonly NORMAL_INTERVAL = 30000 // 30 segundos
  private readonly AGGRESSIVE_INTERVAL = 10000 // 10 segundos
  private readonly AGGRESSIVE_THRESHOLD = 10 * 60 * 1000 // 10 minutos
  private readonly MAX_ATTEMPTS = 100 // 50 minutos no normal polling
  private readonly MIN_LOGS_REQUIRED = 6 // Mínimo de logs para considerar partida finalizada

  constructor(callbacks: ValidationCallbacks = {}) {
    this.callbacks = callbacks
    this.redis = getRedisClient()
    this.redisAvailable = isRedisReady()
    log('info', '✅ ValidationManager: Usando Redis singleton')
    log('info', '🔍 ValidationManager iniciado (single polling mode)')
  }

  /**
   * Helper: Salva no Redis se disponível
   */
  private async redisSet(key: string, value: string, options?: any): Promise<void> {
    if (!this.redisAvailable) return
    try {
      await this.redis.set(key, value, options)
    } catch (error) {
      log('warn', `⚠️ Redis set falhou (${key}):`, error)
    }
  }

  /**
   * Helper: Remove do Redis se disponível
   */
  private async redisDel(key: string): Promise<void> {
    if (!this.redisAvailable) return
    try {
      await this.redis.del(key)
    } catch (error) {
      log('warn', `⚠️ Redis del falhou (${key}):`, error)
    }
  }

  /**
   * Registra match para validação (mantém compatibilidade com API antiga)
   */
  async registerMatch(
    matchId: string,
    mapNumber: number,
    _gameType: number,
    _gameMode: number,
    playerIds: number[]
  ): Promise<void> {
    await this.startValidation(matchId, mapNumber, new Date(), playerIds)
  }

  /**
   * Inicia validação de uma partida
   */
  async startValidation(
    matchId: string,
    mapNumber: number,
    startedAt: Date,
    expectedPlayers: number[]
  ): Promise<void> {
    log('info', `🔍 Iniciando validação: Match ${matchId} (Mapa ${mapNumber}, ${expectedPlayers.length} jogadores)`)

    this.activeMatches.set(matchId, {
      matchId,
      mapNumber,
      startedAt,
      lastCheck: new Date(),
      attempts: 0,
      status: 'monitoring',
      expectedPlayers
    })
    this.playerPenalties.set(matchId, new Map())
    this.matchLogsCache.set(matchId, new Map())

    await this.redisSet(
      `validation:${matchId}`,
      JSON.stringify({
        matchId,
        mapNumber,
        startedAt: startedAt.toISOString(),
        expectedPlayers
      }),
      { EX: 7200 } // 2 horas
    )

    if (this.activeMatches.size === 1) {
      this.startNormalPolling()
    }
    log('info', `📊 Total de partidas ativas: ${this.activeMatches.size}`)
  }

  /**
   * Cancela validação manualmente
   */
  async cancelValidation(matchId: string): Promise<void> {
    await this.clearMatchCaches(matchId)
    this.activeMatches.delete(matchId)
    await this.redisDel(`validation:${matchId}`)
    log('info', `🛑 Validação parada: Match ${matchId}`)
    if (this.activeMatches.size === 0) {
      this.stopAllPolling()
    }
  }

  /**
   * Inicia polling normal (30s)
   */
  private startNormalPolling(): void {
    if (this.normalPollingInterval) return
    log('info', '⏰ Polling normal iniciado (30s) - single query mode')
    this.normalPollingInterval = setInterval(async () => {
      await this.checkAllMatches('normal')
    }, this.NORMAL_INTERVAL)
    this.checkAllMatches('normal')
  }

  /**
   * Inicia polling agressivo (10s)
   */
  private startAggressivePolling(): void {
    if (this.aggressivePollingInterval) return
    log('info', '⚡ Polling agressivo iniciado (10s)')
    this.aggressivePollingInterval = setInterval(async () => {
      await this.checkAllMatches('aggressive')
    }, this.AGGRESSIVE_INTERVAL)
  }

  /**
   * Para todos os pollings
   */
  private stopAllPolling(): void {
    if (this.normalPollingInterval) {
      clearInterval(this.normalPollingInterval)
      this.normalPollingInterval = undefined
      log('info', '🛑 Polling normal parado')
    }
    if (this.aggressivePollingInterval) {
      clearInterval(this.aggressivePollingInterval)
      this.aggressivePollingInterval = undefined
      log('info', '🛑 Polling agressivo parado')
    }
  }

  /**
   * Verifica TODAS as partidas ativas com UMA ÚNICA QUERY
   */
  private async checkAllMatches(mode: 'normal' | 'aggressive'): Promise<void> {
    if (this.activeMatches.size === 0) {
      this.stopAllPolling()
      return
    }

    const now = new Date()
    const matches = Array.from(this.activeMatches.values())
    const matchesToCheck = mode === 'aggressive'
      ? matches.filter(m => m.status === 'aggressive')
      : matches.filter(m => m.status === 'monitoring')

    if (matchesToCheck.length === 0) return

    log('debug', `🔍 Verificando ${matchesToCheck.length} partida(s) [${mode}] - Total ativo: ${matches.length}`)
    try {
      const allLogs = await this.fetchAllLogs(matchesToCheck)
      log('debug', `📊 Query retornou ${allLogs.length} logs para ${matchesToCheck.length} partida(s)`)
      for (const validation of matchesToCheck) {
        await this.processMatch(validation, allLogs, now)
      }
      this.lastGlobalCheck = now
      await this.redisSet('validation:last_check', now.toISOString())
    } catch (error) {
      log('error', '❌ Erro ao verificar partidas', error)
    }
  }

  /**
   * Busca logs de TODAS as partidas de uma vez
   */
  private async fetchAllLogs(matches: MatchValidation[]): Promise<MatchLog[]> {
    const oldestStartTime = new Date(Math.min(...matches.map(m => m.startedAt.getTime())))
    const now = new Date()
    const checkFrom = this.lastGlobalCheck > oldestStartTime ? this.lastGlobalCheck : oldestStartTime
    const expectedOids = Array.from(new Set(matches.flatMap(m => m.expectedPlayers)))

    if (expectedOids.length === 0) {
      log('warn', 'Nenhum oidUser esperado encontrado para validacao corrente.')
      return []
    }

    log('debug', `Buscando logs desde ${checkFrom.toISOString()} ate ${now.toISOString()} para oidUsers: ${expectedOids.join(', ')}`)
    try {
      const logs = await prismaRanked.$queryRaw<MatchLog[]>`
        SELECT
          oidUser,
          MapNo,
          CAST(isWin AS BIT) as isWin,
          KillCnt,
          DeadCnt,
          HeadShotCnt,
          ISNULL(Assist, 0) as Assist,
          ISNULL(Exp, 0) as Exp,
          ISNULL(Money, 0) as Money,
          ISNULL(Forfeited, 0) as Forfeited,
          LogDate
        FROM COMBATARMS_LOG.dbo.BST_Fullmatchlog
        WHERE GameMode = 5
          AND IsValid = 1
          AND LogDate >= ${checkFrom}
          AND LogDate <= ${now}
          AND oidUser IN (${Prisma.join(expectedOids)})
        ORDER BY LogDate DESC
      `
      return logs
    } catch (error) {
      log('error', 'Erro ao buscar logs do BST_Fullmatchlog', error)
      return []
    }
  }

  private getPenaltyMap(matchId: string): Map<number, PlayerPenaltyInfo> {
    if (!this.playerPenalties.has(matchId)) {
      this.playerPenalties.set(matchId, new Map())
    }
    return this.playerPenalties.get(matchId)!
  }

  private getMatchLogCache(matchId: string): Map<number, MatchLog> {
    if (!this.matchLogsCache.has(matchId)) {
      this.matchLogsCache.set(matchId, new Map())
    }
    return this.matchLogsCache.get(matchId)!
  }

  private detectPenaltyReason(log: MatchLog): PlayerPenaltyReason | null {
    const forfeited = log.Forfeited === 1
    const expZero = (log.Exp ?? 0) === 0
    const moneyZero = (log.Money ?? 0) === 0

    if (forfeited) {
      return 'FORFEIT'
    }

    if (expZero && moneyZero) {
      return 'ZERO_REWARD'
    }

    return null
  }

  private markPlayerPenalty(
    matchId: string,
    oidUser: number,
    reason: PlayerPenaltyReason,
    log?: MatchLog,
    evidence?: PlayerPenaltyInfo['evidence']
  ): void {
    const penalties = this.getPenaltyMap(matchId)
    if (penalties.has(oidUser)) {
      return
    }

    const info: PlayerPenaltyInfo = {
      reason,
      detectedAt: new Date(),
      lastLogDate: log?.LogDate,
      evidence: evidence ?? (reason === 'NO_LOG' ? 'NO_LOG' : undefined)
    }

    penalties.set(oidUser, info)
    const evidenceLabel = evidence || info.evidence || 'unknown'
    console.log('warn', `�Y\"% Penalidade registrada para ${oidUser} no match ${matchId} (motivo: ${reason}, evid�ncia: ${evidenceLabel})`)

    this.persistPenaltySnapshot(matchId).catch(error => {
      console.log('warn', `�?O N��o foi poss��vel salvar penalidades no Redis para match ${matchId}`, error)
    })
  }

  private async persistPenaltySnapshot(matchId: string): Promise<void> {
    if (!this.redisAvailable) return
    const penalties = this.playerPenalties.get(matchId)
    if (!penalties || penalties.size === 0) {
      await this.redisDel(`match:${matchId}:penalties`)
      return
    }

    const payload = Array.from(penalties.entries()).map(([oidUser, info]) => ({
      oidUser,
      reason: info.reason,
      detectedAt: info.detectedAt.toISOString(),
      lastLogDate: info.lastLogDate ? info.lastLogDate.toISOString() : undefined,
      evidence: info.evidence
    }))

    await this.redisSet(`match:${matchId}:penalties`, JSON.stringify(payload), { EX: 7200 })
  }

  private async clearMatchCaches(matchId: string): Promise<void> {
    this.playerPenalties.delete(matchId)
    this.matchLogsCache.delete(matchId)
    await this.redisDel(`match:${matchId}:penalties`)
  }

  /**
   * Processa um match individual
   */
  private async processMatch(
    validation: MatchValidation,
    allLogs: MatchLog[],
    now: Date
  ): Promise<void> {
    const { matchId, mapNumber, startedAt, expectedPlayers } = validation

    const recentLogs = allLogs.filter(log =>
      log.MapNo === mapNumber &&
      log.LogDate >= startedAt &&
      expectedPlayers.includes(log.oidUser)
    )
    const penalties = this.getPenaltyMap(matchId)
    const logCache = this.getMatchLogCache(matchId)

    for (const logEntry of recentLogs) {
      logCache.set(logEntry.oidUser, logEntry)
      const reason = this.detectPenaltyReason(logEntry)
      if (reason) {
        const evidence: PlayerPenaltyInfo['evidence'] = reason === 'FORFEIT' ? 'FORFEITED' : 'ZERO_REWARD'
        this.markPlayerPenalty(matchId, logEntry.oidUser, reason, logEntry, evidence)
      }
    }

    const aggregatedLogs = Array.from(logCache.values())
    const uniqueLogPlayers = new Set(aggregatedLogs.map(log => log.oidUser))
    const penaltyPlayers = new Set(penalties.keys())
    const accountedPlayers = new Set([...uniqueLogPlayers, ...penaltyPlayers])

    log('debug', `🎮 Match ${matchId}: ${aggregatedLogs.length} logs acumulados (${recentLogs.length} novos), ${penaltyPlayers.size} penalizado(s)`)

    // Ajusta o mínimo de logs necessários se for 1v1 (modo de teste)
    const minLogs = expectedPlayers.length >= 6 
      ? this.MIN_LOGS_REQUIRED 
      : expectedPlayers.length;

    const hasEnoughLogs = aggregatedLogs.length >= minLogs
    if (hasEnoughLogs && accountedPlayers.size >= expectedPlayers.length) {
      await this.handleMatchCompleted(matchId, aggregatedLogs, expectedPlayers, penalties)
      return
    }

    if (hasEnoughLogs && accountedPlayers.size < expectedPlayers.length) {
      const missingPlayers = expectedPlayers.filter(oid => !accountedPlayers.has(oid))
      if (missingPlayers.length > 0) {
        for (const missing of missingPlayers) {
          this.markPlayerPenalty(matchId, missing, 'NO_LOG', undefined, 'NO_LOG')
        }
        const updatedPenalties = this.getPenaltyMap(matchId)
        const updatedAccounted = new Set([...uniqueLogPlayers, ...updatedPenalties.keys()])
        if (updatedAccounted.size >= expectedPlayers.length) {
          await this.handleMatchCompleted(matchId, aggregatedLogs, expectedPlayers, updatedPenalties)
          return
        }
      }
    }

    validation.attempts++
    validation.lastCheck = now

    const elapsedTime = now.getTime() - startedAt.getTime()
    if (validation.attempts >= this.MAX_ATTEMPTS || elapsedTime > 50 * 60 * 1000) {
      await this.handleMatchTimeout(matchId)
      return
    }

    if (elapsedTime > this.AGGRESSIVE_THRESHOLD && validation.status === 'monitoring') {
      validation.status = 'aggressive'
      log('info', `⚡ Match ${matchId} mudou para polling agressivo (>10min)`)
      this.startAggressivePolling()
    }

    log('debug', `⏳ Match ${matchId}: tentativa ${validation.attempts}/${this.MAX_ATTEMPTS}`)
  }

  /**
   * Trata partida completada
   */
  private async handleMatchCompleted(
    matchId: string,
    logs: MatchLog[],
    expectedPlayers: number[],
    penalties?: Map<number, PlayerPenaltyInfo>
  ): Promise<void> {
    log('info', `🎉 Match ${matchId} completado! Validando...`)
    
    // **ARQUITETURA IDEAL**: Busca dados dos times do `lobby:temp` do Redis
    const lobbyDataStr = await this.redis.get(`lobby:temp:${matchId}`)
    if (!lobbyDataStr) {
      log('error', `❌ Dados temporários da lobby não encontrados para match ${matchId} (handleMatchCompleted). A partida não pode ser validada.`)
      this.activeMatches.delete(matchId) // Para de tentar
      await this.redisDel(`validation:${matchId}`)
      return
    }
    const lobbyData = JSON.parse(lobbyDataStr)
    
    // Constrói a lista de times que o `validateTeams` espera
    const playerTeamList = [
      ...lobbyData.teams.ALPHA.map((p: any) => ({ oidUser: p.oidUser, team: 'ALPHA' })),
      ...lobbyData.teams.BRAVO.map((p: any) => ({ oidUser: p.oidUser, team: 'BRAVO' }))
    ]

    try {
      const playersWhoPlayed = [...new Set(logs.map(log => log.oidUser))]
      const penalizedPlayers = penalties ? Array.from(penalties.keys()) : []
      const fallbackAbandonments = expectedPlayers.filter(oid => !playersWhoPlayed.includes(oid))
      const abandonmentSet = new Set<number>([...penalizedPlayers, ...fallbackAbandonments])
      const abandonments = Array.from(abandonmentSet)

      log('info', `📊 Match ${matchId}: ${playersWhoPlayed.length}/${expectedPlayers.length} jogaram, ${abandonments.length} penalizações`)
      if (abandonments.length > 0) {
        log('warn', `Jogadores ausentes punidos: ${abandonments.join(', ')}`)
      }

      const validationResult = await this.validateTeams(matchId, logs, playerTeamList, abandonments)

      if (validationResult.isValid) {
        log('info', `✅ Match ${matchId} VÁLIDO - Vencedor: ${validationResult.winner}`)
        
        // Passa `lobbyData` para a função que atualiza os resultados
        await this.updateMatchResults(matchId, validationResult, logs, lobbyData, penalties)

        if (this.callbacks.onMatchCompleted) {
          await this.callbacks.onMatchCompleted(matchId, validationResult)
        }
      } else {
        log('warn', `❌ Match ${matchId} INVÁLIDO: ${validationResult.reason}`)

        // **CORREÇÃO**: Apenas atualiza o match existente para 'cancelled'
        await prismaRanked.$executeRaw`
          UPDATE BST_RankedMatch
          SET
            status = 'cancelled',
            endReason = ${validationResult.reason || 'invalid_logs'},
            endedAt = GETDATE()
          WHERE
            id = ${matchId} AND (status = 'in-progress' OR status = 'ready')
        `
        
        if (this.callbacks.onMatchInvalid) {
          await this.callbacks.onMatchInvalid(matchId, validationResult.reason || 'Validação falhou')
        }
      }

      // Limpa dados temporários (somente o lobby:temp)
      await this.redis.del(`lobby:temp:${matchId}`)

    } catch (error) {
      log('error', `❌ Erro ao processar match ${matchId}`, error)
    } finally {
      await this.clearMatchCaches(matchId)
      // Remove da validação ativa em qualquer caso (sucesso ou falha)
      this.activeMatches.delete(matchId)
      await this.redisDel(`validation:${matchId}`)

      if (this.activeMatches.size === 0) {
        this.stopAllPolling()
      }
    }
  }

  /**
   * Valida se os times estão balanceados
   */
  private async validateTeams(
    _matchId: string,
    logs: MatchLog[],
    playerTeams: {oidUser: number, team: 'ALPHA' | 'BRAVO'}[],
    abandonments: number[]
  ): Promise<ValidationResult> {
    
    // **MODO DE TESTE 1v1**
    const totalExpected = playerTeams.length;
    if (totalExpected === 2) {
      log('warn', '⚠️ MODO DE TESTE 1v1 ATIVADO NA VALIDAÇÃO');
      const winner = logs.find(l => l.isWin)?.oidUser === playerTeams.find(p => p.team === 'ALPHA')?.oidUser ? 'ALPHA' : 'BRAVO';
      return Promise.resolve({ isValid: true, winner, abandonments, logs });
    }
    // **FIM DO MODO DE TESTE**

    const teamCounts = { ALPHA: 0, BRAVO: 0 }
    const teamWins = { ALPHA: 0, BRAVO: 0 }

    for (const log of logs) {
      const playerTeam = playerTeams.find(p => p.oidUser === log.oidUser)
      if (!playerTeam) continue

      const team = playerTeam.team
      teamCounts[team]++
      if (log.isWin) {
        teamWins[team]++
      }
    }

    log('debug', `📊 Times: ALPHA=${teamCounts.ALPHA}, BRAVO=${teamCounts.BRAVO}`)
    log('debug', `🏆 Vitórias: ALPHA=${teamWins.ALPHA}, BRAVO=${teamWins.BRAVO}`)

    // Regra 1: Mínimo de jogadores por time
    if (teamCounts.ALPHA < this.MIN_LOGS_REQUIRED / 2) { // Ex: 3
      return {
        isValid: false,
        winner: null,
        abandonments,
        logs,
        reason: `Time ALPHA teve apenas ${teamCounts.ALPHA} jogadores (mínimo: ${this.MIN_LOGS_REQUIRED / 2})`
      }
    }
    if (teamCounts.BRAVO < this.MIN_LOGS_REQUIRED / 2) { // Ex: 3
      return {
        isValid: false,
        winner: null,
        abandonments,
        logs,
        reason: `Time BRAVO teve apenas ${teamCounts.BRAVO} jogadores (mínimo: ${this.MIN_LOGS_REQUIRED / 2})`
      }
    }

    // Regra 2: Diferença máxima entre times (baseado no total que jogou)
    const maxTeamDifference = 2
    const teamDiff = Math.abs(teamCounts.ALPHA - teamCounts.BRAVO)
    if (teamDiff > maxTeamDifference) {
      return {
        isValid: false,
        winner: null,
        abandonments,
        logs,
        reason: `Diferença de jogadores entre times (${teamDiff}) excede o máximo (${maxTeamDifference})`
      }
    }

    const winner = teamWins.ALPHA > teamWins.BRAVO ? 'ALPHA' : 'BRAVO'

    return {
      isValid: true,
      winner,
      abandonments,
      logs
    }
  }

  /**
   * Atualiza resultados do match no banco (ARQUITETURA IDEAL)
   */


  private async updateMatchResults(
    matchId: string,
    result: ValidationResult,
    logs: MatchLog[],
    lobbyData: any,
    penalties: Map<number, PlayerPenaltyInfo> | undefined
  ): Promise<void> {
    const { winner } = result
    if (!winner) {
      log('warn', `Match ${matchId} sem vencedor definido, pontuacao ignorada`)
      return
    }

    const scoreAlpha = winner === 'ALPHA' ? 1 : 0
    const scoreBravo = winner === 'BRAVO' ? 1 : 0

    try {
      await prismaRanked.$executeRaw`
        UPDATE BST_RankedMatch
        SET
          status = 'completed',
          endReason = 'SUCCESS',
          endedAt = GETDATE(),
          duration = DATEDIFF(SECOND, startedAt, GETDATE()),
          scoreAlpha = ${scoreAlpha},
          scoreBravo = ${scoreBravo},
          winnerTeam = ${winner}
        WHERE
          id = ${matchId}
          AND status IN ('awaiting-ready', 'in-progress', 'awaiting-confirmation')
      `
    } catch (e) {
      log('error', `Falha ao ATUALIZAR BST_RankedMatch ${matchId}`, e)
      return
    }

    const playerTeams = lobbyData.teams
    const allPlayers = [...playerTeams.ALPHA, ...playerTeams.BRAVO]
    const playerTeamMap = new Map<number, 'ALPHA' | 'BRAVO'>()
    playerTeams.ALPHA.forEach((p: any) => playerTeamMap.set(p.oidUser, 'ALPHA'))
    playerTeams.BRAVO.forEach((p: any) => playerTeamMap.set(p.oidUser, 'BRAVO'))
    const penaltyMap = penalties ?? new Map()

    const playerOids = allPlayers.map((p: any) => p.oidUser)
    const rankStatesRaw = await prismaRanked.$queryRaw<any[]>`
      SELECT 
        oidUser,
        ISNULL(rankTier, 'BRONZE_3') as rankTier,
        ISNULL(rankPoints, 0) as rankPoints,
        ISNULL(winStreak, 0) as winStreak,
        ISNULL(lossProtection, 0) as lossProtection,
        ISNULL(lossesAtZero, 0) as lossesAtZero,
        ISNULL(md5Wins, 0) as md5Wins,
        ISNULL(md5Losses, 0) as md5Losses,
        ISNULL(md5Active, 0) as md5Active
      FROM BST_RankedUserStats
      WHERE oidUser IN (${Prisma.join(playerOids)})
    `
    const rankStateByOid = new Map<number, PlayerRankState>()
    for (const raw of rankStatesRaw) {
      rankStateByOid.set(raw.oidUser, {
        rankTier: raw.rankTier,
        rankPoints: Number(raw.rankPoints ?? 0),
        winStreak: Number(raw.winStreak ?? 0),
        lossProtection: Number(raw.lossProtection ?? 0),
        lossesAtZero: Number(raw.lossesAtZero ?? 0),
        md5Wins: Number(raw.md5Wins ?? 0),
        md5Losses: Number(raw.md5Losses ?? 0),
        md5Active: raw.md5Active ? true : false
      })
    }

    const rankInputs: RankCalculationPlayerInput[] = allPlayers.map((player: any) => {
      const team = playerTeamMap.get(player.oidUser) || 'ALPHA'
      const playerLog = logs.find(l => l.oidUser === player.oidUser)
      const state = rankStateByOid.get(player.oidUser) || {
        rankTier: DEFAULT_TIER,
        rankPoints: 0,
        winStreak: 0,
        lossProtection: 0,
        lossesAtZero: 0,
        md5Wins: 0,
        md5Losses: 0,
        md5Active: false
      }
      const penaltyInfo = penaltyMap.get(player.oidUser)
      const penalty = mapPenaltyToImpact(penaltyInfo)
      return {
        oidUser: player.oidUser,
        username: player.username,
        team,
        didWin: winner === team,
        state,
        stats: {
          kills: playerLog?.KillCnt || 0,
          deaths: playerLog?.DeadCnt || 0,
          assists: playerLog?.Assist || 0,
          headshots: playerLog?.HeadShotCnt || 0,
          bombPlants: playerLog?.BombsPlanted || 0,
          bombDefuses: playerLog?.BombsDefused || 0
        },
        penalty
      }
    })

    const teamStrength = { ALPHA: 0, BRAVO: 0 }
    const teamCounts = { ALPHA: 0, BRAVO: 0 }
    for (const input of rankInputs) {
      teamStrength[input.team] += computeMatchmakingValue(input.state.rankTier, input.state.rankPoints)
      teamCounts[input.team] += 1
    }
    if (teamCounts.ALPHA > 0) teamStrength.ALPHA /= teamCounts.ALPHA
    if (teamCounts.BRAVO > 0) teamStrength.BRAVO /= teamCounts.BRAVO

    const rankResults = calculateRankChanges(rankInputs, { winner, teamStrength })
    const resultByOid = new Map(rankResults.map(res => [res.oidUser, res]))
    log('info', `Pontuacoes recalculadas para ${rankResults.length} jogadores (Match ${matchId})`)

    for (const input of rankInputs) {
      const result = resultByOid.get(input.oidUser)
      if (!result) continue
      try {
        await prismaRanked.$executeRaw`
          INSERT INTO BST_MatchPlayer 
            (matchId, oidUser, team, kills, deaths, assists, headshots, mmrChange, confirmedResult, confirmedAt)
          VALUES 
            (${matchId}, ${input.oidUser}, ${input.team}, 
             ${input.stats.kills}, ${input.stats.deaths}, ${input.stats.assists}, ${input.stats.headshots}, 
             ${result.matchmakingDelta}, 1, GETDATE())
        `
      } catch (e) {
        log('error', `Falha ao INSERIR BST_MatchPlayer para ${input.oidUser} no match ${matchId}`, e)
      }
    }

    for (const input of rankInputs) {
      const result = resultByOid.get(input.oidUser)
      if (!result) continue
      const newState = result.newState
      const newMatchmaking = computeMatchmakingValue(newState.rankTier, newState.rankPoints)
      const didWin = winner === input.team
      try {
        await prismaRanked.$executeRaw`
          MERGE INTO BST_RankedUserStats AS target
          USING (SELECT ${input.oidUser} AS oidUser) AS source
          ON target.oidUser = source.oidUser
          WHEN MATCHED THEN
            UPDATE SET 
              eloRating = ${newMatchmaking},
              rankTier = ${newState.rankTier},
              rankPoints = ${newState.rankPoints},
              winStreak = ${newState.winStreak},
              lossProtection = ${newState.lossProtection},
              lossesAtZero = ${newState.lossesAtZero},
              md5Wins = ${newState.md5Wins},
              md5Losses = ${newState.md5Losses},
              md5Active = ${newState.md5Active ? 1 : 0},
              matchesPlayed = matchesPlayed + 1,
              matchesWon = matchesWon + ${didWin ? 1 : 0},
              lastMatchAt = GETDATE(),
              updatedAt = GETDATE()
          WHEN NOT MATCHED THEN
            INSERT (oidUser, eloRating, rankTier, rankPoints, winStreak, lossProtection, lossesAtZero, md5Wins, md5Losses, md5Active, matchesPlayed, matchesWon, lastMatchAt, createdAt, updatedAt)
            VALUES (${input.oidUser}, ${newMatchmaking}, ${newState.rankTier}, ${newState.rankPoints}, ${newState.winStreak}, ${newState.lossProtection}, ${newState.lossesAtZero}, ${newState.md5Wins}, ${newState.md5Losses}, ${newState.md5Active ? 1 : 0}, 1, ${didWin ? 1 : 0}, GETDATE(), GETDATE(), GETDATE());
        `
        await this.updatePlayerBackground(input.oidUser, newState.rankTier)
      } catch (e) {
        log('error', `Falha ao ATUALIZAR BST_RankedUserStats para ${input.oidUser}`, e)
      }
    }

    log('debug', `Limpando chaves Redis para match ${matchId} concluido...`)
    await this.redis.del(`lobby:temp:${matchId}`)
    await this.redis.del(`match:${matchId}:queueSnapshot`)
    await this.redis.del(`match:${matchId}:classes`)
    await this.redis.del(`match:${matchId}:room`)
    await this.redis.del(`match:${matchId}:status`)
    await this.redis.del(`match:${matchId}:host`)
    await this.redis.del(`match:${matchId}:hostPassword`)
    await this.redis.del(`room:${matchId}`)
    await this.redis.del(`match:${matchId}:ready`)
    await this.redis.del(`lobby:${matchId}:state`)
    await this.redis.del(`lobby:${matchId}:vetos`)

    log('info', `Match ${matchId} resultados salvos: ${winner} venceu`)
  }

  private async updatePlayerBackground(oidUser: number, tier: RankTier): Promise<void> {
    const backgroundId = getBackgroundIdForTier(tier)
    if (!backgroundId) return

    try {
      await prismaGame.$executeRaw`
        MERGE COMBATARMS.dbo.CBT_User_NickName_Background AS target
        USING (SELECT ${oidUser} AS oidUser) AS source
        ON target.oidUser = source.oidUser
        WHEN MATCHED THEN
          UPDATE SET
            Background = ${backgroundId},
            Emblem = 0,
            EndDate = '2500-12-31 23:59:59'
        WHEN NOT MATCHED THEN
          INSERT (oidUser, Background, Emblem, EndDate)
          VALUES (${oidUser}, ${backgroundId}, 0, '2500-12-31 23:59:59');
      `
    } catch (error) {
      log('warn', `Falha ao aplicar brasão de elo para ${oidUser} (${tier})`, error)
    }
  }
  /**
   * Trata timeout de validação (50 minutos sem logs)
   */
  private async handleMatchTimeout(matchId: string): Promise<void> {
    log('warn', `⏰ Match ${matchId} timeout (50 minutos sem logs suficientes)`)
    
    try {
      // **CORREÇÃO**: Apenas atualiza o match existente para 'cancelled'
      await prismaRanked.$executeRaw`
        UPDATE BST_RankedMatch
        SET
          status = 'cancelled',
          endReason = 'validation_timeout',
          endedAt = GETDATE()
        WHERE
          id = ${matchId} AND (status = 'in-progress' OR status = 'ready')
      `
      
      if (this.callbacks.onMatchTimeout) {
        await this.callbacks.onMatchTimeout(matchId)
      }

      // Limpa dados temporários
      await this.redis.del(`lobby:temp:${matchId}`) // Este manager é dono desta chave

    } catch (error) {
      log('error', `❌ Erro ao processar timeout do match ${matchId}`, error)
    } finally {
      await this.clearMatchCaches(matchId)
      // Remove da validação ativa
      this.activeMatches.delete(matchId)
      await this.redisDel(`validation:${matchId}`)

      if (this.activeMatches.size === 0) {
        this.stopAllPolling()
      }
    }
  }

  /**
   * Verifica se match está sendo validado
   */
  isValidating(matchId: string): boolean {
    return this.activeMatches.has(matchId)
  }

  /**
   * Retorna validação ativa
   */
  getValidation(matchId: string): MatchValidation | undefined {
    return this.activeMatches.get(matchId)
  }

  /**
   * Retorna estatísticas do validador
   */
  getStats(): {
    pending: number
    oldest: number | null
    activeMatches: number
    monitoringMatches: number
    aggressiveMatches: number
    pollingStatus: string
  } {
    const matches = Array.from(this.activeMatches.values())
    const pending = this.activeMatches.size

    let oldest: number | null = null
    if (pending > 0) {
      const oldestMatch = matches.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0]
      oldest = Date.now() - oldestMatch.startedAt.getTime()
    }

    return {
      pending,
      oldest,
      activeMatches: this.activeMatches.size,
      monitoringMatches: matches.filter(m => m.status === 'monitoring').length,
      aggressiveMatches: matches.filter(m => m.status === 'aggressive').length,
      pollingStatus: this.normalPollingInterval ? 'running' : 'stopped'
    }
  }

  /**
   * Para todas as validações (shutdown)
   */
  stop(): void {
    log('info', '🛑 Encerrando ValidationManager...')
    this.stopAllPolling()
    this.activeMatches.clear()
    this.playerPenalties.clear()
    this.matchLogsCache.clear()
    log('info', '✅ ValidationManager encerrado')
  }

  /**
   * Alias para stop()
   */
  shutdown(): void {
    this.stop()
  }
}
