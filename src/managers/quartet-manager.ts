import { prismaRanked, prismaGame } from '../database/prisma'
import { log } from '../utils/logger'

type QuartetInviteStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REMOVED'

export interface QuartetInviteRecord {
  requesterOidUser: number
  targetOidUser: number
  status: QuartetInviteStatus
  targetPos: number | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Visão de convite de quarteto
 * IMPORTANTE: Todos os campos são obrigatórios para garantir integridade dos dados
 */
export interface QuartetInviteView {
  oidUser: number
  username: string // OBRIGATÓRIO - nunca deve ser null
  status: QuartetInviteStatus
  isRequester: boolean
  targetPos: number // OBRIGATÓRIO - deve ser 1, 2 ou 3
}

export interface QuartetInfo {
  quartetId: number
  captainOidUser: number
  member1OidUser: number | null
  member2OidUser: number | null
  member3OidUser: number | null
  createdAt: Date
  active: boolean
}

export class QuartetManager {
  private async isUserInEventQuartet(oidUser: number): Promise<boolean> {
    try {
      const rows = await prismaGame.$queryRaw<{ ok: number }[]>`
        SELECT TOP 1 1 AS ok
        FROM dbo.BST_EventQuartetMember
        WHERE oidUser = ${oidUser}
      `
      return rows.length > 0
    } catch {
      return false
    }
  }

  private async getDiscordIdByOidUser(oidUser: number): Promise<string | null> {
    try {
      const rows = await prismaRanked.$queryRaw<{ strDiscordID: string | null }[]>`
        SELECT TOP 1 strDiscordID
        FROM COMBATARMS.dbo.CBT_UserAuth
        WHERE oidUser = ${oidUser}
      `
      const discordId = rows[0]?.strDiscordID?.trim()
      return discordId ? discordId : null
    } catch {
      return null
    }
  }

  /**
   * Envia convite para formar quarteto
   * @param targetPos - Posição OBRIGATÓRIA no quarteto (1, 2 ou 3)
   */
  async sendInvite(
    requesterOidUser: number,
    targetOidUser: number,
    targetPos: 1 | 2 | 3
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!requesterOidUser || !targetOidUser || requesterOidUser === targetOidUser) {
      return { ok: false, reason: 'INVALID_TARGET' }
    }

    // Validação: targetPos é obrigatório e deve ser 1, 2 ou 3
    if (targetPos !== 1 && targetPos !== 2 && targetPos !== 3) {
      return { ok: false, reason: 'INVALID_POSITION' }
    }

    const normalizedTargetPos = targetPos

