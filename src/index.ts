import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { LobbyManager } from './lobby/manager'
import { connectDatabase, disconnectDatabase, checkHealth } from './database/prisma'
import { log } from './utils/logger'
import { LobbySettings } from './lobby/types'

const app = express()
const httpServer = createServer(app)

// CORS
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'

// Permitir múltiplas origens (incluindo null para arquivos locais)
const corsOrigins = [FRONTEND_URL, 'null', 'http://localhost:3001']

app.use(
  cors({
    origin: (origin, callback) => {
      // Permitir requisições sem origin (como curl, Postman) ou das origens permitidas
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true)
      } else {
        callback(new Error('Not allowed by CORS'))
      }
    },
    credentials: true
  })
)

app.use(express.json())

// Socket.IO com CORS
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true)
      } else {
        callback(new Error('Not allowed by CORS'))
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
})

// Instância do LobbyManager
const lobbyManager = new LobbyManager()

// ============================================
// ROTAS HTTP (Health checks, stats)
// ============================================

app.get('/', (_req, res) => {
  res.json({
    name: 'CBT WebSocket Server',
    version: '1.0.0',
    status: 'online',
    timestamp: new Date().toISOString()
  })
})

app.get('/health', async (_req, res) => {
  const dbHealth = await checkHealth()

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbHealth ? 'connected' : 'disconnected',
    ...lobbyManager.getStats()
  })
})

app.get('/lobbies', (_req, res) => {
  const lobbies = lobbyManager.getAvailableLobbies()
  res.json(lobbies)
})

// ============================================
// WEBSOCKET - EVENTOS
// ============================================

