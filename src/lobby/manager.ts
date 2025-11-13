import { v4 as uuidv4 } from 'uuid'
import { Lobby, Player, LobbySettings, MatchResult } from './types'
import { saveMatchToDatabase, updateMatchResult } from '../database/matches'
import { log } from '../utils/logger'

export class LobbyManager {
  private lobbies = new Map<string, Lobby>()
  private playerToLobby = new Map<number, string>()

  /**
   * Criar novo lobby (host é adicionado automaticamente)
   */
  createLobby(oidUser: number, strNexonID: string, socketId: string, settings: LobbySettings): Lobby {
    if (!oidUser || typeof oidUser !== 'number') {
      throw new Error('oidUser inválido ao criar lobby')
    }

    const lobbyId = uuidv4()

    // Criar jogador host
    const hostPlayer: Player = {
      oidUser,
      strNexonID,
      socketId,
      joinedAt: Date.now(),
      ready: true // Host já está pronto
    }

    const lobby: Lobby = {
      id: lobbyId,
      hostId: oidUser,
      players: [hostPlayer], // Host já entra automaticamente
      settings,
      status: 'waiting',
      createdAt: Date.now()
    }

    this.lobbies.set(lobbyId, lobby)
    this.playerToLobby.set(oidUser, lobbyId)

    log('info', `✅ Lobby criado: ${lobbyId}`, {
      mode: settings.gameMode,
      map: settings.map,
      host: strNexonID,
      players: `1/${settings.maxPlayers}`
    })

    return lobby
  }

  /**
   * Jogador entra no lobby
   */
  joinLobby(lobbyId: string, oidUser: number, strNexonID: string, socketId: string): Lobby {
    if (!oidUser || typeof oidUser !== 'number') {
      throw new Error('oidUser inválido ao entrar no lobby')
    }

    const lobby = this.lobbies.get(lobbyId)

    if (!lobby) {
      throw new Error(`Lobby ${lobbyId} não encontrado`)
    }

    if (lobby.status !== 'waiting') {
      throw new Error('Lobby já iniciou')
    }

    if (lobby.players.length >= lobby.settings.maxPlayers) {
      throw new Error('Lobby cheio')
    }

    if (lobby.players.some(p => p.oidUser === oidUser)) {
      throw new Error('Você já está neste lobby')
    }

    const player: Player = {
      oidUser,
      strNexonID,
      socketId,
      joinedAt: Date.now(),
      ready: false
    }

    lobby.players.push(player)
    this.playerToLobby.set(oidUser, lobbyId)

    log('info', `👤 ${strNexonID} entrou no lobby ${lobbyId}`, {
      players: `${lobby.players.length}/${lobby.settings.maxPlayers}`
    })

    return lobby
  }

  /**
   * Jogador sai do lobby
   */
  leaveLobby(lobbyId: string, oidUser: number): void {
    const lobby = this.lobbies.get(lobbyId)
    if (!lobby) return

    const player = lobby.players.find(p => p.oidUser === oidUser)
    if (!player) return

    lobby.players = lobby.players.filter(p => p.oidUser !== oidUser)
    this.playerToLobby.delete(oidUser)

    log('info', `👋 ${player.strNexonID} saiu do lobby ${lobbyId}`)

    // Se host saiu, promover outro ou fechar
    if (lobby.hostId === oidUser) {
      if (lobby.players.length > 0) {
        lobby.hostId = lobby.players[0].oidUser
        log('info', `👑 Novo host: ${lobby.players[0].strNexonID}`)
      } else {
        this.lobbies.delete(lobbyId)
        log('info', `🗑️ Lobby ${lobbyId} removido (vazio)`)
      }
    }

    // Se ficou vazio, remover
    if (lobby.players.length === 0) {
      this.lobbies.delete(lobbyId)
    }
  }

  /**
   * Atualizar configurações (apenas host)
   */
  updateSettings(lobbyId: string, oidUser: number, settings: Partial<LobbySettings>): Lobby {
    const lobby = this.lobbies.get(lobbyId)
    if (!lobby) throw new Error('Lobby não encontrado')
    if (lobby.hostId !== oidUser) throw new Error('Apenas o host pode alterar')
    if (lobby.status !== 'waiting') throw new Error('Não pode alterar durante partida')

    lobby.settings = { ...lobby.settings, ...settings }

    log('info', `⚙️ Configurações atualizadas no lobby ${lobbyId}`, settings)

    return lobby
  }

  /**
   * Marcar jogador como pronto
   */
  setPlayerReady(lobbyId: string, oidUser: number, ready: boolean): Lobby {
    const lobby = this.lobbies.get(lobbyId)
    if (!lobby) throw new Error('Lobby não encontrado')

    const player = lobby.players.find(p => p.oidUser === oidUser)
    if (!player) throw new Error('Você não está neste lobby')

    player.ready = ready

    log('info', `${ready ? '✅' : '❌'} ${player.strNexonID} ${ready ? 'pronto' : 'não pronto'}`)

    return lobby
  }

