import { prismaRanked, prismaGame } from './prisma'
import { disconnectRedis } from './redis-client'
import { log } from '../utils/logger'

/**
 * Desconecta todos os clientes (Prisma + Redis)
 * Usado no graceful shutdown do servidor
 */
export async function disconnectAll(): Promise<void> {
  try {
    log('info', '🔌 Desconectando banco de dados e Redis...')

    await Promise.all([
      prismaRanked.$disconnect(),
      prismaGame.$disconnect(),
      disconnectRedis()
    ])

    log('info', '✅ Desconexões concluídas')
  } catch (error) {
    log('error', '❌ Erro ao desconectar:', error)
    throw error
  }
}
