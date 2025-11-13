import { getRedisClient } from '../database/redis-client'
import { prismaGame } from '../database/prisma'
import { QueuePlayer, ValidationResult, WeaponTier } from '../types'
import { log } from '../utils/logger'
import { ReadyManager } from './ready-manager'

type TeamRole = 'SNIPER' | 'T1' | 'T2' | 'T3' | 'T4'
type TeamAssignment = { diff: number; alpha: { player: QueuePlayer, role: TeamRole }[]; bravo: { player: QueuePlayer, role: TeamRole }[] }

export class QueueManager {
  private queue: Map<number, QueuePlayer> = new Map()
  private redis: ReturnType<typeof getRedisClient>
  private matchmakingInterval?: NodeJS.Timeout
  private isMatchmakingRunning: boolean = false // Proteção contra reentrada
  private onMatchFoundCallback?: (matchId: string, players: QueuePlayer[], teams: any) => void
  private readyManager?: ReadyManager

  constructor() {
    // Usa cliente Redis singleton (compartilhado com outros managers)
    this.redis = getRedisClient()
    log('info', '? QueueManager: Usando Redis singleton')
  }

  /**
   * Registrar ReadyManager
   */
  setReadyManager(readyManager: ReadyManager): void {
    this.readyManager = readyManager
  }

  /**
   * Registrar callback para quando match for encontrado
   */
  onMatchFound(callback: (matchId: string, players: QueuePlayer[], teams: any) => void): void {
    this.onMatchFoundCallback = callback
  }

  /**
   * Adicionar jogador à fila
   */
  async addToQueue(player: QueuePlayer): Promise<ValidationResult> {
    // 1. Validar jogador (passa discordId para validação anti-multi-accounting)
    const validation = await this.validatePlayer(player.oidUser, player.discordId)
    if (!validation.valid) {
      return validation // Retorna validação para o WebSocket server lidar
    }

    // 2. Garantir que queuedAt está definido
    if (!player.queuedAt) {
      player.queuedAt = Date.now()
    }

    // 3. Adicionar à fila (memória)
    this.queue.set(player.oidUser, player)

    // 4. Backup no Redis (TTL 1 hora)
    await this.redis.set(
      `queue:ranked:${player.oidUser}`,
      JSON.stringify({
        oidUser: player.oidUser,
        username: player.username,
        mmr: player.mmr,
        classes: player.classes,
        queuedAt: player.queuedAt
      }),
      { EX: 3600 }
    )

    log('info', `? ${player.username} entrou na fila (MMR: ${player.mmr}, Total: ${this.queue.size})`)

    // 5. Iniciar matchmaking se ainda não está rodando
    if (!this.matchmakingInterval) {
      this.startMatchmaking()
    }

    return { valid: true } // Sucesso
  }

  /**
   * Remover jogador da fila
   */
  async removeFromQueue(oidUser: number): Promise<void> {
    const player = this.queue.get(oidUser)
    if (!player) return

    // Remove da memória
    this.queue.delete(oidUser)

    // Remove do Redis
    await this.redis.del(`queue:ranked:${oidUser}`)

    // ? REMOVIDO: Não notifica mais aqui (responsabilidade da camada WebSocket)
    // A camada ranked-websocket-server.ts envia QUEUE_LEFT após chamar removeFromQueue()

    log('info', `? ${player.username} saiu da fila (Total: ${this.queue.size})`)

    // Para matchmaking se fila vazia
    if (this.queue.size === 0 && this.matchmakingInterval) {
      clearInterval(this.matchmakingInterval)
      this.matchmakingInterval = undefined
      log('info', '?? Matchmaking pausado (fila vazia)')
    }
  }

