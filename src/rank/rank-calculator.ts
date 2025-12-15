/**
 * SISTEMA DE CÁLCULO DE MMR - Performance-Based Distribution
 *
 * PARA PERDEDORES:
 * ================
 * O sistema distribui perdas de MMR baseado no desempenho individual relativo ao time.
 *
 * Fórmula: total = base + kills + kdr + mvp + balance + streak + performance + penalties
 *
 * Componentes:
 * - Base: -18 pontos (fixo para todos perdedores)
 * - Kills: floor(kills / 4) → A cada 4 kills ganha +1 ponto (mais generoso que vencedores)
 * - KDR Bonus: +1 a +4 baseado no K/D ratio
 * - Performance: -15 a +15 pontos baseado em z-score do desempenho relativo ao time
 * - Balance: ±5 pontos baseado na diferença de força dos times
 * - Penalties: -25 (FORFEIT), -10 (ZERO_REWARD), -5 (NO_LOG)
 *
 * Performance Score (usado para calcular z-score):
 * - Kills × 2.5 + K/D × 3 + Headshots × 0.6 + Objetivos × 2 + Assists × 0.8
 *
 * Z-Score Mitigation:
 * - Calcula z-score: (performanceScore - teamMean) / teamStd
 * - Clamp entre -2.0 e +2.0
 * - Multiplica por 7.5 → range de -15 a +15 pontos
 *
 * Exemplo Real (Time Perdedor de 5 jogadores):
 * - Melhor jogador (18K/14D): ~-20 MMR (mitigação alta)
 * - Jogador médio (10K/16D): ~-30 MMR (mitigação neutra)
 * - Pior jogador (6K/20D): ~-40 MMR (mitigação negativa)
 *
 * PARA VENCEDORES:
 * ================
 * Similar, mas com base +15 e sem performance mitigation (apenas bonuses positivos)
 */
import { RankTier, computeMatchmakingValue, getMaxPoints, getNextTier, getPreviousTier, getTierMeta } from './rank-tiers'

export interface PlayerRankState {
  rankTier: RankTier
  rankPoints: number
  winStreak: number
  lossProtection: number
  lossesAtZero: number
  md5Wins: number
  md5Losses: number
  md5Active: boolean
}

export interface PlayerMatchStats {
  kills: number
  deaths: number
  headshots: number
  assists: number
  bombPlants: number
  bombDefuses: number
}

export interface PlayerPenaltyImpact {
  points: number
  reason: string
}

export interface RankCalculationPlayerInput {
  oidUser: number
  username: string
  team: 'ALPHA' | 'BRAVO'
  didWin: boolean
  state: PlayerRankState
  stats: PlayerMatchStats
  penalty?: PlayerPenaltyImpact
  balanceDelta?: number
}

export interface RankMatchContext {
  winner: 'ALPHA' | 'BRAVO'
  teamStrength: { ALPHA: number; BRAVO: number }
}

export interface RankChangeBreakdown {
  base: number
  kills: number
  kdr: number
  mvp: number
  balance: number
  streak: number
  performance: number
  penalties: number
  wasMvp: boolean
}

export interface RankChangeResult {
  oidUser: number
  username: string
  delta: number
  oldTier: RankTier
  newTier: RankTier
  oldPoints: number
  newPoints: number
  matchmakingDelta: number
  breakdown: RankChangeBreakdown
  newState: PlayerRankState
  wasMvp: boolean
}

const BASE_POINTS = {
  WIN: 15,
  LOSS: -18
}

const STREAK_BONUS_PER_WIN = 2
const MVP_BONUS = 3

export function calculateRankChanges(
  players: RankCalculationPlayerInput[],
  context: RankMatchContext
): RankChangeResult[] {
  const mvpOid = determineMvp(players)
  // Calcula desempenho individual e estatÍsticas por time para mitigar perda em derrotas
  const performanceScores = new Map<number, number>()
  const teamBuckets: Record<'ALPHA' | 'BRAVO', number[]> = { ALPHA: [], BRAVO: [] }
  for (const player of players) {
    const score = computePerformanceScore(player.stats)
    performanceScores.set(player.oidUser, score)
    teamBuckets[player.team].push(score)
  }
  const teamStats = {
    ALPHA: computeMeanStd(teamBuckets.ALPHA),
    BRAVO: computeMeanStd(teamBuckets.BRAVO)
  }

  return players.map(player => {
    const score = performanceScores.get(player.oidUser) ?? 0
    const breakdown = calculateBreakdown(player, context, mvpOid, score, teamStats[player.team])
    return finalizeResult(player, breakdown)
  })
}

