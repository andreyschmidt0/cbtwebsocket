import { log } from '../utils/logger';
import { prismaGame, prismaRanked } from '../database/prisma';

/**
 * Tipos para o sistema de convites de torneio
 */
export interface TournamentInviteData {
  inviteId: number;
  inscricaoId: number;
  tournamentId: number;
  tournamentName: string;
  leaderOidUser: number;
  leaderNickname: string;
  oidUser: number;
  nickname: string;
  status: 'Pendente' | 'Aceito' | 'Recusado';
  position: number;
  dataConvite: Date;
  dataResposta: Date | null;
}

export interface SendInviteResult {
  ok: boolean;
  reason?: string;
  inviteId?: number;
  inscricaoId?: number;
}

export interface InviteResponseResult {
  ok: boolean;
  reason?: string;
}

/**
 * TournamentInviteManager - Gerencia convites de torneio no banco de dados
 */
export class TournamentInviteManager {
  /**
   * Buscar todos os convites pendentes de um jogador
   */
  async getPendingInvites(oidUser: number): Promise<TournamentInviteData[]> {
    try {
      const invites = await prismaRanked.$queryRaw<any[]>`
        SELECT
          i.InviteID as inviteId,
          i.InscricaoID as inscricaoId,
          i.oidUser,
          i.Status as status,
          i.Posicao as position,
          i.DataConvite as dataConvite,
          i.DataResposta as dataResposta,
          ins.TorneioID as tournamentId,
          ins.LiderOidUser as leaderOidUser,
          t.NomeTorneio as tournamentName,
          u.NickName as leaderNickname,
          u2.NickName as nickname
        FROM COMBATARMS.dbo.FCA_Torneios_Invites i
        INNER JOIN COMBATARMS.dbo.FCA_Torneios_Inscricoes ins ON ins.InscricaoID = i.InscricaoID
        INNER JOIN COMBATARMS.dbo.FCA_Torneios t ON t.TorneioID = ins.TorneioID
        INNER JOIN COMBATARMS.dbo.CBT_User u ON u.oiduser = ins.LiderOidUser
        INNER JOIN COMBATARMS.dbo.CBT_User u2 ON u2.oiduser = i.oidUser
        WHERE i.oidUser = ${oidUser}
          AND i.Status = 'Pendente'
          AND t.Status = 'Aberto'
        ORDER BY i.DataConvite DESC
      `;

      return invites.map(inv => ({
        inviteId: inv.inviteId,
        inscricaoId: inv.inscricaoId,
        tournamentId: inv.tournamentId,
        tournamentName: inv.tournamentName,
        leaderOidUser: inv.leaderOidUser,
        leaderNickname: inv.leaderNickname,
        oidUser: inv.oidUser,
        nickname: inv.nickname,
        status: inv.status,
        position: inv.position,
        dataConvite: inv.dataConvite,
        dataResposta: inv.dataResposta
      }));
    } catch (error) {
      log('error', `Erro ao buscar convites pendentes para ${oidUser}:`, error);
      return [];
    }
  }

