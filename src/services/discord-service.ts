import { getRedisClient } from '../database/redis-client'
import { log } from '../utils/logger'

type TeamKey = 'ALPHA' | 'BRAVO'
type RequestInitLike = {
  method?: string
  headers?: Record<string, string>
  body?: any
}

interface DiscordServiceConfig {
  botToken?: string
  guildId?: string
  teamCategoryId?: string
  generalChannelId?: string
}

interface DiscordRequestOptions extends RequestInitLike {
  skipErrorLog?: boolean
}

interface MoveResult {
  ok: boolean
  reason?: string
  channelId?: string
}

export class DiscordService {
  private redis = getRedisClient()
  private botToken: string
  private guildId: string
  private teamCategoryId?: string
  private generalChannelId?: string
  private fetchFn: (url: string, init?: any) => Promise<any>

  constructor(config: DiscordServiceConfig = {}) {
    this.botToken = config.botToken || process.env.DISCORD_BOT_TOKEN || ''
    this.guildId = config.guildId || process.env.DISCORD_GUILD_ID || ''
    this.teamCategoryId = config.teamCategoryId || process.env.DISCORD_TEAM_CATEGORY_ID
    this.generalChannelId = config.generalChannelId || process.env.DISCORD_GENERAL_CHANNEL_ID
    this.fetchFn = (globalThis as any).fetch

    if (!this.isEnabled()) {
      log('warn', 'DiscordService desabilitado: defina DISCORD_BOT_TOKEN e DISCORD_GUILD_ID')
    }
  }

  isEnabled(): boolean {
    return Boolean(this.botToken && this.guildId)
  }

  getGeneralChannelInfo(): { channelId?: string; guildId?: string; url?: string } {
    const url =
      this.generalChannelId && this.guildId
        ? `https://discord.com/channels/${this.guildId}/${this.generalChannelId}`
        : undefined

    return {
      channelId: this.generalChannelId,
      guildId: this.guildId || undefined,
      url
    }
  }

  private async discordRequest(path: string, init: DiscordRequestOptions = {}): Promise<{ ok: boolean; status: number; data?: any }> {
    if (!this.isEnabled() || !this.fetchFn) {
      return { ok: false, status: 0 }
    }

    const headers = {
      Authorization: `Bot ${this.botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'cbt-websocket/1.0',
      ...(init.headers as Record<string, string> | undefined)
    }

    const response = await this.fetchFn(`https://discord.com/api/v10${path}`, {
      ...init,
      headers
    })

