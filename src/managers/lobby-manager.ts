import { getRedisClient } from '../database/redis-client'
import { log } from '../utils/logger'
import { prismaGame } from '../database/prisma'

interface Player {
  oidUser: number
  username: string
  mmr: number
}

interface Team {
  ALPHA: Player[]
  BRAVO: Player[]
}

type ChatChannel = 'TEAM' | 'GENERAL'

interface ChatMessage {
  oidUser: number
  username: string
  message: string
  timestamp: number
  team: 'ALPHA' | 'BRAVO'
  channel: ChatChannel
}

interface VetoHistoryItem {
  round: number
  team: 'ALPHA' | 'BRAVO'
  mapId: string
  mapName: string
  timestamp: number
}

interface LobbyState {
  matchId: string
  teams: Team
  mapVotes: Map<number, string> // oidUser -> mapId (DEPRECATED - usar veto system)
  vetoedMaps: string[] // IDs dos mapas vetados
  vetoHistory: VetoHistoryItem[] // HistÃ³rico de vetos
  currentTurn: 'ALPHA' | 'BRAVO' | null // De quem é a vez de vetar
  vetoRound: number // Rodada atual do veto (0-5, total 6 vetos = 3 por time)
  timeRemaining: number // Tempo restante em segundos para o veto atual
  selectedMap: string | null
  chatMessages: Record<'ALPHA' | 'BRAVO', ChatMessage[]>
  generalChatMessages: ChatMessage[]
  status: 'waiting' | 'setup-phase' | 'veto-phase' | 'map-selected' | 'ready'
}


/**
 * LobbyManager - Gerencia estado das lobbies após o ready check
 */
export class LobbyManager {
  private lobbies: Map<string, LobbyState> = new Map()
  private redis: ReturnType<typeof getRedisClient>
  private rankedMapPool: { mapId: string, mapName: string, mapNumber: number }[] = []
  private activeLobbyKey = (oidUser: number) => `player:${oidUser}:activeLobby`

  // Callbacks
  private onMapSelectedCallback?: (matchId: string, mapId: string) => void
  private onChatMessageCallback?: (matchId: string, username: string, message: string) => void
  private onVetoUpdateCallback?: (matchId: string, lobby: LobbyState) => void
  private onTurnChangeCallback?: (matchId: string, newTurn: 'ALPHA' | 'BRAVO', timeRemaining: number) => void

  // Timers para veto
  private vetoTimers: Map<string, NodeJS.Timeout> = new Map()
  private setupTimers: Map<string, NodeJS.Timeout> = new Map()

constructor() {
    this.redis = getRedisClient()
    log('info', 'LobbyManager: Usando Redis singleton')
    
    // Adicionamos um .catch() para capturar o erro de inicialização
    this.loadRankedMapPool().catch(err => {
      log('error', 'FALHA CRÍTICA AO CARREGAR MAP POOL', err);
      // Em produção, você talvez queira derrubar o processo
      // process.exit(1); 
    });
  }

  /**
   * Registrar callbacks
   */
  onMapSelected(callback: (matchId: string, mapId: string) => void): void {
    this.onMapSelectedCallback = callback
  }

  onChatMessage(callback: (matchId: string, username: string, message: string) => void): void {
    this.onChatMessageCallback = callback
  }

  onVetoUpdate(callback: (matchId: string, lobby: LobbyState) => void): void {
    this.onVetoUpdateCallback = callback
  }

  onTurnChange(callback: (matchId: string, newTurn: 'ALPHA' | 'BRAVO', timeRemaining: number) => void): void {
    this.onTurnChangeCallback = callback
  }

  /**
   * Carrega a pool de mapas ranqueados (Modo 1) do banco de dados
   */
  private async loadRankedMapPool(): Promise<void> {
    log('info', 'Carregando Map Pool ranqueada do banco de dados...')
    try {
      // Usamos prismaGame pois as tabelas são do banco principal do jogo
      const maps = await prismaGame.$queryRaw<any[]>`
          SELECT DISTINCT 
              mo.MapID,
              map.Name AS MapName
          FROM CBT_MapOpen mo
          LEFT JOIN CBT_GameMode mode ON mo.ModeID = mode.Mode
          LEFT JOIN CBT_GameMap map ON map.MapID = mo.MapID
          WHERE mo.Enable = 1
            AND mo.ClearanceLevel = 3 -- 3 = Ranked (baseado na sua query)
            AND mode.Mode = 1          -- 1 = Search & Destroy (baseado na sua query)
          ORDER BY map.Name
      `
      
      this.rankedMapPool = maps.map((map: any) => ({
        mapId: this.normalizeMapId(map.MapName),
        mapName: this.normalizeMapName(map.MapName),
        mapNumber: map.MapID
      }));

      log('info', `Map Pool carregada: ${this.rankedMapPool.length} mapas encontrados.`);
    } catch (error) {
      log('error', 'Falha ao carregar Map Pool ranqueada:', error)
    }
  }