function calculateBreakdown(
  player: RankCalculationPlayerInput,
  context: RankMatchContext,
  mvpOid?: number,
  performanceScore: number = 0,
  teamStat: { mean: number; std: number } = { mean: 0, std: 1 }
): RankChangeBreakdown {
  const base = player.didWin ? BASE_POINTS.WIN : BASE_POINTS.LOSS

  // ATUALIZADO: Kills bonus mais generoso para perdedores (divide por 4 em vez de 5)
  const killDivisor = player.didWin ? 5 : 4
  const kills = Math.floor((player.stats.kills || 0) / killDivisor)

  const kdRatio = player.stats.deaths > 0
    ? player.stats.kills / player.stats.deaths
    : player.stats.kills

  let kdrBonus = 0
  if (kdRatio >= 2.5) kdrBonus = 4
  else if (kdRatio >= 2.0) kdrBonus = 3
  else if (kdRatio >= 1.5) kdrBonus = 2
  else if (kdRatio >= 1.0) kdrBonus = 1

  const balance = calculateBalanceBonus(player, context)
  const didGetMvp = player.oidUser === mvpOid
  const mvpBonus = didGetMvp ? MVP_BONUS : 0
  const newStreak = player.didWin ? player.state.winStreak + 1 : 0
  const streakBonus = player.didWin && newStreak > 1 ? (newStreak - 1) * STREAK_BONUS_PER_WIN : 0
  const penalties = player.penalty?.points ?? 0

  // Mitiga perda em derrotas conforme desempenho relativo ao time
  // ATUALIZADO: Aumenta o range de -10/+10 para -15/+15 para criar diferenças mais pronunciadas
  let performance = 0
  if (!player.didWin) {
    const z = teamStat.std > 0 ? (performanceScore - teamStat.mean) / teamStat.std : 0
    const clamped = Math.max(-2.0, Math.min(2.0, z))
    performance = Math.round(clamped * 7.5) // varia de -15 a +15 (após clamp)
  }

  return {
    base,
    kills,
    kdr: kdrBonus,
    mvp: mvpBonus,
    balance,
    streak: streakBonus,
    performance,
    penalties,
    wasMvp: didGetMvp
  }
}

function finalizeResult(player: RankCalculationPlayerInput, breakdown: RankChangeBreakdown): RankChangeResult {
  const componentsTotal =
    breakdown.base +
    breakdown.kills +
    breakdown.kdr +
    breakdown.mvp +
    breakdown.balance +
    breakdown.streak +
    breakdown.performance +
    breakdown.penalties

  const oldTier = player.state.rankTier
  const oldPoints = player.state.rankPoints
  let newTier = oldTier
  let newPoints = oldPoints + componentsTotal
  const updatedWinStreak = player.didWin ? player.state.winStreak + 1 : 0
  let winStreak = updatedWinStreak
  let lossProtection = player.state.lossProtection
  let lossesAtZero = player.state.lossesAtZero
  let md5Wins = player.state.md5Wins
  let md5Losses = player.state.md5Losses
  let md5Active = player.state.md5Active

  const tierMeta = getTierMeta(oldTier)

  if (md5Active) {
    ({ md5Wins, md5Losses, md5Active, newTier, newPoints, lossProtection } =
      resolveMd5Series(player, md5Wins, md5Losses, lossProtection))
  } else {
    if (newPoints >= getMaxPoints(oldTier) && tierMeta.requiresMd5) {
      md5Active = true
      md5Wins = 0
      md5Losses = 0
      newPoints = getMaxPoints(oldTier)
    }
  }

  if (!md5Active) {
    if (newPoints >= getMaxPoints(newTier) && !getTierMeta(newTier).isInfinite) {
      const next = getNextTier(newTier)
      if (next) {
        newTier = next
        newPoints = 0
        lossProtection = getTierMeta(next).promotionLossProtection
        lossesAtZero = 0
      } else {
        newPoints = Math.min(newPoints, getMaxPoints(newTier))
      }
    } else if (newPoints < 0) {
      ({ newTier, newPoints, lossProtection, lossesAtZero } =
        handleDemotion(newTier, lossProtection, lossesAtZero))
    }
  }

  if (!player.didWin && newPoints === 0) {
    lossesAtZero += 1
  } else if (player.didWin) {
    lossesAtZero = 0
  }

  newPoints = Math.max(newPoints, 0)

  const oldMatchValue = computeMatchmakingValue(oldTier, oldPoints)
  const newMatchValue = computeMatchmakingValue(newTier, newPoints)

  return {
    oidUser: player.oidUser,
    username: player.username,
    delta: newMatchValue - oldMatchValue,
    oldTier,
    newTier,
    oldPoints,
    newPoints,
    matchmakingDelta: newMatchValue - oldMatchValue,
    breakdown,
    newState: {
      rankTier: newTier,
      rankPoints: newPoints,
      winStreak,
      lossProtection,
      lossesAtZero,
      md5Wins,
      md5Losses,
      md5Active
    },
    wasMvp: breakdown.wasMvp
  }
}