  /**
   * Enviar convite para um jogador
   */
  async sendInvite(
    leaderOidUser: number,
    tournamentId: number,
    targetNickname: string,
    position: number
  ): Promise<SendInviteResult> {
    try {
      // 1. Buscar oidUser do target pelo nickname
      const targetUser = await prismaGame.$queryRaw<any[]>`
        SELECT oiduser, discordId FROM CBT_User WHERE NickName = ${targetNickname}
      `;

      if (!targetUser || targetUser.length === 0) {
        return { ok: false, reason: 'PLAYER_NOT_FOUND' };
      }

      const targetOidUser = targetUser[0].oiduser;
      const targetDiscordId = targetUser[0].discordId;

      // 2. Verificar se o torneio existe e está aberto
      const tournament = await prismaRanked.$queryRaw<any[]>`
        SELECT TorneioID, Status, LimiteInscritos FROM FCA_Torneios
        WHERE TorneioID = ${tournamentId}
      `;

      if (!tournament || tournament.length === 0) {
        return { ok: false, reason: 'TOURNAMENT_NOT_FOUND' };
      }

      if (tournament[0].Status !== 'Aberto') {
        return { ok: false, reason: 'TOURNAMENT_CLOSED' };
      }

      // 3. Verificar se o líder é líder de um clã
      const leaderClan = await prismaGame.$queryRaw<any[]>`
      SELECT * FROM NX_GuildMaster.dbo.gdt_Guild
      WHERE oidCharacter_master = ${leaderOidUser} 
      `;

      if (!leaderClan || leaderClan.length === 0) {
        return { ok: false, reason: 'NOT_CLAN_LEADER' };
      }

      const clanId = leaderClan[0].oidGuild;

      // 4. Verificar se o target é do mesmo clã
      const targetClanMember = await prismaGame.$queryRaw<any[]>`
        SELECT oidGuild FROM NX_GuildMaster.dbo.gdt_Member
        WHERE oidUser = ${targetOidUser}
      `;

      if (!targetClanMember || targetClanMember.length === 0 || targetClanMember[0].oidGuild !== clanId) {
        return { ok: false, reason: 'PLAYER_NOT_IN_CLAN' };
      }

      // 5. Verificar ou criar inscrição
      let inscricaoId: number;
      const existingInscricao = await prismaRanked.$queryRaw<any[]>`
        SELECT InscricaoID FROM COMBATARMS.dbo.FCA_Torneios_Inscricoes
        WHERE TorneioID = ${tournamentId} AND LiderOidUser = ${leaderOidUser}
      `;

      if (existingInscricao && existingInscricao.length > 0) {
        inscricaoId = existingInscricao[0].InscricaoID;
      } else {
        // Verificar se o clã já tem outra inscrição
        const clanInscricao = await prismaRanked.$queryRaw<any[]>`
          SELECT InscricaoID FROM COMBATARMS.dbo.FCA_Torneios_Inscricoes
          WHERE TorneioID = ${tournamentId} AND ClanID = ${clanId}
        `;

        if (clanInscricao && clanInscricao.length > 0) {
          return { ok: false, reason: 'CLAN_ALREADY_REGISTERED' };
        }

        // Criar nova inscrição
        await prismaRanked.$executeRaw`
          INSERT INTO COMBATARMS.dbo.FCA_Torneios_Inscricoes (TorneioID, StatusInscricao, LiderOidUser, ClanID)
          VALUES (${tournamentId}, 'Em Montagem', ${leaderOidUser}, ${clanId})
        `;

        const newInscricao = await prismaRanked.$queryRaw<any[]>`
          SELECT InscricaoID FROM COMBATARMS.dbo.FCA_Torneios_Inscricoes
          WHERE TorneioID = ${tournamentId} AND LiderOidUser = ${leaderOidUser}
        `;

        if (!newInscricao || newInscricao.length === 0) {
          return { ok: false, reason: 'FAILED_TO_CREATE_INSCRIPTION' };
        }

        inscricaoId = newInscricao[0].InscricaoID;

        // Adicionar o líder como confirmado na posição 1
        await prismaRanked.$executeRaw`
          INSERT INTO COMBATARMS.dbo.FCA_Torneios_Invites (InscricaoID, oidUser, Status, Posicao)
          VALUES (${inscricaoId}, ${leaderOidUser}, 'Aceito', 1)
        `;
      }

      // 6. Verificar se a posição já está ocupada
      const positionCheck = await prismaRanked.$queryRaw<any[]>`
        SELECT InviteID FROM COMBATARMS.dbo.FCA_Torneios_Invites
        WHERE InscricaoID = ${inscricaoId} AND Posicao = ${position}
      `;

      if (positionCheck && positionCheck.length > 0) {
        return { ok: false, reason: 'POSITION_ALREADY_TAKEN' };
      }

      // 7. Verificar se o jogador já foi convidado para este time
      const alreadyInvited = await prismaRanked.$queryRaw<any[]>`
        SELECT InviteID FROM COMBATARMS.dbo.FCA_Torneios_Invites
        WHERE InscricaoID = ${inscricaoId} AND oidUser = ${targetOidUser}
      `;

      if (alreadyInvited && alreadyInvited.length > 0) {
        return { ok: false, reason: 'PLAYER_ALREADY_INVITED' };
      }

      // 8. Validação de discordId - verificar se já existe no MESMO TIME
      if (targetDiscordId) {
        const discordInSameTeam = await prismaRanked.$queryRaw<any[]>`
          SELECT i.InviteID
          FROM COMBATARMS.dbo.FCA_Torneios_Invites i
          INNER JOIN COMBATARMS.dbo.CBT_User u ON u.oiduser = i.oidUser
          WHERE i.InscricaoID = ${inscricaoId}
            AND u.discordId = ${targetDiscordId}
            AND i.Status IN ('Pendente', 'Aceito')
        `;

        if (discordInSameTeam && discordInSameTeam.length > 0) {
          return { ok: false, reason: 'DISCORD_ALREADY_IN_TEAM' };
        }

        // 9. Validação de discordId - verificar se já existe em OUTRO TIME do torneio
        const discordInOtherTeam = await prismaRanked.$queryRaw<any[]>`
          SELECT i.InviteID
          FROM COMBATARMS.dbo.FCA_Torneios_Invites i
          INNER JOIN COMBATARMS.dbo.FCA_Torneios_Inscricoes ins ON ins.InscricaoID = i.InscricaoID
          INNER JOIN COMBATARMS.dbo.CBT_User u ON u.oiduser = i.oidUser
          WHERE ins.TorneioID = ${tournamentId}
            AND ins.InscricaoID != ${inscricaoId}
            AND u.discordId = ${targetDiscordId}
            AND i.Status IN ('Pendente', 'Aceito')
        `;

        if (discordInOtherTeam && discordInOtherTeam.length > 0) {
          return { ok: false, reason: 'DISCORD_IN_OTHER_TEAM' };
        }
      }

      // 10. Criar o convite
      await prismaRanked.$executeRaw`
        INSERT INTO COMBATARMS.dbo.FCA_Torneios_Invites (InscricaoID, oidUser, Status, Posicao)
        VALUES (${inscricaoId}, ${targetOidUser}, 'Pendente', ${position})
      `;

      // Buscar o ID do convite criado
      const newInvite = await prismaRanked.$queryRaw<any[]>`
        SELECT InviteID FROM COMBATARMS.dbo.FCA_Torneios_Invites
        WHERE InscricaoID = ${inscricaoId} AND oidUser = ${targetOidUser}
      `;

      if (!newInvite || newInvite.length === 0) {
        return { ok: false, reason: 'FAILED_TO_CREATE_INVITE' };
      }

      return {
        ok: true,
        inviteId: newInvite[0].InviteID,
        inscricaoId
      };
    } catch (error) {
      log('error', 'Erro ao enviar convite de torneio:', error);
      return { ok: false, reason: 'INTERNAL_ERROR' };
    }
  }