  // Funções helper para normalizar nomes
  private normalizeMapId(mapName: string): string {
    return mapName.toUpperCase()
      .replace(' [CAMP]', '')
      .replace('[CAMP]', '')  // Adicionado para casos como "Rattle [CAMP]"
      .replace(/\s+|_+/g, '') // Remove TODOS os espaços e underscores
      .replace(/'/g, '');     // Remove apóstrofos se houver
  }
  
  private normalizeMapName(mapName: string): string {
    return mapName.replace(' [CAMP]', '').replace('[CAMP]', '');
  }

  /**
   * Criar lobby após ready check passar
   */
  async createLobby(matchId: string, teams: Team): Promise<void> {
    log('info', `Criando lobby para match ${matchId}`)

    const lobbyState: LobbyState = {
      matchId,
      teams,
      mapVotes: new Map(),
      vetoedMaps: [],
      vetoHistory: [],
      currentTurn: null,
      vetoRound: 0,
      timeRemaining: 20,
      selectedMap: null,
      chatMessages: {
        ALPHA: [],
        BRAVO: []
      },
      generalChatMessages: [],
      status: 'setup-phase'
    }

    this.lobbies.set(matchId, lobbyState)
    await this.setActiveLobbyForPlayers(matchId, [
      ...teams.ALPHA.map(p => p.oidUser),
      ...teams.BRAVO.map(p => p.oidUser),
    ])

    await this.persistLobbyState(matchId, lobbyState)

    log('info', `Lobby ${matchId} criada com ${teams.ALPHA.length + teams.BRAVO.length} jogadores`)
    log('info', `Fase de setup iniciada - veto em 20s`)

    this.startSetupTimer(matchId)
  }

  /**
   * Retorna a pool de mapas carregada
   */
  getRankedMapPool(): { mapId: string, mapName: string, mapNumber: number }[] {
    return this.rankedMapPool;
  }

  /**
   * Obter dados da lobby
   */
  getLobby(matchId: string): LobbyState | null {
    return this.lobbies.get(matchId) || null
  }

  /**
   * Persistir estado base da lobby no Redis
   */
  private async persistLobbyState(matchId: string, lobby: LobbyState): Promise<void> {
    try {
      await this.redis.set(
        `lobby:${matchId}:state`,
        JSON.stringify({
          matchId: lobby.matchId,
          teams: lobby.teams,
          vetoedMaps: lobby.vetoedMaps,
          vetoHistory: lobby.vetoHistory,
          currentTurn: lobby.currentTurn,
          vetoRound: lobby.vetoRound,
          timeRemaining: lobby.timeRemaining,
          selectedMap: lobby.selectedMap,
          status: lobby.status
        }),
        { EX: 3600 }
      )
    } catch (error) {
      log('warn', `Falha ao persistir estado da lobby ${matchId}`, error)
    }
  }

  /**
   * Inicia a fase de setup (20s) e, ao expirar, alterna para veto-phase.
   */
  private startSetupTimer(matchId: string): void {
    const existing = this.setupTimers.get(matchId)
    if (existing) {
      clearInterval(existing)
    }

    const lobby = this.lobbies.get(matchId)
    if (!lobby || lobby.status !== 'setup-phase') return

    lobby.timeRemaining = 20

    const timer = setInterval(() => {
      const currentLobby = this.lobbies.get(matchId)
      if (!currentLobby || currentLobby.status !== 'setup-phase') {
        clearInterval(timer)
        this.setupTimers.delete(matchId)
        return
      }

      currentLobby.timeRemaining -= 1

      if (this.onVetoUpdateCallback) {
        this.onVetoUpdateCallback(matchId, currentLobby)
      }

      if (currentLobby.timeRemaining <= 0) {
        clearInterval(timer)
        this.setupTimers.delete(matchId)

        currentLobby.status = 'veto-phase'
        currentLobby.currentTurn = 'ALPHA'
        currentLobby.vetoRound = 0
        currentLobby.timeRemaining = 20

        this.persistLobbyState(matchId, currentLobby).catch(() => { })

        if (this.onVetoUpdateCallback) {
          this.onVetoUpdateCallback(matchId, currentLobby)
        }
        if (this.onTurnChangeCallback) {
          this.onTurnChangeCallback(matchId, currentLobby.currentTurn, currentLobby.timeRemaining)
        }

        this.startVetoTimer(matchId)
      }
    }, 1000)

    this.setupTimers.set(matchId, timer)
  }

  /**
   * Iniciar timer do veto (20 segundos)
   */
  private startVetoTimer(matchId: string): void {
    // Limpa timer anterior se existir
    const existingTimer = this.vetoTimers.get(matchId)
    if (existingTimer) {
      clearInterval(existingTimer)
    }

    const lobby = this.lobbies.get(matchId)
    if (!lobby || lobby.status !== 'veto-phase') return

    // Reset do timer
    lobby.timeRemaining = 20

    // Intervalo de 1 segundo
    const timer = setInterval(() => {
      const currentLobby = this.lobbies.get(matchId)
      if (!currentLobby || currentLobby.status !== 'veto-phase') {
        clearInterval(timer)
        this.vetoTimers.delete(matchId)
        return
      }

      currentLobby.timeRemaining--

      // Notifica sobre mudança de tempo (a cada segundo)
      if (this.onVetoUpdateCallback) {
        this.onVetoUpdateCallback(matchId, currentLobby)
      }

      // Tempo esgotado - veto aleatório
      if (currentLobby.timeRemaining <= 0) {
        clearInterval(timer)
        this.vetoTimers.delete(matchId)
        this.handleVetoTimeout(matchId)
      }
    }, 1000)

    this.vetoTimers.set(matchId, timer)
  }

  /**
   * Lidar com timeout do veto - veta um mapa aleatório
   */
  private async handleVetoTimeout(matchId: string): Promise<void> {
    const lobby = this.lobbies.get(matchId)
    if (!lobby || !lobby.currentTurn) return

      log('warn', `Timeout de veto para ${matchId} - Time ${lobby.currentTurn}`)

    // Lista de mapas disponíveis (não vetados)
    const allMapIds = this.rankedMapPool.map(m => m.mapId);
    const availableMaps = allMapIds.filter(mapId => !lobby.vetoedMaps.includes(mapId));

    if (availableMaps.length === 0) return

    // Escolhe aleatório
    const randomMap = availableMaps[Math.floor(Math.random() * availableMaps.length)]

    log('info', `Veto automático: Time ${lobby.currentTurn} -> ${randomMap}`)

    // Executa o veto
    await this.vetoMap(matchId, lobby.currentTurn, randomMap, 'AUTO')
  }
  
  /**
   * (HELPER) Finaliza a fase de veto e seleciona o mapa.
   * Interrompe timers, atualiza status e notifica os callbacks.
   */
  private finalizeMapSelection(lobby: LobbyState, chosenMapId: string): void {
    const { matchId } = lobby;

    lobby.selectedMap = chosenMapId;
    lobby.status = 'map-selected';
    lobby.currentTurn = null;

    // Para o timer
    const timer = this.vetoTimers.get(matchId);
    if (timer) {
      clearInterval(timer);
      this.vetoTimers.delete(matchId);
    }

    // Busca o nome do mapa para o log
    const finalMapName = this.rankedMapPool.find(m => m.mapId === chosenMapId)?.mapName || chosenMapId;
    log('info', `Mapa selecionado para ${matchId}: ${finalMapName}`);

    // Callback para o RankedWebSocketServer iniciar o HostManager
    if (this.onMapSelectedCallback) {
      this.onMapSelectedCallback(matchId, chosenMapId);
    }
  }
  
/**
   * Executa a troca de papéis (assignedRole) entre dois jogadores no Redis.
   */
async executeRoleSwap(
    matchId: string, 
    userA_oid: number, 
    userB_oid: number
  ): Promise<boolean> {
    
    const lobby = this.lobbies.get(matchId);
    if (!lobby) {
      log('warn', `Troca falhou: Lobby ${matchId} não encontrado.`);
      return false;
    }

    const teamA = lobby.teams.ALPHA.some(p => p.oidUser === userA_oid) ? 'ALPHA' : 'BRAVO';
    const teamB = lobby.teams.ALPHA.some(p => p.oidUser === userB_oid) ? 'ALPHA' : 'BRAVO';

    if (teamA !== teamB) {
      log('warn', `Troca falhou: ${userA_oid} e ${userB_oid} não estão no mesmo time.`);
      return false;
    }

    const redisKey = `match:${matchId}:classes`;
    let dataA_str: string | null = null;
    let dataB_str: string | null = null;
    let dataA: any = null;
    let dataB: any = null;

    try {
      // 1. Puxar os dados de classe atuais do Redis
      [dataA_str, dataB_str] = await this.redis.hmGet(redisKey, [
        userA_oid.toString(),
        userB_oid.toString()
      ]);

      // 2. Parsear os dados
      dataA = dataA_str ? JSON.parse(dataA_str as string) : null;
      dataB = dataB_str ? JSON.parse(dataB_str as string) : null;

      // 3. Checar se os dados parseados são válidos
      if (!dataA || !dataB) {
        log('error', `Falha ao buscar/parsear classes no Redis para troca (match ${matchId})`, { 
          userA_oid,
          userB_oid,
          userA_data_raw: dataA_str, 
          userB_data_raw: dataB_str 
        });
        return false;
      }

      // 4. Trocar os papéis
      const originalRoleA = dataA.assignedRole;
      dataA.assignedRole = dataB.assignedRole;
      dataB.assignedRole = originalRoleA;

      // 5. Salvar os dados atualizados de volta no Redis
      await this.redis.hSet(redisKey, {
        [userA_oid.toString()]: JSON.stringify(dataA),
        [userB_oid.toString()]: JSON.stringify(dataB)
      })
      
      log('info', `Troca de papéis efetuada (Match ${matchId}): ${userA_oid} (${originalRoleA}) <> ${userB_oid} (${dataA.assignedRole})`);
      return true;

    } catch (error: any) {
      // --- ESTE É O LOG DE DEBUG MAIS IMPORTANTE ---
      log('error', `ERRO FATAL EM executeRoleSwap (match ${matchId})`, { 
          message: error.message,
          stack: error.stack,
          userA_oid,
          userB_oid,
          redisKey,
          dataA_str, // Loga o que veio do Redis
          dataB_str, // Loga o que veio do Redis
          dataA_parsed: dataA, // Loga o que foi parseado
          dataB_parsed: dataB  // Loga o que foi parseado
      });
      // --- FIM DO LOG DE DEBUG ---
      return false;
    }
  }

  /**
   * Vetar um mapa (Versão Otimizada)
   */
  async vetoMap(matchId: string, team: 'ALPHA' | 'BRAVO', mapId: string, source: 'PLAYER' | 'AUTO' = 'PLAYER'): Promise<boolean> {
    const lobby = this.lobbies.get(matchId);
    if (!lobby) {
      log('warn', `Tentativa de vetar em lobby inexistente: ${matchId}`);
      return false;
    }

    // Validações (Guard Clauses)
    if (lobby.status !== 'veto-phase') {
      log('warn', `Tentativa de vetar fora da fase de veto: ${matchId}`);
      return false;
    }
    if (lobby.currentTurn !== team) {
        log('warn', `Time ${team} tentou vetar fora de sua vez (turno de ${lobby.currentTurn})`);
      return false;
    }
    if (lobby.vetoedMaps.includes(mapId)) {
      log('warn', `Tentativa de vetar mapa já vetado: ${mapId}`);
      return false;
    }

    // Mapeia ID para nome display
    const mapEntry = this.rankedMapPool.find(m => m.mapId === mapId);
    const mapName = mapEntry ? mapEntry.mapName : mapId;

    // Registra o veto
    lobby.vetoedMaps.push(mapId);
    lobby.vetoHistory.push({
      round: lobby.vetoRound,
      team,
      mapId,
      mapName: mapName,
      timestamp: Date.now()
    });

    log('info', `${source === 'AUTO' ? 'Veto automático' : 'Veto manual'} Time ${team} vetou ${mapName} (rodada ${lobby.vetoRound + 1}/6)`);

    // Lógica principal (Simplificada)
    // A regra é: 6 vetos no total (3 por time).
    const TOTAL_VETOS_REQUERIDOS = 6;

    if (lobby.vetoedMaps.length >= TOTAL_VETOS_REQUERIDOS) {
      // **Fase de Veto Concluída: Seleciona o mapa**
      const allMaps = this.rankedMapPool.map(m => m.mapId);
      const remainingMaps = allMaps.filter(m => !lobby.vetoedMaps.includes(m));

      if (remainingMaps.length > 0) {
        // Escolhe um mapa aleatoriamente dentre os restantes
        const chosen = remainingMaps[Math.floor(Math.random() * remainingMaps.length)];
        this.finalizeMapSelection(lobby, chosen); // <-- Usa o helper
      } else {
        // Fallback (caso o map pool tenha 6 mapas ou menos)
        log('warn', `Não há mapas restantes para escolher em ${matchId}. Selecionando o último vetado.`);
        this.finalizeMapSelection(lobby, mapId); // <-- Usa o helper
      }

    } else {
      // **Fase de Veto Continua: Próximo turno**
      lobby.vetoRound++;
      lobby.currentTurn = lobby.currentTurn === 'ALPHA' ? 'BRAVO' : 'ALPHA';

      log('info', `Próximo turno: Time ${lobby.currentTurn}`);

      // Notifica o frontend sobre a mudança de turno
      if (this.onTurnChangeCallback) {
        this.onTurnChangeCallback(matchId, lobby.currentTurn, 20); // 20s para o próximo
      }

      // Reinicia o timer para o próximo time
      this.startVetoTimer(matchId);
    }

    // Atualiza o estado no Redis
    await this.redis.set(
      `lobby:${matchId}:vetos`,
      JSON.stringify({
        vetoedMaps: lobby.vetoedMaps,
        vetoHistory: lobby.vetoHistory,
        currentTurn: lobby.currentTurn,
        vetoRound: lobby.vetoRound
      }),
      { EX: 3600 }
    );

    // Notifica o frontend sobre a atualização (mapa vetado, etc.)
    if (this.onVetoUpdateCallback) {
      this.onVetoUpdateCallback(matchId, lobby);
    }

    return true;
  }
  
  /**
   * Votar em mapa (DEPRECATED - usar vetoMap)
   */
  async voteMap(matchId: string, oidUser: number, mapId: string): Promise<boolean> {
    const lobby = this.lobbies.get(matchId)
    if (!lobby) {
      log('warn', `Tentativa de votar em lobby inexistente: ${matchId}`)
      return false
    }

    // Registra voto
    lobby.mapVotes.set(oidUser, mapId)

    log('info', `Player ${oidUser} votou em ${mapId} (${lobby.mapVotes.size}/${lobby.teams.ALPHA.length + lobby.teams.BRAVO.length})`)

    // Conta votos
    const voteCount = new Map<string, number>()
    lobby.mapVotes.forEach((map) => {
      voteCount.set(map, (voteCount.get(map) || 0) + 1)
    })

    // Verifica se algum mapa foi escolhido (maioria simples ou todos votaram)
    const totalPlayers = lobby.teams.ALPHA.length + lobby.teams.BRAVO.length
    const hasVoted = lobby.mapVotes.size

    // Se todos votaram ou se algum mapa tem maioria absoluta
    let selectedMap: string | null = null

    if (hasVoted === totalPlayers) {
      // Todos votaram, pega o mais votado
      let maxVotes = 0
      voteCount.forEach((votes, map) => {
        if (votes > maxVotes) {
          maxVotes = votes
          selectedMap = map
        }
      })
    } else {
      // Verifica maioria absoluta (>50%)
      const majorityThreshold = Math.ceil(totalPlayers / 2)
      voteCount.forEach((votes, map) => {
        if (votes >= majorityThreshold) {
          selectedMap = map
        }
      })
    }

    // Se mapa foi selecionado
    if (selectedMap && !lobby.selectedMap) {
      lobby.selectedMap = selectedMap
      lobby.status = 'ready'

      // Salva no Redis
      await this.redis.set(
        `lobby:${matchId}:selectedMap`,
        selectedMap,
        { EX: 3600 }
      )

      log('info', `Mapa selecionado para ${matchId}: ${selectedMap}`)

      // Callback
      if (this.onMapSelectedCallback) {
        this.onMapSelectedCallback(matchId, selectedMap)
      }
    }

    // Atualiza Redis
    await this.redis.set(
      `lobby:${matchId}:votes`,
      JSON.stringify(Object.fromEntries(lobby.mapVotes)),
      { EX: 3600 }
    )

    return true
  }

  /**
   * Adicionar mensagem de chat
   */
  async addChatMessage(
    matchId: string,
    oidUser: number,
    message: string,
    channel: ChatChannel = 'TEAM'
  ): Promise<{ team: 'ALPHA' | 'BRAVO'; channel: ChatChannel; chatMessage: ChatMessage } | null> {
    const lobby = this.lobbies.get(matchId)
    if (!lobby) return null

    const isAlpha = lobby.teams.ALPHA.some(player => player.oidUser === oidUser)
    const isBravo = lobby.teams.BRAVO.some(player => player.oidUser === oidUser)
    const team: 'ALPHA' | 'BRAVO' | null = isAlpha ? 'ALPHA' : isBravo ? 'BRAVO' : null

    if (!team) {
      log('warn', `Chat message ignored. Player ${oidUser} nao pertence a lobby ${matchId}`)
      return null
    }

    const player = lobby.teams[team].find(p => p.oidUser === oidUser)
    const chatMessage: ChatMessage = {
      oidUser,
      username: player?.username || `Player${oidUser}`,
      message,
      timestamp: Date.now(),
      team,
      channel
    }

    if (channel === 'GENERAL') {
      lobby.generalChatMessages.push(chatMessage)
      if (lobby.generalChatMessages.length > 100) {
        lobby.generalChatMessages.shift()
      }
    } else {
      lobby.chatMessages[team].push(chatMessage)

      // Limita historico a 50 mensagens por time
      if (lobby.chatMessages[team].length > 50) {
        lobby.chatMessages[team].shift()
      }
    }

    log('info', `[CHAT][${channel}] ${chatMessage.username} (${matchId}/${team}): ${message}`)

    // Callback
    if (this.onChatMessageCallback) {
      this.onChatMessageCallback(matchId, chatMessage.username, message)
    }

    return { team, channel, chatMessage }
  }


  /**
   * Obter votos do mapa
   */
  getMapVotes(matchId: string): Record<string, number> {
    const lobby = this.lobbies.get(matchId)
    if (!lobby) return {}

    const voteCount: Record<string, number> = {}
    lobby.mapVotes.forEach((map) => {
      voteCount[map] = (voteCount[map] || 0) + 1
    })

    return voteCount
  }

  /**
   * Remover lobby
   */
  async removeLobby(matchId: string): Promise<void> {
    const lobby = this.lobbies.get(matchId)
    const playerIds = lobby
      ? [...lobby.teams.ALPHA, ...lobby.teams.BRAVO].map(p => p.oidUser)
      : []

    // Limpa timer de veto
    const timer = this.vetoTimers.get(matchId)
    if (timer) {
      clearInterval(timer)
      this.vetoTimers.delete(matchId)
    }
    const setupTimer = this.setupTimers.get(matchId)
    if (setupTimer) {
      clearInterval(setupTimer)
      this.setupTimers.delete(matchId)
    }

    this.lobbies.delete(matchId)

    await this.redis.del(`lobby:${matchId}:state`)
    await this.redis.del(`lobby:${matchId}:votes`)
    await this.redis.del(`lobby:${matchId}:vetos`)
    await this.redis.del(`lobby:${matchId}:selectedMap`)
    if (playerIds.length) {
      await this.clearActiveLobbyForPlayers(playerIds)
    }

    log('info', `Lobby ${matchId} removida`)
  }
  /**
   * Limpar todas as lobbies (shutdown)
   */
  async clearAll(): Promise<void> {
    for (const matchId of this.lobbies.keys()) {
      await this.removeLobby(matchId)
    }
    log('info', 'Todas as lobbies limpas')
  }

  /**
   * Parar manager (shutdown)
   */
  stop(): void {
    log('info', 'LobbyManager parado')
  }

  /**
   * Marca jogadores como pertencentes a uma lobby ativa (índice rápido player -> lobby)
   */
  private async setActiveLobbyForPlayers(matchId: string, playerIds: number[]): Promise<void> {
    if (!playerIds.length) return
    const multi = this.redis.multi()
    for (const oid of playerIds) {
      multi.set(this.activeLobbyKey(oid), matchId, { EX: 3600 })
    }
    await multi.exec()
  }

  /**
   * Limpa o mapeamento player -> lobby (quando lobby é finalizada ou expira)
   */
  async clearActiveLobbyForPlayers(playerIds: number[]): Promise<void> {
    if (!playerIds.length) return
    const multi = this.redis.multi()
    for (const oid of playerIds) {
      multi.del(this.activeLobbyKey(oid))
    }
    await multi.exec()
  }
}


