import { getRedisClient, isRedisReady } from '../database/redis-client'
import { prismaRanked } from '../database/prisma'
import { log } from '../utils/logger'
import { MatchValidator } from '../validators/match-validator'
import type { PlayerMatchData } from '../validators/match-validator'
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
  LogDate: Date
}

interface ValidationResult {
  isValid: boolean
  winner: 'ALPHA' | 'BRAVO' | null
  abandonments: number[]
  logs: MatchLog[]
  reason?: string
}

interface ValidationCallbacks {
  onMatchCompleted?: (matchId: string, result: ValidationResult) => Promise<void>
  onMatchTimeout?: (matchId: string) => Promise<void>
  onMatchInvalid?: (matchId: string, reason: string) => Promise<void>
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

  /**
   * Processa um match individual
   */
  private async processMatch(
    validation: MatchValidation,
    allLogs: MatchLog[],
    now: Date
  ): Promise<void> {
    const { matchId, mapNumber, startedAt, expectedPlayers } = validation

    const matchLogs = allLogs.filter(log =>
      log.MapNo === mapNumber &&
      log.LogDate >= startedAt &&
      expectedPlayers.includes(log.oidUser)
    )

    log('debug', `🎮 Match ${matchId}: ${matchLogs.length} logs encontrados`)

    // Ajusta o mínimo de logs necessários se for 1v1 (modo de teste)
    const minLogs = expectedPlayers.length >= 6 
      ? this.MIN_LOGS_REQUIRED 
      : expectedPlayers.length;

    if (matchLogs.length >= minLogs && matchLogs.length >= expectedPlayers.length) {
      await this.handleMatchCompleted(matchId, matchLogs, expectedPlayers)
      return
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
    expectedPlayers: number[]
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
      const abandonments = expectedPlayers.filter(oid => !playersWhoPlayed.includes(oid))

      log('info', `📊 Match ${matchId}: ${playersWhoPlayed.length}/${expectedPlayers.length} jogaram, ${abandonments.length} abandonos`)
      if (abandonments.length > 0) {
        log('warn', `Jogadores ausentes punidos: ${abandonments.join(', ')}`)
      }

      const validationResult = await this.validateTeams(matchId, logs, playerTeamList, abandonments)

      if (validationResult.isValid) {
        log('info', `✅ Match ${matchId} VÁLIDO - Vencedor: ${validationResult.winner}`)
        
        // Passa `lobbyData` para a função que atualiza os resultados
        await this.updateMatchResults(matchId, validationResult, logs, lobbyData)

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
    lobbyData: any // Dados do lobby:temp:${matchId}
  ): Promise<void> {
    const { winner } = result
    const scoreAlpha = winner === 'ALPHA' ? 1 : 0
    const scoreBravo = winner === 'BRAVO' ? 1 : 0

    // 1. ATUALIZA o BST_RankedMatch (que já existe)
    try {
      await prismaRanked.$executeRaw`
        UPDATE BST_RankedMatch
        SET
          status = 'awaiting-confirmation', -- ou 'completed' se pularmos a confirmação
          endedAt = GETDATE(),
          duration = DATEDIFF(SECOND, startedAt, GETDATE()),
          scoreAlpha = ${scoreAlpha},
          scoreBravo = ${scoreBravo},
          winnerTeam = ${winner}
        WHERE
          id = ${matchId} AND status = 'in-progress'
      `
    } catch (e) {
      log('error', `Falha ao ATUALIZAR BST_RankedMatch ${matchId}`, e);
      return; // Para se não conseguir atualizar o match
    }

    // 2. Monta dados dos jogadores para cálculo de MMR
    const playerTeams = lobbyData.teams
    const allPlayers = [...playerTeams.ALPHA, ...playerTeams.BRAVO]
    
    // Busca MMR atual (fallback para MMR do lobbyData)
    const playersMMR: { oidUser: number, currentMMR: number, matchesPlayed: number, placementCompleted: boolean }[] = [];
    try {
      const playerOids = allPlayers.map((p: any) => p.oidUser);
      const mmrResults = await prismaRanked.$queryRaw<any[]>`
        SELECT oidUser, 
               ISNULL(eloRating, 1000) as currentMMR,
               ISNULL(matchesPlayed, 0) as matchesPlayed,
               ISNULL(placementCompleted, 1) as placementCompleted
        FROM BST_RankedUserStats
        WHERE oidUser IN (${Prisma.join(playerOids)})
      `
      const mmrMap = new Map(mmrResults.map(r => [r.oidUser, r]));
      for (const player of allPlayers) {
        const stats = mmrMap.get(player.oidUser);
        playersMMR.push({
          oidUser: player.oidUser,
          currentMMR: stats?.currentMMR || player.mmr || 1000,
          matchesPlayed: stats?.matchesPlayed || 0,
          placementCompleted: stats?.placementCompleted === 1
        });
      }
    } catch (e) {
      log('error', 'Erro ao buscar MMRs, usando fallback do lobbyData', e);
      for (const player of allPlayers) {
        playersMMR.push({
          oidUser: player.oidUser,
          currentMMR: player.mmr || 1000,
          matchesPlayed: 0,
          placementCompleted: true
        });
      }
    }

    // Monta dados completos para o MatchValidator

    // LOG EXTRA: Checagem de consistência entre time vencedor e isWin dos logs
    for (const player of allPlayers) {
      const team = playerTeams.ALPHA.find((p: any) => p.oidUser === player.oidUser) ? 'ALPHA' : 'BRAVO';
      const playerLog = logs.find(l => l.oidUser === player.oidUser);
      if (playerLog) {
        if ((team === winner && !playerLog.isWin) || (team !== winner && playerLog.isWin)) {
          log('warn', `🔎 INCONSISTÊNCIA: Jogador ${player.username} (oidUser=${player.oidUser}) está no time ${team}, winner=${winner}, mas isWin=${playerLog.isWin}`);
        } else {
          log('debug', `OK: ${player.username} (oidUser=${player.oidUser}) team=${team} winner=${winner} isWin=${playerLog.isWin}`);
        }
      } else {
        log('warn', `⚠️ Sem log para jogador ${player.username} (oidUser=${player.oidUser})`);
      }
    }

    const playersData: PlayerMatchData[] = allPlayers.map((player: any) => {
      const team = playerTeams.ALPHA.find((p: any) => p.oidUser === player.oidUser) ? 'ALPHA' : 'BRAVO';
      const playerLog = logs.find(l => l.oidUser === player.oidUser);
      const didAbandon = result.abandonments.includes(player.oidUser);
      const mmrData = playersMMR.find(m => m.oidUser === player.oidUser);
      return {
        oidUser: player.oidUser,
        username: player.username,
        team,
        currentMMR: mmrData?.currentMMR || 1000,
        matchesPlayed: mmrData?.matchesPlayed || 0,
        placementCompleted: mmrData?.placementCompleted ?? false,
        kills: playerLog?.KillCnt || 0,
        deaths: playerLog?.DeadCnt || 0,
        assists: playerLog?.Assist || 0,
        headshots: playerLog?.HeadShotCnt || 0,
        didWin: playerLog ? playerLog.isWin : false,
        didAbandon
      };
    });

    if (!winner) {
      log('warn', `⚠️ Match ${matchId} sem vencedor definido, MMR não será calculado`)
      return
    }

    // 3. Calcula as mudanças de MMR
    const mmrResults = MatchValidator.calculateMMRChanges(playersData, winner)
    log('info', `🎯 MMR calculado para ${mmrResults.length} jogadores (Match ${matchId})`)

    // 4. INSERE os registros no BST_MatchPlayer (agora com todos os dados)
    for (const mmrResult of mmrResults) {
      const pData = playersData.find(p => p.oidUser === mmrResult.oidUser);
      if (!pData) continue;
      const seedingBonus = mmrResult.breakdown?.placementSeedingBonus || 0;
      
      try {
        await prismaRanked.$executeRaw`
          INSERT INTO BST_MatchPlayer 
            (matchId, oidUser, team, kills, deaths, assists, headshots, mmrChange, placementSeedingBonus, confirmedResult, confirmedAt)
          VALUES 
            (${matchId}, ${pData.oidUser}, ${pData.team}, 
             ${pData.kills}, ${pData.deaths}, ${pData.assists}, ${pData.headshots}, 
             ${mmrResult.change}, ${seedingBonus}, 1, GETDATE())
        `
      } catch (e) {
        log('error', `Falha ao INSERIR BST_MatchPlayer para ${pData.oidUser} no match ${matchId}`, e);
      }
    }

    // 5. ATUALIZA (MERGE) o BST_RankedUserStats
    for (const mmrResult of mmrResults) {
      const playerSnapshot = playersData.find(p => p.oidUser === mmrResult.oidUser)
      const didWin = playerSnapshot?.didWin || false
      const seedingBonus = mmrResult.breakdown?.placementSeedingBonus || 0
      const matchesBefore = playerSnapshot?.matchesPlayed || 0
      const matchesAfter = matchesBefore + 1
      const completedPlacement = seedingBonus > 0 || matchesAfter >= MatchValidator.CONFIG.PLACEMENT_MATCHES
      
      try {
        await prismaRanked.$executeRaw`
          MERGE INTO BST_RankedUserStats AS target
          USING (SELECT ${mmrResult.oidUser} AS oidUser) AS source
          ON target.oidUser = source.oidUser
          WHEN MATCHED THEN
            UPDATE SET 
              eloRating = ${mmrResult.newMMR},
              matchesPlayed = matchesPlayed + 1,
              matchesWon = matchesWon + ${didWin ? 1 : 0},
              lastMatchAt = GETDATE(),
              updatedAt = GETDATE(),
              placementCompleted = CASE 
                WHEN placementCompleted = 1 THEN 1 
                ELSE ${completedPlacement ? 1 : 0}
              END
          WHEN NOT MATCHED THEN
            INSERT (oidUser, eloRating, matchesPlayed, matchesWon, lastMatchAt, placementCompleted)
            VALUES (${mmrResult.oidUser}, ${mmrResult.newMMR}, 1, ${didWin ? 1 : 0}, GETDATE(), ${completedPlacement ? 1 : 0});
        `
        log('debug', `💾 ${mmrResult.username}: ${mmrResult.oldMMR} → ${mmrResult.newMMR} (${mmrResult.change >= 0 ? '+' : ''}${mmrResult.change})`)
      } catch (e) {
        log('error', `Falha ao ATUALIZAR BST_RankedUserStats para ${mmrResult.oidUser}`, e);
      }
    }

    // 6. Limpa TODAS as chaves temporárias do Redis
    log('debug', `🧹 Limpando chaves Redis para match ${matchId} concluído...`)
      
      // Chaves do QueueManager
      await this.redis.del(`lobby:temp:${matchId}`)
      await this.redis.del(`match:${matchId}:queueSnapshot`)
      await this.redis.del(`match:${matchId}:classes`)

      // Chaves do HostManager
      await this.redis.del(`match:${matchId}:room`)
      await this.redis.del(`match:${matchId}:status`)
      await this.redis.del(`match:${matchId}:host`)
      await this.redis.del(`match:${matchId}:hostPassword`)
      await this.redis.del(`room:${matchId}`) // (Chave que você viu)

      // Chave do ReadyManager
      await this.redis.del(`match:${matchId}:ready`)

      // Chave do LobbyManager
      await this.redis.del(`lobby:${matchId}:state`)
      await this.redis.del(`lobby:${matchId}:vetos`)

    log('info', `💾 Match ${matchId} resultados + MMR salvos: ${winner} venceu`)
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
    log('info', '✅ ValidationManager encerrado')
  }

  /**
   * Alias para stop()
   */
  shutdown(): void {
    this.stop()
  }
}
