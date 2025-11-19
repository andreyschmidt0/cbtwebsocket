import { log } from '../utils/logger'

/**
 * Configuração do Sistema de MMR
 * Baseado em Elo Rating + ajustes modernos (LoL, CS:GO, Valorant)
 */
const MMR_CONFIG = {
  // Ratings Iniciais
  INITIAL_MMR: 1000,
  PLACEMENT_MATCHES: 10, // Primeiras 10 partidas = calibração

  // Fator K (sensibilidade de mudança)
  K_FACTOR: {
    PLACEMENT: 60,     // Primeiras 10 partidas (alta volatilidade)
    NEW_PLAYER: 32,    // Até 50 partidas
    EXPERIENCED: 24,   // 50-200 partidas
    VETERAN: 16        // 200+ partidas
  },

  // Bônus/Penalidades
  ABANDON_PENALTY: -50,           // Jogador que abandonou
  TEAM_DISADVANTAGE_BONUS: 25,   // Por jogador faltando no time (+25 MMR)
  PERFORMANCE_MULTIPLIER: 0.15,  // 15% de ajuste por performance individual
  WIN_STREAK_BONUS: 5,           // +5 MMR por vitória consecutiva (max 3 stacks)

  // Pesos de Performance (sem damage)
  PERFORMANCE_WEIGHTS: {
    KD_RATIO: 0.50,           // 50% - K/D ratio
    KILL_PARTICIPATION: 0.30, // 30% - % de kills do time
    HEADSHOT_ACCURACY: 0.20   // 20% - % headshots
  },

  PLACEMENT_JUMP_THRESHOLD: 3.0,
  PLACEMENT_SELECTION_MMR: 300,

  // Limites
  MIN_MMR: 0,
  MAX_MMR: 3000,
  MAX_MMR_CHANGE: 60  // Mudança máxima por partida
}

/**
 * Dados de um jogador para cálculo de MMR
 */
export interface PlayerMatchData {
  oidUser: number
  username: string
  team: 'ALPHA' | 'BRAVO'
  currentMMR: number
  matchesPlayed: number
  placementCompleted?: boolean
  
  // Performance individual (do BST_Fullmatchlog)
  kills: number
  deaths: number
  assists: number
  headshots: number
  
  // Status
  didWin: boolean
  didAbandon: boolean
}

/**
 * Resultado do cálculo de MMR
 */
export interface MMRCalculationResult {
  oidUser: number
  username: string
  oldMMR: number
  newMMR: number
  change: number
  breakdown: {
    baseChange: number
    performanceBonus: number
    disadvantageBonus: number
    abandonPenalty: number
    winStreakBonus: number
    placementSeedingBonus: number
  }
}

/**
 * Match Validator - Cálculo de MMR e Validação
 * Sistema híbrido baseado em Elo + ajustes modernos
 */
