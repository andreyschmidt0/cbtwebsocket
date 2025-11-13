function isAssignmentState(obj: any): obj is AssignmentState {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    Object.prototype.hasOwnProperty.call(obj, 'alpha') &&
    Object.prototype.hasOwnProperty.call(obj, 'bravo') &&
    Array.isArray((obj as AssignmentState).alpha) &&
    Array.isArray((obj as AssignmentState).bravo)
  );
}
import { QueuePlayer, WeaponTier } from '../types'

export type TeamRole = 'SNIPER' | 'T1' | 'T2' | 'T3' | 'T4'

export interface TeamPlayerAssignment {
  player: QueuePlayer
  role: TeamRole
}

export interface BalancedTeams {
  ALPHA: TeamPlayerAssignment[]
  BRAVO: TeamPlayerAssignment[]
}

interface AssignmentState {
  diff: number
  alpha: TeamPlayerAssignment[]
  bravo: TeamPlayerAssignment[]
}

const ROLE_SLOTS: Array<{ team: 'ALPHA' | 'BRAVO'; role: TeamRole }> = [
  { team: 'ALPHA', role: 'SNIPER' },
  { team: 'BRAVO', role: 'SNIPER' },
  { team: 'ALPHA', role: 'T1' },
  { team: 'BRAVO', role: 'T1' },
  { team: 'ALPHA', role: 'T2' },
  { team: 'BRAVO', role: 'T2' },
  { team: 'ALPHA', role: 'T3' },
  { team: 'BRAVO', role: 'T3' },
  { team: 'ALPHA', role: 'T4' },
  { team: 'BRAVO', role: 'T4' }
]

const DEFAULT_CLASSES = { primary: 'T3', secondary: 'SMG' as WeaponTier }

export function balanceTeamsStrict(players: QueuePlayer[]): BalancedTeams | null {
  if (players.length < 10) return null

  const sortedPlayers = [...players].sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0))
  const used = new Set<number>()
  const alpha: TeamPlayerAssignment[] = []
  const bravo: TeamPlayerAssignment[] = []
  let best: AssignmentState | null = null

  const tryAssign: (slotIndex: number, alphaMMR: number, bravoMMR: number) => boolean = (slotIndex, alphaMMR, bravoMMR) => {
    if (slotIndex === ROLE_SLOTS.length) {
      const diff = Math.abs(alphaMMR - bravoMMR)
      if (!best || diff < best.diff) {
        best = {
          diff,
          alpha: [...alpha],
          bravo: [...bravo]
        }
      }
      return diff === 0
    }

    const slot = ROLE_SLOTS[slotIndex]
    const candidates = sortedPlayers
      .filter((p) => !used.has(p.oidUser))
      .map((player) => ({ player, priority: getRolePriority(player, slot.role) }))
      .filter((c) => c.priority !== null)
      .sort((a, b) => {
        const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0)
        if (priorityDiff !== 0) return priorityDiff
        const queuedDiff = (a.player.queuedAt || 0) - (b.player.queuedAt || 0)
        if (queuedDiff !== 0) return queuedDiff
        return b.player.mmr - a.player.mmr
      })

    if (candidates.length === 0) {
      return false
    }

    for (const candidate of candidates) {
      used.add(candidate.player.oidUser)
      if (slot.team === 'ALPHA') {
        alpha.push({ player: candidate.player, role: slot.role })
        if (tryAssign(slotIndex + 1, alphaMMR + candidate.player.mmr, bravoMMR)) return true
        alpha.pop()
      } else {
        bravo.push({ player: candidate.player, role: slot.role })
        if (tryAssign(slotIndex + 1, alphaMMR, bravoMMR + candidate.player.mmr)) return true
        bravo.pop()
      }
      used.delete(candidate.player.oidUser)
    }

    return false
  }

  tryAssign(0, 0, 0)
  if (isAssignmentState(best) && (best as AssignmentState).alpha.length === 5 && (best as AssignmentState).bravo.length === 5) {
    const typedBest = best as AssignmentState;
    return { ALPHA: typedBest.alpha, BRAVO: typedBest.bravo };
  }

  return null
}

function getRolePriority(player: QueuePlayer, role: TeamRole): number | null {
  const classes = player.classes || DEFAULT_CLASSES
  const primary = classes.primary
  const secondary = classes.secondary

  if (role === 'SNIPER') {
    if (primary === 'SNIPER') return 0
    if (secondary === 'SNIPER') return 1
    return null
  }

  if (primary === role) return 0
  if (primary === 'SMG') return 1
  if (secondary === role) return 2
  if (secondary === 'SMG') return 3
  return null
}
