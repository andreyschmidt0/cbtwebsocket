import { createClient } from 'redis'
import { log } from '../utils/logger'

/**
 * Singleton Redis Client
 *
 * Centraliza a conexão Redis para todos os managers, evitando múltiplas conexões.
 *
 * Benefícios:
 * - Reduz 4 conexões → 1 conexão (75% menos overhead)
 * - Lazy initialization (conecta apenas quando necessário)
 * - Gerenciamento centralizado de erros
 * - Simplifica manutenção e debugging
 */
class RedisClientSingleton {
  private static instance: ReturnType<typeof createClient> | null = null
  private static isConnected: boolean = false
  private static isConnecting: boolean = false

  static getInstance(): ReturnType<typeof createClient> {
    if (!this.instance) {
      log('info', '🔌 Criando cliente Redis singleton...')

      this.instance = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
          keepAlive: true, // Habilita sinais de vida TCP
          reconnectStrategy: (retries: number) => {
            const delay = Math.min(retries * 100, 3000); // Tenta reconectar rápido (max 3s)
            log('warn', `🔄 Redis tentando reconexão TCP (tentativa ${retries}) em ${delay}ms...`);
            return delay;
          }
        }
      })

      // Event: Erro de conexão
      this.instance.on('error', (err) => {
        log('error', '❌ Redis error:', err)
        this.isConnected = false
      })

      // Event: Reconectando
      this.instance.on('reconnecting', () => {
        log('warn', '🔄 Redis reconectando...')
        this.isConnected = false
      })

      // Event: Conexão pronta
      this.instance.on('ready', () => {
        this.isConnected = true
        log('info', '✅ Redis singleton pronto')
      })

      // Conectar automaticamente (lazy initialization)
      if (!this.isConnecting) {
        this.isConnecting = true
        this.instance.connect()
          .then(() => {
            this.isConnected = true
            this.isConnecting = false
            log('info', '✅ Redis singleton conectado com sucesso')
          })
          .catch((err) => {
            this.isConnected = false
            this.isConnecting = false
            log('error', '❌ Redis singleton falhou ao conectar:', err)
          })
      }
    }

    return this.instance
  }

  /**
   * Verifica se o Redis está pronto para uso
   */
  static isReady(): boolean {
    return this.isConnected
  }

  /**
   * Força reconexão (útil para testes ou recuperação de erros)
   */
  static async reconnect(): Promise<void> {
    if (this.instance) {
      try {
        await this.instance.disconnect()
      } catch (err) {
        log('warn', '⚠️ Erro ao desconectar Redis:', err)
      }
    }

    this.instance = null
    this.isConnected = false
    this.isConnecting = false

    // Cria nova instância
    this.getInstance()
  }

  /**
   * Desconecta o cliente Redis (graceful shutdown)
   */
  static async disconnect(): Promise<void> {
    if (this.instance && this.isConnected) {
      try {
        await this.instance.quit()
        log('info', '👋 Redis singleton desconectado')
      } catch (err) {
        log('error', '❌ Erro ao desconectar Redis:', err)
      } finally {
        this.instance = null
        this.isConnected = false
        this.isConnecting = false
      }
    }
  }
}

// Exports públicos
export const getRedisClient = () => RedisClientSingleton.getInstance()
export const isRedisReady = () => RedisClientSingleton.isReady()
export const reconnectRedis = () => RedisClientSingleton.reconnect()
export const disconnectRedis = () => RedisClientSingleton.disconnect()
