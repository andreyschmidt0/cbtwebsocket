import { getRedisClient } from '../database/redis-client'
import { log } from '../utils/logger'

export interface PartyState {
  id: string
  leaderId: number
  members: number[] // inclui o líder
  createdAt: number
}

/**
 * PartyManager - Gerencia parties/duplas em Redis (temporário)
 */
export class PartyManager {
  private redis = getRedisClient()

  private partyKey(id: string) { return `party:${id}` }
  private playerIndexKey(oidUser: number) { return `party:byPlayer:${oidUser}` }

  async getParty(partyId: string): Promise<PartyState | null> {
    try {
      const raw = await this.redis.get(this.partyKey(partyId))
      return raw ? JSON.parse(raw) as PartyState : null
    } catch (err) {
      log('warn', `Falha ao carregar party ${partyId}`, err)
      return null
    }
  }

  async getPartyIdByPlayer(oidUser: number): Promise<string | null> {
    try {
      return await this.redis.get(this.playerIndexKey(oidUser))
    } catch {
      return null
    }
  }

  async createParty(leaderId: number): Promise<PartyState> {
    const existing = await this.getPartyIdByPlayer(leaderId)
    if (existing) {
      const party = await this.getParty(existing)
      if (party) return party
    }
    // Usa ID incremental simples para facilitar UX/depura��o
    const counter = await this.redis.incr('party:counter')
    const id = String(counter)
    const party: PartyState = {
      id,
      leaderId,
      members: [leaderId],
      createdAt: Date.now()
    }
    await this.persistParty(party)
    return party
  }

  async addMember(partyId: string, oidUser: number): Promise<PartyState | null> {
    const currentPartyId = await this.getPartyIdByPlayer(oidUser)
    if (currentPartyId) return null
    const party = await this.getParty(partyId)
    if (!party) return null
    if (party.members.includes(oidUser)) return party
    party.members.push(oidUser)
    await this.persistParty(party)
    return party
  }

  async removeMember(partyId: string, oidUser: number): Promise<PartyState | null> {
    const party = await this.getParty(partyId)
    if (!party) return null
    party.members = party.members.filter(id => id !== oidUser)
    // Remove ��ndice do jogador que saiu
    await this.redis.del(this.playerIndexKey(oidUser))
    if (party.members.length === 0) {
      await this.deleteParty(partyId)
      return null
    }
    if (!party.members.includes(party.leaderId)) {
      party.leaderId = party.members[0]
    }
    await this.persistParty(party)
    return party
  }

  async transferLead(partyId: string, newLeaderId: number): Promise<PartyState | null> {
    const party = await this.getParty(partyId)
    if (!party) return null
    if (!party.members.includes(newLeaderId)) return null
    party.leaderId = newLeaderId
    await this.persistParty(party)
    return party
  }

  async deleteParty(partyId: string): Promise<void> {
    const party = await this.getParty(partyId)
    const keys = [this.partyKey(partyId)]
    if (party) {
      for (const m of party.members) {
        keys.push(this.playerIndexKey(m))
      }
    } else {
      // fallback: remove índices se existirem
      // não listamos membros, mas limpamos o hash da party
    }
    await this.redis.del(keys)
  }

  private async persistParty(party: PartyState): Promise<void> {
    const multi = this.redis.multi()
    multi.set(this.partyKey(party.id), JSON.stringify(party), { EX: 3600 })
    for (const m of party.members) {
      multi.set(this.playerIndexKey(m), party.id, { EX: 3600 })
    }
    await multi.exec()
  }

  /**
   * Renova o TTL das chaves da party (party + Ìndice por jogador), sem alterar membros/lÌder.
   * Útil para manter a party viva enquanto os jogadores est„o em lobby/partida.
   */
  async refreshPartyTtl(partyId: string): Promise<void> {
    const party = await this.getParty(partyId)
    if (!party) return
    const multi = this.redis.multi()
    multi.expire(this.partyKey(party.id), 3600)
    for (const m of party.members) {
      multi.expire(this.playerIndexKey(m), 3600)
    }
    await multi.exec()
  }
}
