import { prisma } from './prisma'
import { MatchSnapshot, MatchResult } from '../lobby/types'
import { log } from '../utils/logger'

/**
 * Salvar partida no banco quando INICIA
 */
export async function saveMatchToDatabase(match: MatchSnapshot): Promise<void> {
  try {
    // Filtrar jogadores com oidUser válido
    const validPlayers = match.players.filter(p => p.oidUser !== undefined && p.oidUser !== null)

    if (validPlayers.length === 0) {
      throw new Error('Nenhum jogador válido na partida')
    }

    // Criar registro da partida
    await prisma.$executeRaw`
      INSERT INTO BST_RankedMatch (
        id, lobbyId, gameMode, map, maxPlayers, roundTime, maxRounds, 
        autoBalance, serverIp, startedAt, status, createdAt
      )
      VALUES (
        ${match.matchId}, ${match.lobbyId}, ${match.settings.gameMode}, 
        ${match.settings.map}, ${match.settings.maxPlayers}, ${match.settings.roundTime}, 
        ${match.settings.maxRounds}, ${match.settings.autoBalance ? 1 : 0}, 
        ${match.serverIp || null}, ${match.startedAt}, 'in-progress', GETDATE()
      )
    `

    // Criar jogadores separadamente
    for (const player of validPlayers) {
      await prisma.$executeRaw`
        INSERT INTO BST_MatchPlayer (matchId, oidUser, team)
        VALUES (${match.matchId}, ${player.oidUser}, ${player.team || null})
      `
    }

    log('info', `💾 Partida ${match.matchId} salva no banco (${validPlayers.length} jogadores)`)
  } catch (error) {
    log('error', `❌ Erro ao salvar partida ${match.matchId}`, error)
    throw error
  }
}

/**
 * Atualizar resultado quando TERMINA
 */
export async function updateMatchResult(matchId: string, result: MatchResult): Promise<void> {
  try {
    // Atualizar registro da partida
    await prisma.$executeRaw`
      UPDATE BST_RankedMatch
      SET 
        winnerId = ${result.winnerId || null},
        winnerTeam = ${result.winnerTeam || null},
        scoreAlpha = ${result.scoreA || 0},
        scoreBravo = ${result.scoreB || 0},
        endReason = ${result.reason || 'completed'},
        endedAt = ${result.endedAt},
        duration = ${result.duration},
        status = 'completed'
      WHERE id = ${matchId}
    `

    // Atualizar stats dos jogadores
    await updatePlayerStats(matchId, result.winnerId, result.winnerTeam)

    log('info', `💾 Resultado da partida ${matchId} atualizado`)
  } catch (error) {
    log('error', `❌ Erro ao atualizar resultado ${matchId}`, error)
    throw error
  }
}

/**
 * Atualizar estatísticas dos jogadores
 */
async function updatePlayerStats(matchId: string, winnerId?: number, winnerTeam?: string): Promise<void> {
  try {
    // Buscar todos os jogadores da partida
    const matchPlayers = await prisma.$queryRaw<any[]>`
      SELECT oidUser, team
      FROM BST_MatchPlayer
      WHERE matchId = ${matchId}
    `

    // Atualizar stats de cada jogador
    for (const player of matchPlayers) {
      const isWinner = (winnerId && player.oidUser === winnerId) || (winnerTeam && player.team === winnerTeam)

      // Verifica se stats já existem
      const existing = await prisma.$queryRaw<any[]>`
        SELECT oidUser FROM BST_RankedUserStats WHERE oidUser = ${player.oidUser}
      `

      if (existing.length === 0) {
        // Cria novo registro
        await prisma.$executeRaw`
          INSERT INTO BST_RankedUserStats (oidUser, matchesPlayed, matchesWon, eloRating, lastMatchAt, createdAt, updatedAt)
          VALUES (${player.oidUser}, 1, ${isWinner ? 1 : 0}, 1000, GETDATE(), GETDATE(), GETDATE())
        `
      } else {
        // Atualiza existente
        await prisma.$executeRaw`
          UPDATE BST_RankedUserStats
          SET 
            matchesPlayed = matchesPlayed + 1,
            matchesWon = matchesWon + ${isWinner ? 1 : 0},
            lastMatchAt = GETDATE(),
            updatedAt = GETDATE()
          WHERE oidUser = ${player.oidUser}
        `
      }
    }

    log('info', `📊 Stats de ${matchPlayers.length} jogadores atualizados`)
  } catch (error) {
    log('error', `❌ Erro ao atualizar stats dos jogadores`, error)
    throw error
  }
}

/**
 * Buscar histórico de partidas de um jogador
 */
export async function getPlayerMatchHistory(oidUser: number, limit: number = 10) {
  try {
    const matches = await prisma.$queryRaw<any[]>`
      SELECT TOP ${limit}
        m.id, m.lobbyId, m.gameMode, m.map, m.startedAt, m.endedAt, 
        m.duration, m.winnerId, m.winnerTeam, m.scoreAlpha, m.scoreBravo, m.status
      FROM BST_RankedMatch m
      INNER JOIN BST_MatchPlayer p ON m.id = p.matchId
      WHERE p.oidUser = ${oidUser} AND m.status = 'completed'
      ORDER BY m.startedAt DESC
    `

    return matches
  } catch (error) {
    log('error', `❌ Erro ao buscar histórico do jogador ${oidUser}`, error)
    return []
  }
}

/**
 * Buscar stats de um jogador
 */
export async function getPlayerStats(oidUser: number) {
  try {
    const stats = await prisma.$queryRaw<any[]>`
      SELECT 
        s.oidUser, s.matchesPlayed, s.matchesWon, s.eloRating, s.lastMatchAt,
        u.NickName, a.strNexonID
      FROM BST_RankedUserStats s
      LEFT JOIN COMBATARMS.dbo.CBT_User u ON s.oidUser = u.oiduser
      LEFT JOIN COMBATARMS.dbo.CBT_UserAuth a ON s.oidUser = a.oidUser
      WHERE s.oidUser = ${oidUser}
    `

    return stats.length > 0 ? stats[0] : null
  } catch (error) {
    log('error', `❌ Erro ao buscar stats do jogador ${oidUser}`, error)
    return null
  }
}
