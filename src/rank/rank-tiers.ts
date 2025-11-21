export type RankTier =
  | 'BRONZE_3'
  | 'BRONZE_2'
  | 'BRONZE_1'
  | 'SILVER_3'
  | 'SILVER_2'
  | 'SILVER_1'
  | 'GOLD_3'
  | 'GOLD_2'
  | 'GOLD_1'
  | 'PLATINUM_3'
  | 'PLATINUM_2'
  | 'PLATINUM_1'
  | 'DIAMOND_3'
  | 'DIAMOND_2'
  | 'DIAMOND_1'
  | 'ELITE'
  | 'PRO'

export interface TierMeta {
  order: number
  label: string
  maxPoints: number
  canDemote: boolean
  promotionLossProtection: number
  isInfinite: boolean
  requiresMd5?: boolean
}

export const DEFAULT_TIER: RankTier = 'SILVER_2'

export const TIER_ORDER: RankTier[] = [
  'BRONZE_3',
  'BRONZE_2',
  'BRONZE_1',
  'SILVER_3',
  'SILVER_2',
  'SILVER_1',
  'GOLD_3',
  'GOLD_2',
  'GOLD_1',
  'PLATINUM_3',
  'PLATINUM_2',
  'PLATINUM_1',
  'DIAMOND_3',
  'DIAMOND_2',
  'DIAMOND_1',
  'ELITE',
  'PRO'
]

const TIER_META: Record<RankTier, TierMeta> = {
  BRONZE_3: { order: 0, label: 'Bronze 3', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  BRONZE_2: { order: 1, label: 'Bronze 2', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  BRONZE_1: { order: 2, label: 'Bronze 1', maxPoints: 100, canDemote: false, promotionLossProtection: 0, isInfinite: false },
  SILVER_3: { order: 3, label: 'Prata 3', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  SILVER_2: { order: 4, label: 'Prata 2', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  SILVER_1: { order: 5, label: 'Prata 1', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  GOLD_3: { order: 6, label: 'Ouro 3', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  GOLD_2: { order: 7, label: 'Ouro 2', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  GOLD_1: { order: 8, label: 'Ouro 1', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  PLATINUM_3: { order: 9, label: 'Platina 3', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  PLATINUM_2: { order: 10, label: 'Platina 2', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  PLATINUM_1: { order: 11, label: 'Platina 1', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  DIAMOND_3: { order: 12, label: 'Diamante 3', maxPoints: 100, canDemote: true, promotionLossProtection: 3, isInfinite: false, requiresMd5: true },
  DIAMOND_2: { order: 13, label: 'Diamante 2', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  DIAMOND_1: { order: 14, label: 'Diamante 1', maxPoints: 100, canDemote: true, promotionLossProtection: 1, isInfinite: false },
  ELITE: { order: 15, label: 'Elite', maxPoints: Number.MAX_SAFE_INTEGER, canDemote: true, promotionLossProtection: 0, isInfinite: true },
  PRO: { order: 16, label: 'Pro', maxPoints: Number.MAX_SAFE_INTEGER, canDemote: false, promotionLossProtection: 0, isInfinite: true }
}

export function getTierMeta(tier: RankTier): TierMeta {
  return TIER_META[tier]
}

export function getTierIndex(tier: RankTier): number {
  return TIER_META[tier].order
}

export function getNextTier(tier: RankTier): RankTier | null {
  const currentIndex = getTierIndex(tier)
  const next = TIER_ORDER[currentIndex + 1]
  return next ?? null
}

export function getPreviousTier(tier: RankTier): RankTier | null {
  const currentIndex = getTierIndex(tier)
  const prev = TIER_ORDER[currentIndex - 1]
  return prev ?? null
}

export function getMaxPoints(tier: RankTier): number {
  return getTierMeta(tier).maxPoints
}

export function computeMatchmakingValue(tier: RankTier, points: number): number {
  const index = getTierIndex(tier)
  const meta = getTierMeta(tier)
  const cappedPoints = meta.isInfinite ? Math.max(0, points) : Math.min(Math.max(points, 0), meta.maxPoints)
  return index * 100 + cappedPoints
}

export function formatTierLabel(tier: RankTier): string {
  return getTierMeta(tier).label
}

const TIER_BACKGROUND_MAP: Record<RankTier, number> = {
  PRO: 1,
  ELITE: 2,
  DIAMOND_3: 3,
  DIAMOND_2: 4,
  DIAMOND_1: 5,
  PLATINUM_3: 6,
  PLATINUM_2: 7,
  PLATINUM_1: 8,
  GOLD_3: 9,
  GOLD_2: 10,
  GOLD_1: 11,
  SILVER_3: 12,
  SILVER_2: 13,
  SILVER_1: 14,
  BRONZE_3: 15,
  BRONZE_2: 16,
  BRONZE_1: 17
}

export function getBackgroundIdForTier(tier: RankTier): number {
  return TIER_BACKGROUND_MAP[tier] ?? 0
}