    try {
      // Verifica se já existe algum convite entre os dois (em qualquer direção)
      const targetAlreadyInQuartet = await this.isUserInEventQuartet(targetOidUser)
      if (targetAlreadyInQuartet) {
        return { ok: false, reason: 'ALREADY_IN_QUARTET' }
      }

      const [requesterDiscordId, targetDiscordId] = await Promise.all([
        this.getDiscordIdByOidUser(requesterOidUser),
        this.getDiscordIdByOidUser(targetOidUser)
      ])

      if (requesterDiscordId && targetDiscordId && requesterDiscordId === targetDiscordId) {
        return { ok: false, reason: 'DISCORD_ALREADY_IN_QUARTET' }
      }

      if (targetDiscordId) {
        const duplicatedDiscordInInvites = await prismaRanked.$queryRaw<{ ok: number }[]>`
          SELECT TOP 1 1 AS ok
          FROM BST_QuartetInvites i
          INNER JOIN COMBATARMS.dbo.CBT_UserAuth ua
            ON ua.oidUser = CASE
              WHEN i.requesterOidUser = ${requesterOidUser} THEN i.targetOidUser
              ELSE i.requesterOidUser
            END
          WHERE i.status IN ('PENDING','ACCEPTED')
            AND (i.requesterOidUser = ${requesterOidUser} OR i.targetOidUser = ${requesterOidUser})
            AND (CASE
              WHEN i.requesterOidUser = ${requesterOidUser} THEN i.targetOidUser
              ELSE i.requesterOidUser
            END) <> ${targetOidUser}
            AND LTRIM(RTRIM(ua.strDiscordID)) = ${targetDiscordId}
        `

        if (duplicatedDiscordInInvites.length > 0) {
          return { ok: false, reason: 'DISCORD_ALREADY_IN_QUARTET' }
        }
      }

      const existing = await prismaRanked.$queryRaw<QuartetInviteRecord[]>`
        SELECT TOP 1 requesterOidUser, targetOidUser, status, targetPos, createdAt, updatedAt
        FROM BST_QuartetInvites
        WHERE
          (requesterOidUser = ${requesterOidUser} AND targetOidUser = ${targetOidUser})
          OR
          (requesterOidUser = ${targetOidUser} AND targetOidUser = ${requesterOidUser})
      `

      if (existing.length > 0) {
        const row = existing[0]
        if (row.status === 'ACCEPTED') {
          return { ok: false, reason: 'ALREADY_IN_QUARTET' }
        }
        if (row.status === 'PENDING') {
          // Se o alvo já tinha enviado antes, considerar aceitar direto
          if (row.requesterOidUser === targetOidUser && row.targetOidUser === requesterOidUser) {
            await prismaRanked.$executeRaw`
              UPDATE BST_QuartetInvites
              SET status = 'ACCEPTED', updatedAt = GETDATE(), targetPos = COALESCE(targetPos, ${normalizedTargetPos})
              WHERE requesterOidUser = ${targetOidUser} AND targetOidUser = ${requesterOidUser} AND status = 'PENDING'
            `
            return { ok: true }
          }
          return { ok: false, reason: 'INVITE_ALREADY_SENT' }
        }
      }

      // Remove registros antigos marcados como rejeitados/removidos para evitar PK duplicada
      await prismaRanked.$executeRaw`
        DELETE FROM BST_QuartetInvites
        WHERE status IN ('REJECTED','REMOVED') AND (
          (requesterOidUser = ${requesterOidUser} AND targetOidUser = ${targetOidUser})
          OR
          (requesterOidUser = ${targetOidUser} AND targetOidUser = ${requesterOidUser})
        )
      `

      await prismaRanked.$executeRaw`
        INSERT INTO BST_QuartetInvites (requesterOidUser, targetOidUser, status, targetPos, createdAt, updatedAt)
        VALUES (${requesterOidUser}, ${targetOidUser}, 'PENDING', ${normalizedTargetPos}, GETDATE(), GETDATE())
      `
      return { ok: true }
    } catch (err) {
      log('error', 'Erro ao enviar convite de quarteto', err)
      return { ok: false, reason: 'INTERNAL_ERROR' }
    }
  }

  /**
   * Aceita convite de quarteto
   */
  async acceptInvite(requesterOidUser: number, targetOidUser: number): Promise<{ ok: boolean; reason?: string }> {
    try {
      const [requesterDiscordId, targetDiscordId] = await Promise.all([
        this.getDiscordIdByOidUser(requesterOidUser),
        this.getDiscordIdByOidUser(targetOidUser)
      ])

      if (requesterDiscordId && targetDiscordId && requesterDiscordId === targetDiscordId) {
        return { ok: false, reason: 'DISCORD_ALREADY_IN_QUARTET' }
      }

      if (targetDiscordId) {
        const duplicatedDiscordInInvites = await prismaRanked.$queryRaw<{ ok: number }[]>`
          SELECT TOP 1 1 AS ok
          FROM BST_QuartetInvites i
          INNER JOIN COMBATARMS.dbo.CBT_UserAuth ua
            ON ua.oidUser = CASE
              WHEN i.requesterOidUser = ${requesterOidUser} THEN i.targetOidUser
              ELSE i.requesterOidUser
            END
          WHERE i.status IN ('PENDING','ACCEPTED')
            AND (i.requesterOidUser = ${requesterOidUser} OR i.targetOidUser = ${requesterOidUser})
            AND (CASE
              WHEN i.requesterOidUser = ${requesterOidUser} THEN i.targetOidUser
              ELSE i.requesterOidUser
            END) <> ${targetOidUser}
            AND LTRIM(RTRIM(ua.strDiscordID)) = ${targetDiscordId}
        `

        if (duplicatedDiscordInInvites.length > 0) {
          return { ok: false, reason: 'DISCORD_ALREADY_IN_QUARTET' }
        }
      }

      const updated = await prismaRanked.$executeRaw`
        UPDATE BST_QuartetInvites
        SET status = 'ACCEPTED', updatedAt = GETDATE()
        WHERE requesterOidUser = ${requesterOidUser} AND targetOidUser = ${targetOidUser} AND status = 'PENDING'
      `
      if (!updated) return { ok: false, reason: 'NOT_FOUND' }
      return { ok: true }
    } catch (err) {
      log('error', 'Erro ao aceitar convite de quarteto', err)
      return { ok: false, reason: 'INTERNAL_ERROR' }
    }
  }

