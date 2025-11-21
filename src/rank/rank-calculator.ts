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
  LOSS: -15
}

const STREAK_BONUS_PER_WIN = 2
const MVP_BONUS = 3

export function calculateRankChanges(
  players: RankCalculationPlayerInput[],
  context: RankMatchContext
): RankChangeResult[] {
  const mvpOid = determineMvp(players)
  return players.map(player => {
    const breakdown = calculateBreakdown(player, context, mvpOid)
    return finalizeResult(player, breakdown)
  })
}

function calculateBreakdown(
  player: RankCalculationPlayerInput,
  context: RankMatchContext,
  mvpOid?: number
): RankChangeBreakdown {
  const base = player.didWin ? BASE_POINTS.WIN : BASE_POINTS.LOSS
  const kills = Math.floor((player.stats.kills || 0) / 5)

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

  return {
    base,
    kills,
    kdr: kdrBonus,
    mvp: mvpBonus,
    balance,
    streak: streakBonus,
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
    const { kills, deaths, headshots, bombPlants, bombDefuses } = player.stats
    const kd = deaths > 0 ? kills / deaths : kills
    const objectiveScore = bombPlants + bombDefuses
    const score = kills * 1.5 + kd + headshots * 0.4 + objectiveScore * 2 + (player.didWin ? 2 : 0)
    if (score > bestScore) {
      bestScore = score
      bestOid = player.oidUser
    }
  }
  return bestOid
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
