import { prismaRanked, prismaGame, PrismaGame } from '../database/prisma'
import { log } from '../utils/logger'
import { toBrasiliaForDb } from '../lib/time'

type FriendStatus = 'PENDING' | 'ACCEPTED' | 'REMOVED' | 'BLOCKED'

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

export interface FriendRecord {
  requesterId: number
  targetId: number
  status: FriendStatus
  createdAt: Date
  updatedAt: Date
}

export interface FriendView {
  oidUser: number
  username: string | null
  status: FriendStatus
  isRequester: boolean
}

export class FriendManager {
  /**
   * Envia (ou reaproveita) um pedido de amizade.
   */
  async sendRequest(requesterId: number, targetId: number): Promise<{ ok: boolean; reason?: string }> {
    if (!requesterId || !targetId || requesterId === targetId) {
      return { ok: false, reason: 'INVALID_TARGET' }
    }

    try {
      const nowForDb = toBrasiliaForDb(new Date())
      // Verifica se já existe algum vínculo entre os dois (em qualquer direção)
      const existing = await prismaRanked.$queryRaw<FriendRecord[]>`
        SELECT TOP 1 requesterId, targetId, status, createdAt, updatedAt
        FROM BST_Friends
        WHERE
          (requesterId = ${requesterId} AND targetId = ${targetId})
          OR
          (requesterId = ${targetId} AND targetId = ${requesterId})
      `

      if (existing.length > 0) {
        const row = existing[0]
        if (row.status === 'ACCEPTED') {
          return { ok: false, reason: 'ALREADY_FRIENDS' }
        }
        if (row.status === 'PENDING') {
          // Se o alvo já tinha enviado antes, considerar aceitar direto
          if (row.requesterId === targetId && row.targetId === requesterId) {
            await prismaRanked.$executeRaw`
              UPDATE BST_Friends
              SET status = 'ACCEPTED', updatedAt = ${nowForDb}
              WHERE requesterId = ${targetId} AND targetId = ${requesterId} AND status = 'PENDING'
            `
            return { ok: true }
          }
          return { ok: false, reason: 'REQUEST_ALREADY_SENT' }
        }
      }

      // Remove registros antigos marcados como removidos/bloqueados para evitar PK duplicada ao recriar
      await prismaRanked.$executeRaw`
        DELETE FROM BST_Friends
        WHERE status IN ('REMOVED','BLOCKED') AND (
          (requesterId = ${requesterId} AND targetId = ${targetId})
          OR
          (requesterId = ${targetId} AND targetId = ${requesterId})
        )
      `

      await prismaRanked.$executeRaw`
        INSERT INTO BST_Friends (requesterId, targetId, status, createdAt, updatedAt)
        VALUES (${requesterId}, ${targetId}, 'PENDING', ${nowForDb}, ${nowForDb})
      `
      return { ok: true }
    } catch (err) {
      log('error', 'Erro ao enviar pedido de amizade', err)
      return { ok: false, reason: 'INTERNAL_ERROR' }
    }
  }

  async accept(requesterId: number, targetId: number): Promise<{ ok: boolean; reason?: string }> {
    try {
      const nowForDb = toBrasiliaForDb(new Date())
      const updated = await prismaRanked.$executeRaw`
        UPDATE BST_Friends
        SET status = 'ACCEPTED', updatedAt = ${nowForDb}
        WHERE requesterId = ${requesterId} AND targetId = ${targetId} AND status = 'PENDING'
      `
      // $executeRaw retorna "number" em prisma; tratamos falsy
      if (!updated) return { ok: false, reason: 'NOT_FOUND' }
      return { ok: true }
    } catch (err) {
      log('error', 'Erro ao aceitar amizade', err)
      return { ok: false, reason: 'INTERNAL_ERROR' }
    }
  }