    const text = await response.text()
    let data: any = undefined
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }

    if (!response.ok && !init.skipErrorLog) {
      log('warn', `Discord API ${path} falhou (${response.status})`, data)
    }

    return { ok: response.ok, status: response.status, data }
  }

  private async getVoiceState(userId: string): Promise<any | null> {
    const result = await this.discordRequest(`/guilds/${this.guildId}/voice-states/${userId}`, {
      method: 'GET',
      skipErrorLog: true
    })

    if (result.status === 404) return null
    if (!result.ok) return null
    return result.data || null
  }

  private async resolveRoomId(matchId: string): Promise<string | null> {
    try {
      const raw = await this.redis.get(`match:${matchId}:room`)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.roomId) return String(parsed.roomId)
      }

      const fallback = await this.redis.get(`room:${matchId}`)
      return fallback ? String(fallback) : null
    } catch (error) {
      log('warn', `Falha ao resolver roomId para ${matchId}`, error)
      return null
    }
  }

  async createTeamChannels(
    matchId: string,
    roomId: number | string,
    teamMembers?: Partial<Record<TeamKey, string[]>>
  ): Promise<{ alphaChannelId?: string; bravoChannelId?: string }> {
    if (!this.isEnabled()) return {}

    const VIEW = 1n << 10n
    const CONNECT = 1n << 20n
    const SPEAK = 1n << 21n
    const STREAM = 1n << 22n
    const USE_VAD = 1n << 25n
    const allowVoicePermissions = (VIEW | CONNECT | SPEAK | STREAM | USE_VAD).toString()
    const denyViewConnect = (VIEW | CONNECT).toString()

    const buildOverwrites = (team: TeamKey) => {
      const allowed = (teamMembers?.[team] || []).filter(Boolean)
      if (!allowed.length) return undefined

      const overwrites: Array<{ id: string; type: 0 | 1; allow?: string; deny?: string }> = []

      if (this.guildId) {
        overwrites.push({
          id: this.guildId,
          type: 0, // @everyone role
          deny: denyViewConnect
        })
      }

      for (const id of allowed) {
        overwrites.push({
          id,
          type: 1, // member
          allow: allowVoicePermissions
        })
      }

      return overwrites
    }

    const parent_id = this.teamCategoryId
    const createChannel = async (name: string, team: TeamKey) => {
      const result = await this.discordRequest(`/guilds/${this.guildId}/channels`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          type: 2, // voice
          parent_id,
          user_limit: 5,
          permission_overwrites: buildOverwrites(team)
        })
      })
      return result.ok ? (result.data?.id as string | undefined) : undefined
    }

    const [alphaChannelId, bravoChannelId] = await Promise.all([
      createChannel(`ALPHA-${roomId}`, 'ALPHA'),
      createChannel(`BRAVO-${roomId}`, 'BRAVO')
    ])

    try {
      const multi = this.redis.multi()
      if (alphaChannelId) {
        multi.set(`match:${roomId}:discord:ALPHA`, alphaChannelId, { EX: 21600 })
        multi.set(`match:${matchId}:discord:ALPHA`, alphaChannelId, { EX: 21600 })
      }
      if (bravoChannelId) {
        multi.set(`match:${roomId}:discord:BRAVO`, bravoChannelId, { EX: 21600 })
        multi.set(`match:${matchId}:discord:BRAVO`, bravoChannelId, { EX: 21600 })
      }
      await multi.exec()
    } catch (error) {
      log('warn', `Falha ao salvar canais no Redis para match ${matchId}`, error)
    }

    return { alphaChannelId, bravoChannelId }
  }

  async movePlayerToTeamChannel(matchId: string, team: TeamKey, discordUserId: string): Promise<MoveResult> {
    if (!this.isEnabled()) return { ok: false, reason: 'SERVICE_DISABLED' }
    if (!discordUserId) return { ok: false, reason: 'MISSING_DISCORD_ID' }

    const roomId = await this.resolveRoomId(matchId)
    if (!roomId) return { ok: false, reason: 'ROOM_ID_MISSING' }

    const channelId =
      (await this.redis.get(`match:${roomId}:discord:${team}`)) ||
      (await this.redis.get(`match:${matchId}:discord:${team}`))

    if (!channelId) return { ok: false, reason: 'CHANNEL_NOT_FOUND' }

    const voiceState = await this.getVoiceState(discordUserId)
    if (voiceState === null) {
      return { ok: false, reason: 'NOT_IN_VOICE' }
    }

    const moveResult = await this.discordRequest(`/guilds/${this.guildId}/members/${discordUserId}`, {
      method: 'PATCH',
      body: JSON.stringify({ channel_id: channelId })
    })

    if (!moveResult.ok) {
      return { ok: false, reason: 'MOVE_FAILED' }
    }

    return { ok: true, channelId }
  }

  async deleteChannelsByMatchId(matchId: string): Promise<void> {
    if (!this.isEnabled()) return

    const keys = [
      `match:${matchId}:discord:ALPHA`,
      `match:${matchId}:discord:BRAVO`
    ]

    const roomId = await this.resolveRoomId(matchId)
    if (roomId) {
      keys.push(`match:${roomId}:discord:ALPHA`, `match:${roomId}:discord:BRAVO`)
    }

    const channelIds = await this.redis.mGet(keys)
    const uniqueIds = Array.from(new Set(channelIds.filter(Boolean) as string[]))

    for (const id of uniqueIds) {
      await this.discordRequest(`/channels/${id}`, { method: 'DELETE', skipErrorLog: true })
    }

    try {
      if (keys.length) {
        await this.redis.del(keys)
      }
    } catch (error) {
      log('warn', `Falha ao limpar chaves de canais do Discord para match ${matchId}`, error)
    }
  }
}