  /**
   * Rejeita convite de quarteto
   */
  async rejectInvite(requesterOidUser: number, targetOidUser: number): Promise<{ ok: boolean; reason?: string }> {
    try {
      const updated = await prismaRanked.$executeRaw`
        UPDATE BST_QuartetInvites
        SET status = 'REJECTED', updatedAt = GETDATE()
        WHERE requesterOidUser = ${requesterOidUser} AND targetOidUser = ${targetOidUser} AND status = 'PENDING'
      `
      if (!updated) return { ok: false, reason: 'NOT_FOUND' }
      return { ok: true }
    } catch (err) {
      log('error', 'Erro ao rejeitar convite de quarteto', err)
      return { ok: false, reason: 'INTERNAL_ERROR' }
    }
  }

  /**
   * Remove convite de quarteto (aceitos ou pendentes)
   */
  async removeInvite(userA: number, userB: number): Promise<{ ok: boolean; reason?: string }> {
    try {
      // Segurança: apenas o REQUESTER (capitão) pode remover convites aceitos/pendentes.
      const updated = await prismaRanked.$executeRaw`
        UPDATE BST_QuartetInvites
        SET status = 'REMOVED', updatedAt = GETDATE()
        WHERE status IN ('ACCEPTED', 'PENDING')
          AND requesterOidUser = ${userA}
          AND targetOidUser = ${userB}
      `

      if (updated) return { ok: true }

      // Se existe convite entre os 2, mas o requester não é o userA, bloqueia.
      const existsBetween = await prismaRanked.$queryRaw<{ ok: number }[]>`
        SELECT TOP 1 1 AS ok
        FROM BST_QuartetInvites
        WHERE status IN ('ACCEPTED', 'PENDING') AND (
          (requesterOidUser = ${userA} AND targetOidUser = ${userB}) OR
          (requesterOidUser = ${userB} AND targetOidUser = ${userA})
        )
      `
      if (existsBetween.length > 0) return { ok: false, reason: 'NOT_REQUESTER' }
      return { ok: false, reason: 'NOT_FOUND' }
    } catch (err) {
      log('error', 'Erro ao remover convite de quarteto', err)
      return { ok: false, reason: 'INTERNAL_ERROR' }
    }
  }