  async reject(requesterId: number, targetId: number): Promise<{ ok: boolean; reason?: string }> {
    try {
      const nowForDb = toBrasiliaForDb(new Date())
      const updated = await prismaRanked.$executeRaw`
        UPDATE BST_Friends
        SET status = 'REMOVED', updatedAt = ${nowForDb}
        WHERE requesterId = ${requesterId} AND targetId = ${targetId} AND status = 'PENDING'
      `
      if (!updated) return { ok: false, reason: 'NOT_FOUND' }
      return { ok: true }
    } catch (err) {
      log('error', 'Erro ao rejeitar amizade', err)
      return { ok: false, reason: 'INTERNAL_ERROR' }
    }
  }

  async remove(userA: number, userB: number): Promise<{ ok: boolean; reason?: string }> {
    try {
      const nowForDb = toBrasiliaForDb(new Date())
      const updated = await prismaRanked.$executeRaw`
        UPDATE BST_Friends
        SET status = 'REMOVED', updatedAt = ${nowForDb}
        WHERE status = 'ACCEPTED' AND (
          (requesterId = ${userA} AND targetId = ${userB}) OR
          (requesterId = ${userB} AND targetId = ${userA})
        )
      `
      if (!updated) return { ok: false, reason: 'NOT_FOUND' }
      return { ok: true }
    } catch (err) {
      log('error', 'Erro ao remover amizade', err)
      return { ok: false, reason: 'INTERNAL_ERROR' }
    }
  }

  async listFriends(oidUser: number): Promise<FriendView[]> {
    try {
      const rows = await withTimeout(
        prismaRanked.$queryRaw<{ requesterId: number; targetId: number; status: FriendStatus }[]>`
          SELECT requesterId, targetId, status
          FROM BST_Friends
          WHERE status = 'ACCEPTED' AND (requesterId = ${oidUser} OR targetId = ${oidUser})
        `
      )
      const ids = Array.from(new Set(rows.map(r => (r.requesterId === oidUser ? r.targetId : r.requesterId))))
      const users =
        ids.length > 0
          ? await withTimeout(
              prismaGame.$queryRaw<{ oiduser: number; NickName: string | null }[]>`
                SELECT oiduser, NickName FROM CBT_User WHERE oiduser IN (${PrismaGame.join(ids)})
              `
            )
          : []
      const nameById = new Map<number, string | null>(users.map(u => [u.oiduser, u.NickName]))
      return rows.map(r => {
        const friendId = r.requesterId === oidUser ? r.targetId : r.requesterId
        return {
          oidUser: friendId,
          username: nameById.get(friendId) ?? null,
          status: r.status,
          isRequester: r.requesterId === oidUser
        }
      })
    } catch (err) {
      log('error', 'Erro ao listar amigos', err)
      throw err // Re-throw para o handler enviar erro ao cliente
    }
  }

  async listPending(oidUser: number): Promise<FriendView[]> {
    try {
      const rows = await withTimeout(
        prismaRanked.$queryRaw<{ requesterId: number; targetId: number; status: FriendStatus }[]>`
          SELECT requesterId, targetId, status
          FROM BST_Friends
          WHERE status = 'PENDING' AND (targetId = ${oidUser} OR requesterId = ${oidUser})
        `
      )
      const ids = Array.from(
        new Set(rows.map(r => (r.requesterId === oidUser ? r.targetId : r.requesterId)))
      )
      const users =
        ids.length > 0
          ? await withTimeout(
              prismaGame.$queryRaw<{ oiduser: number; NickName: string | null }[]>`
                SELECT oiduser, NickName FROM CBT_User WHERE oiduser IN (${PrismaGame.join(ids)})
              `
            )
          : []
      const nameById = new Map<number, string | null>(users.map(u => [u.oiduser, u.NickName]))
      return rows.map(r => {
        const otherUserId = r.requesterId === oidUser ? r.targetId : r.requesterId
        return {
          oidUser: otherUserId,
          username: nameById.get(otherUserId) ?? null,
          status: r.status,
          isRequester: r.requesterId === oidUser
        }
      })
    } catch (err) {
      log('error', 'Erro ao listar pendentes', err)
      throw err // Re-throw para o handler enviar erro ao cliente
    }
  }
}