  /**
   * Validar se jogador pode entrar na fila
   */
  private async validatePlayer(oidUser: number, discordId?: string): Promise<ValidationResult> {
    // 1. Verifica se já está na fila
    if (this.queue.has(oidUser)) {
      return { valid: false, reason: 'ALREADY_IN_QUEUE' }
    }

    // 1.1. Verifica cooldown ativo (Redis)
    try {
      const cooldownKey = `cooldown:${oidUser}`
      const cooldownEnds = await this.redis.get(cooldownKey)
      if (cooldownEnds) {
        const endsAt = parseInt(cooldownEnds, 10)
        if (!isNaN(endsAt) && endsAt > Date.now()) {
          return { valid: false, reason: 'COOLDOWN_ACTIVE', endsAt }
        }
      }
    } catch {}

    // 2. ?? PROTEÇÃO 2: Verifica se outro perfil do mesmo Discord já está na fila
    if (discordId) {
      const existingPlayerWithSameDiscord = Array.from(this.queue.values()).find(
        p => p.discordId === discordId && p.oidUser !== oidUser
      )

      if (existingPlayerWithSameDiscord) {
        log('warn', `?? Tentativa de multi-accounting: Discord ${discordId} já tem perfil ${existingPlayerWithSameDiscord.oidUser} na fila`)
        return {
          valid: false,
          reason: 'DISCORD_ALREADY_IN_QUEUE',
          existingAccount: existingPlayerWithSameDiscord.username
        }
      }
    }

    // 3. Busca dados do usuário no banco COMBATARMS (jogo)
    const userResult = await prismaGame.$queryRaw<any[]>`
      SELECT u.oiduser, u.NickName, a.BlockEndDate
      FROM CBT_User u
      LEFT JOIN CBT_UserAuth a ON u.oiduser = a.oidUser
      WHERE u.oiduser = ${oidUser}
    `

    if (!userResult || userResult.length === 0) {
      return { valid: false, reason: 'USER_NOT_FOUND' }
    }

    const user = userResult[0]

    // 4. Verifica ban (BlockEndDate)
    if (user.BlockEndDate && new Date(user.BlockEndDate) > new Date()) {
      return {
        valid: false,
        reason: 'BANNED',
        until: new Date(user.BlockEndDate)
      }
    }

    return { valid: true }
  }

