import { PrismaClient as PrismaClientRanked } from '@prisma/client'
import { PrismaClient as PrismaClientGame, Prisma as PrismaNamespaceGame } from '../../node_modules/.prisma/client-game'
import { log } from '../utils/logger'

export const PrismaGame = PrismaNamespaceGame;

// ============================================
// CLIENTE PRISMA - BANCO COMBATARMS_LOG (Ranked)
// ============================================
const globalForPrismaRanked = global as unknown as { prismaRanked: PrismaClientRanked }

export const prismaRanked =
  globalForPrismaRanked.prismaRanked ||
  new PrismaClientRanked({
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
  })

if (process.env.NODE_ENV !== 'production') globalForPrismaRanked.prismaRanked = prismaRanked

// ============================================
// CLIENTE PRISMA - BANCO COMBATARMS (Jogo)
// ============================================
const globalForPrismaGame = global as unknown as { prismaGame: PrismaClientGame }

export const prismaGame: PrismaClientGame =
  globalForPrismaGame.prismaGame ||
  new PrismaClientGame({
    datasources: {
      db: {
        url: process.env.DATABASE_GAME_URL
      }
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
  })

if (process.env.NODE_ENV !== 'production') globalForPrismaGame.prismaGame = prismaGame

// ============================================
// EXPORT LEGADO (compatibilidade com código existente)
// ============================================
export const prisma = prismaRanked

/**
 * Conectar aos bancos
 */
export async function connectDatabase(): Promise<void> {
  try {
    await Promise.all([
      prismaRanked.$connect(),
      prismaGame.$connect()
    ])
    log('info', '✅ Prisma conectado aos 2 bancos (COMBATARMS_LOG + COMBATARMS)')
  } catch (error) {
    log('error', '❌ Erro ao conectar Prisma', error)
    throw error
  }
}

/**
 * Desconectar dos bancos
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await Promise.all([
      prismaRanked.$disconnect(),
      prismaGame.$disconnect()
    ])
    log('info', '🔌 Prisma desconectado dos 2 bancos')
  } catch (error) {
    log('error', '❌ Erro ao desconectar Prisma', error)
  }
}

/**
 * Health check dos 2 bancos
 */
export async function checkHealth(): Promise<{ ranked: boolean; game: boolean }> {
  const results = { ranked: false, game: false }
  
  try {
    await prismaRanked.$queryRaw`SELECT 1`
    results.ranked = true
  } catch (error) {
    log('error', '❌ Health check COMBATARMS_LOG falhou', error)
  }
  
  try {
    await prismaGame.$queryRaw`SELECT 1`
    results.game = true
  } catch (error) {
    log('error', '❌ Health check COMBATARMS falhou', error)
  }
  
  return results
}