  /**
   * Aceitar convite de torneio
   */
  async acceptInvite(inviteId: number, oidUser: number): Promise<InviteResponseResult> {
    try {
      // 1. Verificar se o convite existe e pertence ao usuário
      const invite = await prismaRanked.$queryRaw<any[]>`
        SELECT i.InviteID, i.Status, i.InscricaoID, ins.TorneioID
        FROM COMBATARMS.dbo.FCA_Torneios_Invites i
        INNER JOIN COMBATARMS.dbo.FCA_Torneios_Inscricoes ins ON ins.InscricaoID = i.InscricaoID
        WHERE i.InviteID = ${inviteId} AND i.oidUser = ${oidUser}
      `;

      if (!invite || invite.length === 0) {
        return { ok: false, reason: 'INVITE_NOT_FOUND' };
      }

      if (invite[0].Status !== 'Pendente') {
        return { ok: false, reason: 'INVITE_ALREADY_RESPONDED' };
      }

      // 2. Atualizar status do convite
      await prismaRanked.$executeRaw`
        UPDATE COMBATARMS.dbo.FCA_Torneios_Invites
        SET Status = 'Aceito', DataResposta = GETDATE()
        WHERE InviteID = ${inviteId}
      `;

      return { ok: true };
    } catch (error) {
      log('error', 'Erro ao aceitar convite de torneio:', error);
      return { ok: false, reason: 'INTERNAL_ERROR' };
    }
  }

  /**
   * Recusar convite de torneio
   */
  async rejectInvite(inviteId: number, oidUser: number): Promise<InviteResponseResult> {
    try {
      // 1. Verificar se o convite existe e pertence ao usuário
      const invite = await prismaRanked.$queryRaw<any[]>`
        SELECT InviteID, Status FROM COMBATARMS.dbo.FCA_Torneios_Invites
        WHERE InviteID = ${inviteId} AND oidUser = ${oidUser}
      `;

      if (!invite || invite.length === 0) {
        return { ok: false, reason: 'INVITE_NOT_FOUND' };
      }

      if (invite[0].Status !== 'Pendente') {
        return { ok: false, reason: 'INVITE_ALREADY_RESPONDED' };
      }

      // 2. Atualizar status do convite
      await prismaRanked.$executeRaw`
        UPDATE COMBATARMS.dbo.FCA_Torneios_Invites
        SET Status = 'Recusado', DataResposta = GETDATE()
        WHERE InviteID = ${inviteId}
      `;

      return { ok: true };
    } catch (error) {
      log('error', 'Erro ao recusar convite de torneio:', error);
      return { ok: false, reason: 'INTERNAL_ERROR' };
    }
  }

