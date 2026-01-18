import { prismaRanked, prismaGame } from '../database/prisma'
import { log } from '../utils/logger'

/**
 * Wrapper para adicionar timeout em queries do Prisma
 * Previne que queries penduradas causem loading infinito
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('DATABASE_TIMEOUT')), timeoutMs)
    )
  ])
}

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
  isCaptain?: boolean // OPCIONAL - true se o membro é o capitão do quarteto criado
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

      // Clean up invites sent by the user who just accepted an invite
      // If I accept an invite to join a team, I should not have pending invites sent to others
      await prismaRanked.$executeRaw`
        DELETE FROM BST_QuartetInvites
        WHERE requesterOidUser = ${targetOidUser} AND status IN ('PENDING', 'ACCEPTED')
      `

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
   * IMPORTANTE: Prioriza quartetos criados em BST_EventQuartet. Se não houver, retorna convites aceitos.
   */
  async listAcceptedInvites(oidUser: number): Promise<QuartetInviteView[]> {
    try {
      // PASSO 1: Verificar se o usuário tem um quarteto ativo em BST_EventQuartetMember
      const activeQuartet = await withTimeout(
        prismaGame.$queryRaw<{
          QuartetID: number
          CaptainOidUser: number
          Name: string | null
        }[]>`
          SELECT TOP 1 q.QuartetID, q.CaptainOidUser, q.Name
          FROM dbo.BST_EventQuartet q
          INNER JOIN dbo.BST_EventQuartetMember m
            ON m.QuartetID = q.QuartetID
          WHERE m.oidUser = ${oidUser}
          ORDER BY q.CreatedAt DESC
        `
      )

      // Se o usuário tem um quarteto ativo, carregar todos os membros desse quarteto
      if (activeQuartet.length > 0) {
        const quartet = activeQuartet[0]
        const quartetId = Number(quartet.QuartetID)
        const captainOidUser = Number(quartet.CaptainOidUser)

        // Buscar todos os membros do quarteto
        const members = await withTimeout(
          prismaGame.$queryRaw<{
            oidUser: number
            Role: string
          }[]>`
            SELECT oidUser, Role
            FROM dbo.BST_EventQuartetMember
            WHERE QuartetID = ${quartetId}
              AND oidUser <> ${oidUser}
          `
        )

        // Pegar todos os oidUsers (exceto o próprio usuário que está consultando)
        const memberIds = members.map(m => Number(m.oidUser))

        if (memberIds.length === 0) {
          return []
        }

        // Buscar usernames de todos os membros
        const users = await withTimeout(
          prismaGame.$queryRawUnsafe<{ oiduser: number; NickName: string | null }[]>(
            `SELECT oiduser, NickName FROM CBT_User WHERE oiduser IN (${memberIds.join(',')}) AND NickName IS NOT NULL`
          )
        )

        const nameById = new Map<number, string>(
          users
            .filter(u => u.NickName && u.NickName.trim().length > 0)
            .map(u => [u.oiduser, u.NickName!.trim()])
        )

        // Mapear membros para o formato QuartetInviteView
        // Para quartetos criados, todos os membros aparecem com seus respectivos índices
        let memberIndex = 1
        return members
          .filter(m => nameById.has(Number(m.oidUser)))
          .map(m => {
            const memberId = Number(m.oidUser)
            const isCaptain = m.Role === 'CAPTAIN'
            const pos = memberIndex++

            return {
              oidUser: memberId,
              username: nameById.get(memberId)!,
              status: 'ACCEPTED' as QuartetInviteStatus,
              isRequester: oidUser === captainOidUser, // Se eu sou o capitão, então eu sou o requester
              targetPos: Math.min(pos, 3) as 1 | 2 | 3,
              isCaptain: isCaptain // Identifica se este membro é o capitão
            }
          })
      }

      // PASSO 2: Se não há quarteto ativo, retornar convites aceitos de BST_QuartetInvites (lógica antiga)
      const rows = await withTimeout(
        prismaRanked.$queryRaw<{
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
      )

      const ids = Array.from(new Set(rows.map(r => (r.requesterOidUser === oidUser ? r.targetOidUser : r.requesterOidUser))))
      const users =
        ids.length > 0
          ? await withTimeout(
              prismaGame.$queryRawUnsafe<{ oiduser: number; NickName: string | null }[]>(
                `SELECT oiduser, NickName FROM CBT_User WHERE oiduser IN (${ids.join(',')}) AND NickName IS NOT NULL`
              )
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
      throw err // Re-throw para o handler enviar erro ao cliente
    }
  }

  /**
   * Lista convites pendentes (recebidos e enviados)
   * IMPORTANTE: Apenas retorna convites com dados completos (username e targetPos válidos)
   */
  async listPendingInvites(oidUser: number): Promise<QuartetInviteView[]> {
    try {
      const rows = await withTimeout(
        prismaRanked.$queryRaw<{
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
      )

      const ids = Array.from(
        new Set(rows.map(r => (r.requesterOidUser === oidUser ? r.targetOidUser : r.requesterOidUser)))
      )
      const users =
        ids.length > 0
          ? await withTimeout(
              prismaGame.$queryRawUnsafe<{ oiduser: number; NickName: string | null }[]>(
                `SELECT oiduser, NickName FROM CBT_User WHERE oiduser IN (${ids.join(',')}) AND NickName IS NOT NULL`
              )
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
      throw err // Re-throw para o handler enviar erro ao cliente
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