  /**
   * Iniciar matchmaking (polling a cada 5s)
   */
  private startMatchmaking(): void {
    log('info', '?? Matchmaking iniciado')

    this.matchmakingInterval = setInterval(async () => {
      // ? Proteção contra reentrada: se matchmaking já está rodando, pula
      if (this.isMatchmakingRunning) {
        log('debug', '?? Matchmaking já está rodando, pulando tick')
        return
      }

      if (this.queue.size < 10) {
        log('debug', `? Aguardando jogadores (${this.queue.size}/10)`)
        return
      }

      // Marca como rodando
      this.isMatchmakingRunning = true

      try {
        // Tenta criar match
        const match = await this.findMatch()
        if (match) {
          await this.createMatch(match)
        }
      } catch (error) {
        log('error', '? Erro no matchmaking:', error)
      } finally {
        // Sempre libera flag, mesmo se houver erro
        this.isMatchmakingRunning = false
      }
    }, 3500) // A cada 5 segundos
  }

/**
   * Algoritmo de matchmaking (10 jogadores):
   * - Considera MMR ±200 em torno do jogador mais antigo
   * - Slots-alvo: 2x SNIPER, 8x "Rifles" (T1-T4 ou SMG)
   * - Garante que os 8 "Rifles" não sejam SNIPER primário.
   */
private async findMatch(): Promise<QueuePlayer[] | null> {
    const players = Array.from(this.queue.values())
    players.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0)) // FIFO

    if (players.length < 10) return null

    const getClasses = (p: QueuePlayer) => p.classes || { primary: 'T3', secondary: 'SMG' } as any

    // Iterar por cada jogador (começando do mais antigo)
    // e ver se podemos construir um match *ao redor dele*.
    for (let i = 0; i <= players.length - 10; i++) {
      const reference = players[i];
      const mmrMin = reference.mmr - 200;
      const mmrMax = reference.mmr + 200;

      // Filtra o pool *completo* por MMR
      const mmrPool = players.filter(p => p.mmr >= mmrMin && p.mmr <= mmrMax)
      
      if (mmrPool.length < 10) continue; // Pula para o próximo jogador de referência

      // Dentro do pool de MMR, pega os 10 mais antigos
      const picked = mmrPool.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0)).slice(0, 10);
      
      // *** ÚNICA REGRA: ***
      // O grupo de 10 precisa ter pelo menos 2 jogadores que possam ser SNIPER
      const sniperCandidates = picked.filter(p => {
        const classes = getClasses(p);
        return classes.primary === 'SNIPER' || classes.secondary === 'SNIPER';
      });

      if (sniperCandidates.length >= 2) {
        // Encontramos um pool viável!
        log('info', `? Match encontrado! (10) MMR range: ${mmrMin}-${mmrMax}`)
        return picked; // Envia este pool de 10 para o buildStrictTeams
      }
      
      // Se não tem 2 snipers, o loop 'for' continua e tenta
      // construir um match ao redor do *próximo* jogador mais antigo.
    }

    log('debug', `? Matchmaking falhou: Não foi possível montar um grupo de 10 com 2 snipers.`)
    return null;
  }
  /**
   * Criar match com 10 jogadores (salva APENAS no Redis, não no SQL)
   * Match só será persistido no SQL após o ready check passar
   */
  private async createMatch(players: QueuePlayer[]): Promise<void> {
    const matchId = await this.generateMatchId()

    // Guarda metadados da fila para requeue em caso de falha de host/ready
    try {
      const snapshot = players.map(p => ({
        oidUser: p.oidUser,
        queuedAt: p.queuedAt || Date.now(),
        classes: p.classes,
        username: p.username,
        mmr: p.mmr
      }))
      await this.redis.set(`match:${matchId}:queueSnapshot`, JSON.stringify(snapshot), { EX: 7200 })
    } catch (err) {
      log('warn', `Falha ao armazenar snapshot da fila do match ${matchId}`, err as any)
    }

    // Remove jogadores da fila
    for (const player of players) {
      this.queue.delete(player.oidUser)
      await this.redis.del(`queue:ranked:${player.oidUser}`)
    }

    // Balanceia times considerando sniper e tiers
    const teams = this.balanceTeams(players)
    if (!teams) {
      log('warn', `⚠️ Match ${matchId} cancelado: não foi possível formar dois times válidos com as regras de tier`)

      for (const player of players) {
        this.queue.set(player.oidUser, player)
        await this.redis.set(
          `queue:ranked:${player.oidUser}`,
          JSON.stringify({
            oidUser: player.oidUser,
            username: player.username,
            mmr: player.mmr,
            classes: player.classes,
            queuedAt: player.queuedAt || Date.now()
          }),
          { EX: 3600 }
        )
      }

      await this.redis.del(`match:${matchId}:queueSnapshot`).catch(() => {})
      return
    }

    // Salva lobby TEMPORÁRIA no Redis (não no SQL!)
    await this.redis.set(
      `lobby:temp:${matchId}`,
      JSON.stringify({
        matchId,
        status: 'awaiting-ready',
        players: players.map(p => ({
          oidUser: p.oidUser,
          username: p.username,
          mmr: p.mmr,
          classes: p.classes
        })),
        teams: {
          ALPHA: teams.ALPHA.map(p => ({ oidUser: p.player.oidUser, username: p.player.username, mmr: p.player.mmr })),
          BRAVO: teams.BRAVO.map(p => ({ oidUser: p.player.oidUser, username: p.player.username, mmr: p.player.mmr }))
        },
        createdAt: Date.now()
      }),
      { EX: 300 }
    )

    // Salva classes por jogador para uso na lobby (sobrevive ao ready)
    try {
      const key = `match:${matchId}:classes`
      const allPlayersWithRoles = [
        ...teams.ALPHA.map(item => ({ ...item.player, assignedRole: item.role })),
        ...teams.BRAVO.map(item => ({ ...item.player, assignedRole: item.role }))
      ]

      for (const p of allPlayersWithRoles) {
        const dataToStore = {
          primary: p.classes?.primary || 'T3',
          secondary: p.classes?.secondary || 'SMG',
          assignedRole: p.assignedRole // <-- A INFORMAÇÃO CRÍTICA
        }
        await this.redis.hSet(key, p.oidUser.toString(), JSON.stringify(dataToStore))
      }
      await this.redis.expire(key, 7200) // 2 horas
    } catch (err) {
        log('error', `Falha ao salvar papéis no Redis para match ${matchId}`, err)
    }

    log('info', `?? Lobby temporária ${matchId} criada (aguardando ready check)`)

    // Notificar camada WebSocket
    if (this.onMatchFoundCallback) {
      // "Achata" a estrutura de volta para o que o onMatchFoundCallback espera
      const flatTeams = {
        ALPHA: teams.ALPHA.map(p => p.player),
        BRAVO: teams.BRAVO.map(p => p.player)
      };
      this.onMatchFoundCallback(matchId, players, flatTeams);
    }

    // Iniciar ready check
    if (this.readyManager) {
      log('info', `?? Iniciando ready check (60 segundos)`)
      await this.readyManager.startReadyCheck(matchId, players.map(p => p.oidUser))
    }
  }

  /**
   * Balancear times garantindo 1 sniper + T1..T4 únicos por time.
   */
  private balanceTeams(players: QueuePlayer[]): { ALPHA: { player: QueuePlayer, role: TeamRole }[], BRAVO: { player: QueuePlayer, role: TeamRole }[] } | null {
    const strict = this.buildStrictTeams(players)
    if (strict) {
      log('info', '✅ Times balanceados com regras completas de tier')
      return strict
    }

    log('warn', '⚠️ Não foi possível balancear tiers respeitando todas as regras')
    return null
  }

