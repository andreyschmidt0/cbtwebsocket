/**
 * Tipos para o sistema de lobbies
 */

export interface Player {
  oidUser: number // Int (SQL Server)
  strNexonID: string
  socketId: string
  joinedAt: number
  team?: 'BRAVO' | 'ALPHA'
  ready: boolean
}

export interface LobbySettings {
  gameMode: 'ranked' | 'casual' | '1v1' | 'team-deathmatch'
  map: string
  maxPlayers: number
  roundTime: number
  maxRounds: number
  autoBalance: boolean
}

export interface Lobby {
  id: string // UUID do lobby
  hostId: number // oidUser do host
  players: Player[]
  settings: LobbySettings
  status: 'waiting' | 'starting' | 'in-progress' | 'completed' | 'cancelled'
  createdAt: number
  startedAt?: number
  matchId?: string
}

export interface MatchSnapshot {
  matchId: string
  lobbyId: string
  players: Player[]
  settings: LobbySettings
  startedAt: Date
  serverIp?: string
}

export interface MatchResult {
  winnerId?: number // oidUser do vencedor
  winnerTeam?: 'BRAVO' | 'ALPHA'
  scoreA?: number
  scoreB?: number
  reason?: 'completed' | 'cancelled' | 'timeout'
  endedAt: Date
  duration: number
}