io.on('connection', (socket) => {
  log('info', `🔌 Cliente conectado: ${socket.id}`)

  // ===== CRIAR LOBBY =====
  socket.on('create-lobby', ({ oidUser, strNexonID, settings }: { oidUser: number; strNexonID: string; settings: LobbySettings }) => {
    try {
      const lobby = lobbyManager.createLobby(oidUser, strNexonID, socket.id, settings)

      // Entrar na room do Socket.io
      socket.join(lobby.id)

      // Responder ao criador (host já está dentro do lobby automaticamente)
      socket.emit('lobby-created', lobby)

      log('info', `✅ Lobby ${lobby.id} criado por ${strNexonID} (host auto-join)`)
    } catch (error: any) {
      log('error', 'Erro ao criar lobby', error)
      socket.emit('error', { message: error.message })
    }
  })

  // ===== ENTRAR NO LOBBY =====
  socket.on('join-lobby', ({ lobbyId, oidUser, strNexonID }: { lobbyId: string; oidUser: number; strNexonID: string }) => {
    try {
      const lobby = lobbyManager.joinLobby(lobbyId, oidUser, strNexonID, socket.id)

      // Entrar na room do Socket.io
      socket.join(lobbyId)

      // Notificar TODOS no lobby
      io.to(lobbyId).emit('lobby-updated', lobby)

      log('info', `✅ ${strNexonID} entrou no lobby ${lobbyId}`)
    } catch (error: any) {
      log('error', 'Erro ao entrar no lobby', error)
      socket.emit('error', { message: error.message })
    }
  })

  // ===== SAIR DO LOBBY =====
  socket.on('leave-lobby', ({ lobbyId, oidUser }: { lobbyId: string; oidUser: number }) => {
    try {
      lobbyManager.leaveLobby(lobbyId, oidUser)

      // Sair da room
      socket.leave(lobbyId)

      const lobby = lobbyManager.getLobby(lobbyId)

      // Notificar restantes (se lobby ainda existir)
      if (lobby) {
        io.to(lobbyId).emit('lobby-updated', lobby)
      }

      log('info', `👋 Usuário ${oidUser} saiu do lobby ${lobbyId}`)
    } catch (error: any) {
      log('error', 'Erro ao sair do lobby', error)
      socket.emit('error', { message: error.message })
    }
  })

  // ===== ATUALIZAR CONFIGURAÇÕES =====
  socket.on('update-settings', ({ lobbyId, oidUser, settings }: { lobbyId: string; oidUser: number; settings: Partial<LobbySettings> }) => {
    try {
      const lobby = lobbyManager.updateSettings(lobbyId, oidUser, settings)

      // Notificar todos
      io.to(lobbyId).emit('lobby-updated', lobby)

      log('info', `⚙️ Configurações atualizadas no lobby ${lobbyId}`)
    } catch (error: any) {
      log('error', 'Erro ao atualizar configurações', error)
      socket.emit('error', { message: error.message })
    }
  })

  // ===== MARCAR READY =====
  socket.on('set-ready', ({ lobbyId, oidUser, ready }: { lobbyId: string; oidUser: number; ready: boolean }) => {
    try {
      const lobby = lobbyManager.setPlayerReady(lobbyId, oidUser, ready)

      // Notificar todos
      io.to(lobbyId).emit('lobby-updated', lobby)

      log('info', `${ready ? '✅' : '❌'} Jogador ${oidUser} ${ready ? 'pronto' : 'não pronto'}`)
    } catch (error: any) {
      log('error', 'Erro ao marcar ready', error)
      socket.emit('error', { message: error.message })
    }
  })

  // ===== INICIAR PARTIDA =====
  socket.on('start-match', async ({ lobbyId, oidUser, serverIp }: { lobbyId: string; oidUser: number; serverIp?: string }) => {
    try {
      const matchId = await lobbyManager.startMatch(lobbyId, oidUser, serverIp)

      const lobby = lobbyManager.getLobby(lobbyId)

      // Notificar todos que partida está começando
      io.to(lobbyId).emit('match-starting', {
        matchId,
        lobby,
        serverIp
      })

      log('info', `🎮 Partida ${matchId} iniciada no lobby ${lobbyId}`)
    } catch (error: any) {
      log('error', 'Erro ao iniciar partida', error)
      socket.emit('error', { message: error.message })
    }
  })

  // ===== FINALIZAR PARTIDA =====
  socket.on('end-match', async ({ lobbyId, result }: { lobbyId: string; result: any }) => {
    try {
      await lobbyManager.endMatch(lobbyId, {
        ...result,
        endedAt: new Date(),
        duration: result.duration || 0
      })

      // Notificar todos
      io.to(lobbyId).emit('match-ended', result)

      log('info', `🏁 Partida no lobby ${lobbyId} finalizada`)
    } catch (error: any) {
      log('error', 'Erro ao finalizar partida', error)
      socket.emit('error', { message: error.message })
    }
  })

  // ===== CHAT (Opcional) =====
  socket.on('send-message', ({ lobbyId, oidUser, strNexonID, message }: { lobbyId: string; oidUser: number; strNexonID: string; message: string }) => {
    try {
      // Broadcast para todos no lobby
      io.to(lobbyId).emit('chat-message', {
        oidUser,
        strNexonID,
        message,
        timestamp: Date.now()
      })

      log('info', `💬 [${lobbyId}] ${strNexonID}: ${message}`)
    } catch (error: any) {
      log('error', 'Erro ao enviar mensagem', error)
    }
  })

  // ===== DESCONEXÃO =====
  socket.on('disconnect', () => {
    log('info', `🔌 Cliente desconectado: ${socket.id}`)

    // Remover de todos os lobbies
    lobbyManager.handleDisconnect(socket.id)
  })
})

// ============================================
// TAREFAS PERIÓDICAS
// ============================================

// Limpar lobbies antigos a cada 5 minutos
setInterval(
  () => {
    lobbyManager.cleanupOldLobbies(30)
  },
  5 * 60 * 1000
)

// Log de estatísticas a cada 1 minuto
setInterval(() => {
  const stats = lobbyManager.getStats()
  log('info', '📊 Stats:', stats)
}, 60 * 1000)

// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT = process.env.PORT || 3001

httpServer.listen(PORT, async () => {
  // Conectar ao banco de dados
  await connectDatabase()

  log('info', `🚀 Servidor WebSocket rodando na porta ${PORT}`)
  log('info', `🌐 Frontend permitido: ${FRONTEND_URL}`)
  log('info', `📡 WebSocket: ws://localhost:${PORT}`)
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('info', '⏹️ SIGTERM recebido, fechando servidor...')
  httpServer.close()
  await disconnectDatabase()
  process.exit(0)
})

process.on('SIGINT', async () => {
  log('info', '⏹️ SIGINT recebido, fechando servidor...')
  httpServer.close()
  await disconnectDatabase()
  process.exit(0)
})