  /**
   * Iniciar partida (salva no SQL)
   */
  async startMatch(lobbyId: string, oidUser: number, serverIp?: string): Promise<string> {
    const lobby = this.lobbies.get(lobbyId)

    if (!lobby) throw new Error('Lobby não encontrado')
    if (lobby.hostId !== oidUser) throw new Error('Apenas o host pode iniciar')
    if (lobby.players.length < 2) throw new Error('Mínimo 2 jogadores')
    if (lobby.status !== 'waiting') throw new Error('Lobby já iniciou')

    // Verificar se todos estão prontos
    const playersNotReady = lobby.players.filter(p => !p.ready && p.oidUser !== lobby.hostId)
    if (playersNotReady.length > 0) {
      throw new Error(`${playersNotReady.length} jogador(es) não está(ão) pronto(s)`)
    }

    const matchId = uuidv4()

    lobby.status = 'starting'
    lobby.startedAt = Date.now()
    lobby.matchId = matchId

    try {
      // Salvar no SQL
      await saveMatchToDatabase({
        matchId,
        lobbyId,
        players: [...lobby.players],
        settings: { ...lobby.settings },
        startedAt: new Date(),
        serverIp
      })

      lobby.status = 'in-progress'

      log('info', `🎮 Partida ${matchId} iniciada`, {
        lobby: lobbyId,
        players: lobby.players.map(p => p.strNexonID).join(', '),
        mode: lobby.settings.gameMode,
        map: lobby.settings.map
      })

      return matchId
    } catch (error) {
      lobby.status = 'waiting'
      lobby.startedAt = undefined
      lobby.matchId = undefined

      log('error', `❌ Erro ao iniciar partida`, error)
      throw new Error('Falha ao iniciar partida')
    }
  }

  /**
   * Finalizar partida (atualiza SQL e limpa RAM)
   */
  async endMatch(lobbyId: string, result: MatchResult): Promise<void> {
    const lobby = this.lobbies.get(lobbyId)
    if (!lobby || !lobby.matchId) {
      throw new Error('Partida não encontrada')
    }

    try {
      await updateMatchResult(lobby.matchId, result)

      log('info', `✅ Partida ${lobby.matchId} finalizada`, result)

      // Limpar da RAM
      this.lobbies.delete(lobbyId)
      lobby.players.forEach(p => this.playerToLobby.delete(p.oidUser))

      log('info', `🗑️ Lobby ${lobbyId} removido da RAM`)
    } catch (error) {
      log('error', `❌ Erro ao finalizar partida`, error)
      throw error
    }
  }

  /**
   * Buscar lobby por ID
   */
  getLobby(lobbyId: string): Lobby | undefined {
    return this.lobbies.get(lobbyId)
  }

  /**
   * Listar lobbies disponíveis
   */
  getAvailableLobbies(): Lobby[] {
    return Array.from(this.lobbies.values())
      .filter(lobby => lobby.status === 'waiting')
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Buscar lobby do jogador
   */
  getPlayerLobby(oidUser: number): Lobby | undefined {
    const lobbyId = this.playerToLobby.get(oidUser)
    return lobbyId ? this.lobbies.get(lobbyId) : undefined
  }

  /**
   * Desconexão do jogador (remover de todos os lobbies)
   */
  handleDisconnect(socketId: string): void {
    for (const [lobbyId, lobby] of this.lobbies) {
      const player = lobby.players.find(p => p.socketId === socketId)
      if (player) {
        this.leaveLobby(lobbyId, player.oidUser)
        break
      }
    }
  }

  /**
   * Estatísticas
   */
  getStats() {
    return {
      activeLobbies: this.lobbies.size,
      waitingLobbies: Array.from(this.lobbies.values()).filter(l => l.status === 'waiting').length,
      inProgressMatches: Array.from(this.lobbies.values()).filter(l => l.status === 'in-progress').length,
      totalPlayers: Array.from(this.lobbies.values()).reduce((sum, lobby) => sum + lobby.players.length, 0)
    }
  }

  /**
   * Limpeza de lobbies antigos (executar periodicamente)
   */
  cleanupOldLobbies(maxAgeMinutes: number = 30): void {
    const now = Date.now()
    const maxAge = maxAgeMinutes * 60 * 1000

    for (const [lobbyId, lobby] of this.lobbies) {
      if (lobby.players.length === 0 || (lobby.status === 'waiting' && now - lobby.createdAt > maxAge)) {
        this.lobbies.delete(lobbyId)
        log('info', `🧹 Lobby antigo removido: ${lobbyId}`)
      }
    }
  }
}