  /**
   * Remover convite (apenas líder pode fazer)
   */
  async removeInvite(inviteId: number, leaderOidUser: number): Promise<InviteResponseResult & { targetOidUser?: number }> {
    try {
      // 1. Verificar se o convite existe e se o solicitante é o líder
      const invite = await prismaRanked.$queryRaw<any[]>`
        SELECT i.InviteID, i.oidUser, ins.LiderOidUser
        FROM COMBATARMS.dbo.FCA_Torneios_Invites i
        INNER JOIN COMBATARMS.dbo.FCA_Torneios_Inscricoes ins ON ins.InscricaoID = i.InscricaoID
        WHERE i.InviteID = ${inviteId}
      `;

      if (!invite || invite.length === 0) {
        return { ok: false, reason: 'INVITE_NOT_FOUND' };
      }

      if (invite[0].LiderOidUser !== leaderOidUser) {
        return { ok: false, reason: 'NOT_LEADER' };
      }

      const targetOidUser = invite[0].oidUser;

      // 2. Deletar o convite
      await prismaRanked.$executeRaw`
        DELETE FROM COMBATARMS.dbo.FCA_Torneios_Invites WHERE InviteID = ${inviteId}
      `;

      return { ok: true, targetOidUser };
    } catch (error) {
      log('error', 'Erro ao remover convite de torneio:', error);
      return { ok: false, reason: 'INTERNAL_ERROR' };
    }
  }

  /**
   * Buscar dados do convite pelo ID (para notificar o líder)
   */
  async getInviteData(inviteId: number): Promise<TournamentInviteData | null> {
    try {
      const invites = await prismaRanked.$queryRaw<any[]>`
        SELECT
          i.InviteID as inviteId,
          i.InscricaoID as inscricaoId,
          i.oidUser,
          i.Status as status,
          i.Posicao as position,
          i.DataConvite as dataConvite,
          i.DataResposta as dataResposta,
          ins.TorneioID as tournamentId,
          ins.LiderOidUser as leaderOidUser,
          t.NomeTorneio as tournamentName,
          u.NickName as leaderNickname,
          u2.NickName as nickname
        FROM COMBATARMS.dbo.FCA_Torneios_Invites i
        INNER JOIN COMBATARMS.dbo.FCA_Torneios_Inscricoes ins ON ins.InscricaoID = i.InscricaoID
        INNER JOIN COMBATARMS.dbo.FCA_Torneios t ON t.TorneioID = ins.TorneioID
        INNER JOIN COMBATARMS.dbo.CBT_User u ON u.oiduser = ins.LiderOidUser
        INNER JOIN COMBATARMS.dbo.CBT_User u2 ON u2.oiduser = i.oidUser
        WHERE i.InviteID = ${inviteId}
      `;

      if (!invites || invites.length === 0) {
        return null;
      }

      const inv = invites[0];
      return {
        inviteId: inv.inviteId,
        inscricaoId: inv.inscricaoId,
        tournamentId: inv.tournamentId,
        tournamentName: inv.tournamentName,
        leaderOidUser: inv.leaderOidUser,
        leaderNickname: inv.leaderNickname,
        oidUser: inv.oidUser,
        nickname: inv.nickname,
        status: inv.status,
        position: inv.position,
        dataConvite: inv.dataConvite,
        dataResposta: inv.dataResposta
      };
    } catch (error) {
      log('error', `Erro ao buscar dados do convite ${inviteId}:`, error);
      return null;
    }
  }

  /**
   * Buscar todos os convites de uma inscrição (para o líder)
   */
  async getInscricaoInvites(inscricaoId: number): Promise<TournamentInviteData[]> {
    try {
      const invites = await prismaRanked.$queryRaw<any[]>`
        SELECT
          i.InviteID as inviteId,
          i.InscricaoID as inscricaoId,
          i.oidUser,
          i.Status as status,
          i.Posicao as position,
          i.DataConvite as dataConvite,
          i.DataResposta as dataResposta,
          ins.TorneioID as tournamentId,
          ins.LiderOidUser as leaderOidUser,
          t.NomeTorneio as tournamentName,
          u.NickName as leaderNickname,
          u2.NickName as nickname
        FROM COMBATARMS.dbo.FCA_Torneios_Invites i
        INNER JOIN COMBATARMS.dbo.FCA_Torneios_Inscricoes ins ON ins.InscricaoID = i.InscricaoID
        INNER JOIN COMBATARMS.dbo.FCA_Torneios t ON t.TorneioID = ins.TorneioID
        INNER JOIN COMBATARMS.dbo.CBT_User u ON u.oiduser = ins.LiderOidUser
        INNER JOIN COMBATARMS.dbo.CBT_User u2 ON u2.oiduser = i.oidUser
        WHERE i.InscricaoID = ${inscricaoId}
        ORDER BY i.Posicao ASC
      `;

      return invites.map(inv => ({
        inviteId: inv.inviteId,
        inscricaoId: inv.inscricaoId,
        tournamentId: inv.tournamentId,
        tournamentName: inv.tournamentName,
        leaderOidUser: inv.leaderOidUser,
        leaderNickname: inv.leaderNickname,
        oidUser: inv.oidUser,
        nickname: inv.nickname,
        status: inv.status,
        position: inv.position,
        dataConvite: inv.dataConvite,
        dataResposta: inv.dataResposta
      }));
    } catch (error) {
      log('error', `Erro ao buscar convites da inscrição ${inscricaoId}:`, error);
      return [];
    }
  }
}