export class MatchValidator {
  /**
   * Calcula MMR para todos os jogadores de uma partida
   * 
   * @param players - Dados dos jogadores (stats + MMR atual)
   * @param _winnerTeam - Time vencedor ('ALPHA' ou 'BRAVO') - não usado diretamente pois didWin já indica
   * @returns Array com mudanças de MMR para cada jogador
   */
  static calculateMMRChanges(
    players: PlayerMatchData[],
    _winnerTeam: 'ALPHA' | 'BRAVO'
  ): MMRCalculationResult[] {
    // Separa times
    const alphaPlayers = players.filter(p => p.team === 'ALPHA')
    const bravoPlayers = players.filter(p => p.team === 'BRAVO')

    // Calcula MMR médio de cada time
    const alphaAvgMMR = this.calculateAverageMMR(alphaPlayers)
    const bravoAvgMMR = this.calculateAverageMMR(bravoPlayers)

    log('info', `📊 MMR médio - ALPHA: ${alphaAvgMMR.toFixed(1)} | BRAVO: ${bravoAvgMMR.toFixed(1)}`)

    // Detecta times desbalanceados (jogadores faltando)
    const alphaDisadvantage = Math.max(0, 5 - alphaPlayers.length)
    const bravoDisadvantage = Math.max(0, 5 - bravoPlayers.length)

    // Processa cada jogador
    return players.map(player => {
      // Jogadores que abandonaram recebem penalidade fixa
      if (player.didAbandon) {
        return {
          oidUser: player.oidUser,
          username: player.username,
          oldMMR: player.currentMMR,
          newMMR: Math.max(
            MMR_CONFIG.MIN_MMR,
            player.currentMMR + MMR_CONFIG.ABANDON_PENALTY
          ),
          change: MMR_CONFIG.ABANDON_PENALTY,
          breakdown: {
            baseChange: 0,
            performanceBonus: 0,
            disadvantageBonus: 0,
            abandonPenalty: MMR_CONFIG.ABANDON_PENALTY,
            winStreakBonus: 0,
            placementSeedingBonus: 0
          }
        }
      }

      // Calcula MMR base (Elo Rating System)
      const opponentAvgMMR = player.team === 'ALPHA' ? bravoAvgMMR : alphaAvgMMR
      const baseChange = this.calculateBaseMMRChange(
        player.currentMMR,
        opponentAvgMMR,
        player.didWin,
        player.matchesPlayed
      )

      // Calcula bônus de performance individual
      const performanceBonus = this.calculatePerformanceBonus(
        player,
        players.filter(p => p.team === player.team),
        baseChange
      )

      // Bônus por time desbalanceado (se venceu com menos jogadores)
      const disadvantage = player.team === 'ALPHA' ? alphaDisadvantage : bravoDisadvantage
      const disadvantageBonus = player.didWin && disadvantage > 0
        ? disadvantage * MMR_CONFIG.TEAM_DISADVANTAGE_BONUS
        : 0

      // TODO: Implementar win streak bonus (requer histórico de partidas)
      const winStreakBonus = 0

      let placementSeedingBonus = 0
      let maxChange = MMR_CONFIG.MAX_MMR_CHANGE

      const isPlacementMatch = !player.placementCompleted && player.matchesPlayed < MMR_CONFIG.PLACEMENT_MATCHES
      if (isPlacementMatch && player.didWin) {
        const totalKda = player.kills + player.assists
        const kdaRatio = player.deaths > 0 ? totalKda / player.deaths : totalKda
        if (kdaRatio >= MMR_CONFIG.PLACEMENT_JUMP_THRESHOLD) {
          placementSeedingBonus = MMR_CONFIG.PLACEMENT_SELECTION_MMR
          maxChange = Math.max(maxChange, placementSeedingBonus)
          log('info', `🚀 Jogador ${player.username} (MD10) atingiu KDA ${kdaRatio.toFixed(2)}. Aplicando bônus +${placementSeedingBonus}.`)
        }
      }

      // Soma todos os componentes
      let totalChange = baseChange + performanceBonus + disadvantageBonus + winStreakBonus + placementSeedingBonus

      // Aplica limites
      totalChange = Math.max(-maxChange, Math.min(maxChange, totalChange))

      const newMMR = Math.max(
        MMR_CONFIG.MIN_MMR,
        Math.min(MMR_CONFIG.MAX_MMR, player.currentMMR + totalChange)
      )

      return {
        oidUser: player.oidUser,
        username: player.username,
        oldMMR: player.currentMMR,
        newMMR: Math.round(newMMR),
        change: Math.round(totalChange),
        breakdown: {
          baseChange: Math.round(baseChange),
          performanceBonus: Math.round(performanceBonus),
          disadvantageBonus: Math.round(disadvantageBonus),
          abandonPenalty: 0,
          winStreakBonus: Math.round(winStreakBonus),
          placementSeedingBonus: Math.round(placementSeedingBonus)
        }
      }
    })
  }

  /**
   * Calcula mudança base de MMR usando Elo Rating System
   * 
   * Fórmula: ΔR = K * (S - E)
   * Onde:
   * - K = Fator de sensibilidade (varia por experiência)
   * - S = Resultado real (1 = vitória, 0 = derrota)
   * - E = Resultado esperado (probabilidade de vitória)
   */
  private static calculateBaseMMRChange(
    playerMMR: number,
    opponentAvgMMR: number,
    didWin: boolean,
    matchesPlayed: number
  ): number {
    // Determina fator K baseado em experiência
    const K = this.getKFactor(matchesPlayed)

    // Calcula resultado esperado (fórmula de Elo)
    const expectedOutcome = this.calculateExpectedOutcome(playerMMR, opponentAvgMMR)

    // Resultado real (1 = vitória, 0 = derrota)
    const actualOutcome = didWin ? 1 : 0

    // Mudança de MMR
    const change = K * (actualOutcome - expectedOutcome)

    log('debug', `🔢 MMR Base: ${playerMMR} vs ${opponentAvgMMR.toFixed(1)} | K=${K} | E=${expectedOutcome.toFixed(2)} | Δ=${change.toFixed(1)}`)

    return change
  }

  /**
   * Calcula probabilidade de vitória usando fórmula de Elo
   * 
   * P(A vence B) = 1 / (1 + 10^((RatingB - RatingA) / 400))
   */
  private static calculateExpectedOutcome(playerMMR: number, opponentMMR: number): number {
    return 1 / (1 + Math.pow(10, (opponentMMR - playerMMR) / 400))
  }

  /**
   * Determina fator K baseado em número de partidas jogadas
   * 
   * Jogadores novos têm K alto (volatilidade) para calibração rápida
   * Jogadores experientes têm K baixo (estabilidade)
   */
  private static getKFactor(matchesPlayed: number): number {
    if (matchesPlayed < MMR_CONFIG.PLACEMENT_MATCHES) {
      return MMR_CONFIG.K_FACTOR.PLACEMENT
    } else if (matchesPlayed < 50) {
      return MMR_CONFIG.K_FACTOR.NEW_PLAYER
    } else if (matchesPlayed < 200) {
      return MMR_CONFIG.K_FACTOR.EXPERIENCED
    } else {
      return MMR_CONFIG.K_FACTOR.VETERAN
    }
  }

