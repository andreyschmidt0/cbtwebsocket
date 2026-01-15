/**
 * Types para o Social WebSocket Server
 * Apenas funcionalidades sociais: Friends, Quartet, Party
 */

export interface WebSocketMessage {
  type: string;
  [key: string]: any;
}

/**
 * Status de amizade
 */
export type FriendStatus = 'PENDING' | 'ACCEPTED' | 'REMOVED' | 'BLOCKED';

/**
 * Status de convite de quarteto
 */
export type QuartetInviteStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REMOVED';

/**
 * Estado de uma party (dupla temporaria)
 */
export interface PartyState {
  id: string;
  leaderId: number;
  members: number[];
  createdAt: number;
}

/**
 * Visao de um amigo
 */
export interface FriendView {
  oidUser: number;
  username: string | null;
  status: FriendStatus;
  isRequester: boolean;
}

/**
 * Visao de um convite de quarteto
 */
export interface QuartetInviteView {
  oidUser: number;
  username: string;
  status: QuartetInviteStatus;
  isRequester: boolean;
  targetPos: number;
  isCaptain?: boolean;
}