/**
   * Aplica busca com backtracking para atender exatamente 1 SNIPER + T1..T4 por time,
   * garantindo que classes primárias (ou 'SMG' como flex) não se repitam.
   */
  private buildStrictTeams(players: QueuePlayer[]): { ALPHA: { player: QueuePlayer, role: TeamRole }[], BRAVO: { player: QueuePlayer, role: TeamRole }[] } | null {
    // Slots de *role*, não de classe.
    const slots: Array<{ team: 'ALPHA' | 'BRAVO'; role: TeamRole }> = [
      { team: 'ALPHA', role: 'SNIPER' }, { team: 'BRAVO', role: 'SNIPER' },
      { team: 'ALPHA', role: 'T1' }, { team: 'BRAVO', role: 'T1' },
      { team: 'ALPHA', role: 'T2' }, { team: 'BRAVO', role: 'T2' },
      { team: 'ALPHA', role: 'T3' }, { team: 'BRAVO', role: 'T3' },
      { team: 'ALPHA', role: 'T4' }, { team: 'BRAVO', role: 'T4' },
    ]

    const sortedPlayers = [...players].sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0))
    const usedPlayer = new Set<number>()
    
    // Rastreia as *classes primárias* (ou SNIPER sec) já usadas em cada time
    const usedClassesAlpha = new Set<WeaponTier | 'SNIPER'>()
    const usedClassesBravo = new Set<WeaponTier | 'SNIPER'>()

    const alpha: { player: QueuePlayer, role: TeamRole }[] = []
    const bravo: { player: QueuePlayer, role: TeamRole }[] = []
    let best: TeamAssignment | null = null

    const getClasses = (p: QueuePlayer) => p.classes || { primary: 'T3', secondary: 'SMG' } as any

    const tryAssign = (slotIndex: number, alphaMMR: number, bravoMMR: number): boolean => {
      if (slotIndex === slots.length) {
        const diff = Math.abs(alphaMMR - bravoMMR)
        if (!best || diff < best.diff) {
          best = { diff, alpha: [...alpha], bravo: [...bravo] }
        }
        return diff === 0
      }

      const slot = slots[slotIndex]
      const usedClasses = (slot.team === 'ALPHA') ? usedClassesAlpha : usedClassesBravo

      const candidates = sortedPlayers
        .filter(p => !usedPlayer.has(p.oidUser))
        .map(player => ({ 
            player, 
            priority: this.getRolePriority(player, slot.role),
            primaryClass: getClasses(player).primary as WeaponTier
        }))
        .filter(c => c.priority !== null)
        // *** INÍCIO DA CORREÇÃO ***
        // Filtra candidatos cuja classe principal (ou 'flex' SMG) já foi usada neste time
        .filter(c => {
          // Define a classe "real" que o jogador representa
          let playerClass: WeaponTier | 'SNIPER' = c.primaryClass;
          
          if (slot.role === 'SNIPER' && c.priority === 1) {
            // Se for um sniper secundário (prio 1) preenchendo slot SNIPER,
            // a classe "gasta" é SNIPER, não a primária do jogador (ex: T1).
            playerClass = 'SNIPER';
          } else if (c.primaryClass === 'SMG') {
            // Se for um SMG (prio 1) preenchendo um slot (ex: T1),
            // a classe "gasta" é SMG (flex), não T1.
            playerClass = 'SMG';
          }

          // A classe real do jogador NÃO PODE já estar em uso no time.
          return !usedClasses.has(playerClass)
        })
        // *** FIM DA CORREÇÃO ***
        .sort((a, b) => {
          const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0)
          if (priorityDiff !== 0) return priorityDiff
          const queuedDiff = (a.player.queuedAt || 0) - (b.player.queuedAt || 0)
          if (queuedDiff !== 0) return queuedDiff
          return b.player.mmr - a.player.mmr
        })

      if (candidates.length === 0) {
        return false
      }

      for (const candidate of candidates) {
        const { player, primaryClass, priority } = candidate
        
        // Define a classe que será "gasta"
        let classToOccupy: WeaponTier | 'SNIPER' = primaryClass
        if (slot.role === 'SNIPER' && priority === 1) {
          classToOccupy = 'SNIPER'
        } else if (primaryClass === 'SMG') {
          classToOccupy = 'SMG'
        }

        usedPlayer.add(player.oidUser)
        usedClasses.add(classToOccupy) // Marca a classe como usada *neste time*

        if (slot.team === 'ALPHA') {
          alpha.push({ player: candidate.player, role: slot.role }) //
          if (tryAssign(slotIndex + 1, alphaMMR + player.mmr, bravoMMR)) return true
          alpha.pop()
        } else {
          bravo.push({ player: candidate.player, role: slot.role })
          if (tryAssign(slotIndex + 1, alphaMMR, bravoMMR + player.mmr)) return true
          bravo.pop()
        }

        usedClasses.delete(classToOccupy) // Libera a classe (backtracking)
        usedPlayer.delete(player.oidUser)
      }

      return false
    }

    tryAssign(0, 0, 0)
    const finalBest = best as TeamAssignment | null
    if (finalBest && finalBest.alpha.length === 5 && finalBest.bravo.length === 5) {
      return { ALPHA: finalBest.alpha, BRAVO: finalBest.bravo }
    }

    // Se falhar, loga o porquê (ajuda a debugar o pool do findMatch)
    log('warn', `⚠️ buildStrictTeams falhou. O pool de 10 jogadores do findMatch pode não ter as classes únicas necessárias.`)
    return null
  }
  /**
   * Determina prioridade de um jogador para ocupar um papel específico.
   */