  /**
   * Calcula bônus de performance individual
   * 
   * Baseado em CS:GO/Valorant: jogadores que performam acima da média
   * do time recebem bônus (ou penalidade se abaixo)
   * 
   * Métricas consideradas (sem damage):
   * - K/D ratio (peso 50%)
   * - Kill participation (peso 30%)
   * - Headshot accuracy (peso 20%)
   */
  private static calculatePerformanceBonus(
    player: PlayerMatchData,
    teammates: PlayerMatchData[],
    baseChange: number
  ): number {
    // Calcula métricas individuais
    const kd = player.deaths > 0 ? player.kills / player.deaths : player.kills
    const totalTeamKills = teammates.reduce((sum, p) => sum + p.kills, 0)
    const killParticipation = totalTeamKills > 0
      ? (player.kills + player.assists) / totalTeamKills
      : 0
    const hsAccuracy = player.kills > 0 ? player.headshots / player.kills : 0

    // Calcula médias do time
    const avgKD = teammates.reduce((sum, p) => {
      return sum + (p.deaths > 0 ? p.kills / p.deaths : p.kills)
    }, 0) / teammates.length

    // Calcula score de performance (0.0 a 2.0, média = 1.0)
    const kdScore = kd / (avgKD || 1)
    const kpScore = killParticipation // já é porcentagem
    const hsScore = hsAccuracy * 2 // 0.5 HS% = score 1.0

    // Média ponderada (K/D 50%, Kill Participation 30%, Headshots 20%)
    const performanceScore = (
      kdScore * MMR_CONFIG.PERFORMANCE_WEIGHTS.KD_RATIO +
      kpScore * MMR_CONFIG.PERFORMANCE_WEIGHTS.KILL_PARTICIPATION +
      hsScore * MMR_CONFIG.PERFORMANCE_WEIGHTS.HEADSHOT_ACCURACY
    )

    // Converte para bônus/penalidade (máximo ±15% do baseChange)
    const bonus = (performanceScore - 1.0) * Math.abs(baseChange) * MMR_CONFIG.PERFORMANCE_MULTIPLIER

    log('debug', `⚡ Performance ${player.username}: K/D=${kd.toFixed(2)} | KP=${(killParticipation * 100).toFixed(1)}% | HS=${(hsAccuracy * 100).toFixed(1)}% | Score=${performanceScore.toFixed(2)} | Bonus=${bonus.toFixed(1)}`)

    return bonus
  }

  /**
   * Calcula MMR médio de um time
   */
  private static calculateAverageMMR(players: PlayerMatchData[]): number {
    if (players.length === 0) return MMR_CONFIG.INITIAL_MMR
    return players.reduce((sum, p) => sum + p.currentMMR, 0) / players.length
  }

  /**
   * Valida se uma partida tem dados suficientes para cálculo de MMR
   * 
   * Critérios:
   * - Mínimo 3 jogadores por time
   * - Diferença máxima de 2 jogadores entre times
   * - Todos jogadores têm stats válidas
   */
  static validateMatchData(players: PlayerMatchData[]): {
    valid: boolean
    reason?: string
  } {
    const alphaPlayers = players.filter(p => p.team === 'ALPHA')
    const bravoPlayers = players.filter(p => p.team === 'BRAVO')

    // Mínimo de jogadores
    if (alphaPlayers.length < 3 || bravoPlayers.length < 3) {
      return {
        valid: false,
        reason: `Times insuficientes (ALPHA: ${alphaPlayers.length}, BRAVO: ${bravoPlayers.length})`
      }
    }

    // Diferença máxima entre times
    const diff = Math.abs(alphaPlayers.length - bravoPlayers.length)
    if (diff > 2) {
      return {
        valid: false,
        reason: `Diferença entre times muito grande (${diff} jogadores)`
      }
    }

    // Valida stats individuais
    for (const player of players) {
      if (player.kills < 0 || player.deaths < 0 || player.headshots < 0) {
        return {
          valid: false,
          reason: `Stats inválidas para jogador ${player.username}`
        }
      }
    }

    return { valid: true }
  }

  /**
   * Formata resultado de MMR para logs/notificações
   */
  static formatMMRResult(result: MMRCalculationResult): string {
    const sign = result.change >= 0 ? '+' : ''
    const arrow = result.change >= 0 ? '📈' : '📉'
    
    let details = `${arrow} ${result.username}: ${result.oldMMR} → ${result.newMMR} (${sign}${result.change})`
    
    // Breakdown detalhado
    if (result.breakdown.performanceBonus !== 0) {
      details += ` [Perf: ${sign}${result.breakdown.performanceBonus}]`
    }
    if (result.breakdown.disadvantageBonus > 0) {
      details += ` [Desvantagem: +${result.breakdown.disadvantageBonus}]`
    }
    if (result.breakdown.abandonPenalty < 0) {
      details += ` [ABANDONO: ${result.breakdown.abandonPenalty}]`
    }

    return details
  }

  /**
   * Exporta constantes de configuração para uso externo
   */
  static get CONFIG() {
    return MMR_CONFIG
  }
}