function calculateBalanceBonus(
  player: RankCalculationPlayerInput,
  context: RankMatchContext
): number {
  const teamPower = context.teamStrength[player.team]
  const opponentPower = context.teamStrength[player.team === 'ALPHA' ? 'BRAVO' : 'ALPHA']
  const diff = opponentPower - teamPower
  const scaled = Math.max(-5, Math.min(5, Math.round(diff / 50)))
  if (player.didWin && scaled > 0) {
    return scaled
  }
  if (!player.didWin && scaled < 0) {
    return scaled
  }
  return 0
}

function determineMvp(players: RankCalculationPlayerInput[]): number | undefined {
  let bestScore = -Infinity
  let bestOid: number | undefined
  for (const player of players) {
    const { kills, deaths, headshots, bombPlants, bombDefuses, assists } = player.stats
    const kd = deaths > 0 ? kills / deaths : kills
    const objectiveScore = bombPlants + bombDefuses
    const score = kills * 1.5 + kd + headshots * 0.4 + objectiveScore * 2 + assists * 0.5 + (player.didWin ? 2 : 0)
    if (score > bestScore) {
      bestScore = score
      bestOid = player.oidUser
    }
  }
  return bestOid
}

// Usa a mesma base do critÈrio de MVP, mas sem depender do resultado (vitÛria/derrota)
// Atualizado para dar MAIS PESO ao K/D/A e criar diferenças mais pronunciadas
function computePerformanceScore(stats: PlayerMatchStats): number {
  const { kills, deaths, headshots, bombPlants, bombDefuses, assists } = stats
  const kd = deaths > 0 ? kills / deaths : kills
  const objectiveScore = bombPlants + bombDefuses

  // Aumenta peso do K/D e kills para criar diferenças mais significativas
  return kills * 2.5 + kd * 3 + headshots * 0.6 + objectiveScore * 2 + assists * 0.8
}

function computeMeanStd(values: number[]): { mean: number; std: number } {
  if (!values.length) return { mean: 0, std: 1 }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
  const std = Math.sqrt(Math.max(variance, 0.0001))
  return { mean, std }
}

function resolveMd5Series(
  player: RankCalculationPlayerInput,
  md5Wins: number,
  md5Losses: number,
  lossProtection: number
) {
  if (player.didWin) {
    md5Wins += 1
  } else {
    md5Losses += 1
  }

  let newTier = player.state.rankTier
  let newPoints = player.state.rankPoints
  let md5Active = true

  if (md5Wins >= 3) {
    const promoted = getNextTier('DIAMOND_3')
    newTier = promoted ?? 'ELITE'
    newPoints = 0
    lossProtection = getTierMeta(newTier).promotionLossProtection
    md5Wins = 0
    md5Losses = 0
    md5Active = false
  } else if (md5Losses >= 3) {
    newTier = 'DIAMOND_3'
    newPoints = 70
    lossProtection = getTierMeta('DIAMOND_3').promotionLossProtection
    md5Wins = 0
    md5Losses = 0
    md5Active = false
  } else {
    newPoints = Math.max(player.state.rankPoints, 100)
  }

  return { md5Wins, md5Losses, md5Active, newTier, newPoints, lossProtection }
}

function handleDemotion(
  tier: RankTier,
  lossProtection: number,
  lossesAtZero: number
) {
  const meta = getTierMeta(tier)
  if (!meta.canDemote) {
    return { newTier: tier, newPoints: 0, lossProtection, lossesAtZero }
  }

  if (lossProtection > 0) {
    return { newTier: tier, newPoints: 0, lossProtection: lossProtection - 1, lossesAtZero: 0 }
  }

  const previousTier = getPreviousTier(tier)
  if (!previousTier) {
    return { newTier: tier, newPoints: 0, lossProtection, lossesAtZero }
  }

  return {
    newTier: previousTier,
    newPoints: 70,
    lossProtection: getTierMeta(previousTier).promotionLossProtection,
    lossesAtZero: 0
  }
}