/**
   * Determina prioridade de um jogador para ocupar um papel específico (REGRAS ESTRITAS)
   */
  private getRolePriority(player: QueuePlayer, role: TeamRole): number | null {
    const classes = player.classes || { primary: 'T3', secondary: 'SMG' } as const
    const primary = classes.primary
    const secondary = classes.secondary

    // Regra 1: Jogador de SNIPER (primário) SÓ pode ser SNIPER
    if (primary === 'SNIPER') {
      return role === 'SNIPER' ? 0 : null
    }

    // Regra 2: Preenchendo o slot de SNIPER (apenas se não for sniper primário)
    if (role === 'SNIPER') {
      if (secondary === 'SNIPER') return 1 // Prioridade 1 (secundária)
      return null // Não é sniper
    }

    // Regra 3: Preenchendo slots T1-T4
    // A classe primária do jogador DEVE ser o slot (ex: T1 -> T1) ou SMG (flex)
    if (primary === role) return 0     // Match exato (T1 -> T1), Prio 0
    if (primary === 'SMG') return 1    // SMG (flex), Prio 1
    
    // Classes secundárias NÃO são mais usadas para preencher T1-T4
    return null
  }

  /** Gerar ID sequencial via Redis */
  private async generateMatchId(): Promise<string> {
    const matchNumber = await this.redis.incr('match:counter')
    return matchNumber.toString()
  }

  /** Tamanho da fila */
  getQueueSize(): number { return this.queue.size }
  /** Jogadores na fila */
  getQueuePlayers(): QueuePlayer[] { return Array.from(this.queue.values()) }
  /** Verificar se está na fila */
  isInQueue(oidUser: number): boolean { return this.queue.has(oidUser) }
  /** Limpar fila (para testes) */
  async clearQueue(): Promise<void> {
    for (const oidUser of this.queue.keys()) { await this.removeFromQueue(oidUser) }
    log('info', '?? Fila limpa')
  }
  /** Parar matchmaking (graceful shutdown) */
  stop(): void {
    if (this.matchmakingInterval) {
      clearInterval(this.matchmakingInterval)
      this.matchmakingInterval = undefined
      log('info', '?? Matchmaking parado (shutdown)')
    }
  }

}



