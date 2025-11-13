import { WebSocket } from 'ws';

export interface ReadyPlayer {
  oidUser: number;
  username: string;
  ws: WebSocket;
  team: string;
  status: 'PENDING' | 'READY' | 'DECLINED';
}

export type WeaponTier = 'T1' | 'T2' | 'T3' | 'T4' | 'SNIPER' | 'SMG';

export interface QueuePlayer {
  oidUser: number;
  username: string;
  mmr: number;
  discordId?: string; // Identificador do Discord para prevenir multi-accounting
  classes?: {
    primary: WeaponTier;
    secondary: WeaponTier;
  };
  queuedAt?: number;
  joinedAt?: number;
}

export interface MatchData {
  id: string;
  players: QueuePlayer[];
  hostOidUser?: number;
  roomId?: number;
  status: 'awaiting-ready' | 'awaiting-host' | 'in-progress' | 'awaiting-confirmation' | 'completed' | 'cancelled';
  createdAt: Date;
}

export interface WebSocketMessage {
  type: string;
  [key: string]: any;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  endsAt?: number;
  until?: Date;
  existingAccount?: string; // Nome da conta existente (para multi-accounting)
}