  /**
   * Lista todos os convites aceitos (membros do quarteto potencial)
   * IMPORTANTE: Apenas retorna convites com dados completos (username e targetPos válidos)
   */
  async listAcceptedInvites(oidUser: number): Promise<QuartetInviteView[]> {
    try {
      const rows = await prismaRanked.$queryRaw<{
        requesterOidUser: number
        targetOidUser: number
        status: QuartetInviteStatus
        targetPos: number | null
      }[]>`
        SELECT requesterOidUser, targetOidUser, status, targetPos
        FROM BST_QuartetInvites
        WHERE status = 'ACCEPTED'
          AND (requesterOidUser = ${oidUser} OR targetOidUser = ${oidUser})
          AND targetPos IS NOT NULL
          AND targetPos IN (1, 2, 3)
      `

      const ids = Array.from(new Set(rows.map(r => (r.requesterOidUser === oidUser ? r.targetOidUser : r.requesterOidUser))))
      const users =
        ids.length > 0
          ? await prismaGame.$queryRawUnsafe<{ oiduser: number; NickName: string | null }[]>(
              `SELECT oiduser, NickName FROM CBT_User WHERE oiduser IN (${ids.join(',')}) AND NickName IS NOT NULL`
            )
          : []

      const nameById = new Map<number, string>(
        users
          .filter(u => u.NickName && u.NickName.trim().length > 0)
          .map(u => [u.oiduser, u.NickName!.trim()])
      )

      // Apenas retornar convites com username E targetPos válidos
      return rows
        .filter(r => {
          const memberId = r.requesterOidUser === oidUser ? r.targetOidUser : r.requesterOidUser
          return nameById.has(memberId) && r.targetPos !== null
        })
        .map(r => {
          const memberId = r.requesterOidUser === oidUser ? r.targetOidUser : r.requesterOidUser
          return {
            oidUser: memberId,
            username: nameById.get(memberId)!,
            status: r.status,
            isRequester: r.requesterOidUser === oidUser,
            targetPos: r.targetPos!
          }
        })
    } catch (err) {
      log('error', 'Erro ao listar membros do quarteto', err)
      return []
    }
  }

  /**
   * Lista convites pendentes (recebidos e enviados)
   * IMPORTANTE: Apenas retorna convites com dados completos (username e targetPos válidos)
   */
  async listPendingInvites(oidUser: number): Promise<QuartetInviteView[]> {
    try {
      const rows = await prismaRanked.$queryRaw<{
        requesterOidUser: number
        targetOidUser: number
        status: QuartetInviteStatus
        targetPos: number | null
      }[]>`
        SELECT requesterOidUser, targetOidUser, status, targetPos
        FROM BST_QuartetInvites
        WHERE status = 'PENDING'
          AND (targetOidUser = ${oidUser} OR requesterOidUser = ${oidUser})
          AND targetPos IS NOT NULL
          AND targetPos IN (1, 2, 3)
      `

      const ids = Array.from(
        new Set(rows.map(r => (r.requesterOidUser === oidUser ? r.targetOidUser : r.requesterOidUser)))
      )
      const users =
        ids.length > 0
          ? await prismaGame.$queryRawUnsafe<{ oiduser: number; NickName: string | null }[]>(
              `SELECT oiduser, NickName FROM CBT_User WHERE oiduser IN (${ids.join(',')}) AND NickName IS NOT NULL`
            )
          : []

      const nameById = new Map<number, string>(
        users
          .filter(u => u.NickName && u.NickName.trim().length > 0)
          .map(u => [u.oiduser, u.NickName!.trim()])
      )

      // Apenas retornar convites com username E targetPos válidos
      return rows
        .filter(r => {
          const otherUserId = r.requesterOidUser === oidUser ? r.targetOidUser : r.requesterOidUser
          return nameById.has(otherUserId) && r.targetPos !== null
        })
        .map(r => {
          const otherUserId = r.requesterOidUser === oidUser ? r.targetOidUser : r.requesterOidUser
          return {
            oidUser: otherUserId,
            username: nameById.get(otherUserId)!,
            status: r.status,
            isRequester: r.requesterOidUser === oidUser,
            targetPos: r.targetPos!
          }
        })
    } catch (err) {
      log('error', 'Erro ao listar convites pendentes', err)
      return []
    }
  }

  /**
   * Busca informações do quarteto do jogador
   */
  async getQuartetInfo(oidUser: number): Promise<QuartetInfo | null> {
    try {
      const result = await prismaRanked.$queryRaw<QuartetInfo[]>`
        SELECT quartetId, captainOidUser, member1OidUser, member2OidUser, member3OidUser, createdAt, active
        FROM BST_Quartets
        WHERE active = 1 AND (
          captainOidUser = ${oidUser} OR
          member1OidUser = ${oidUser} OR
          member2OidUser = ${oidUser} OR
          member3OidUser = ${oidUser}
        )
      `
      return result.length > 0 ? result[0] : null
    } catch (err) {
      log('error', 'Erro ao buscar informações do quarteto', err)
      return null
    }
  }
}
