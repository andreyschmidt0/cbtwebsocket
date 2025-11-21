# Fluxo cronológico das principais funções (cbtwebsocket)

Este guia lista, em ordem cronológica de execução típica, as funções-chave do servidor de ranked (`cbtwebsocket`). Foca no caminho padrão: entrar na fila → encontrar partida → ready check → lobby → host → logs/validação → atualização de ranking.

## 1) Entrada na fila
- `ranked-websocket-server.ts :: handleQueueJoin`  
  Recebe `QUEUE_JOIN`, busca rank/MMR do jogador, injeta overrides de requeue e chama `queueManager.addToQueue`.
- `queue-manager.ts :: addToQueue`  
  Valida jogador (`validatePlayer`), define `queuedAt`, persiste snapshot no Redis e inicia matchmaking se necessário.
- `queue-manager.ts :: validatePlayer`  
  Bloqueia se já estiver na fila, se houver `cooldown:<oidUser>` ativo, se outro perfil com mesmo Discord estiver na fila ou se houver ban/usuário inexistente.

## 2) Loop de matchmaking
- `queue-manager.ts :: startMatchmaking` (intervalo ~3.5s)  
  Dispara `findMatch` se há jogadores suficientes.
- `queue-manager.ts :: findMatch`  
  Ordena por tempo de espera, calcula janela de MMR dinâmica, monta pool e tenta cumprir contrato de papéis.
- `queue-manager.ts :: pickPlayersByRoleContract` + helpers (`selectForRole`, `buildStrictTeams`, `balanceTeams`)  
  Garante 1 SNIPER + T1..T4 por time, com fallback de autofill e embaralhamento dos times.

## 3) Criação de match temporário e ready check
- `queue-manager.ts :: createMatch`  
  Gera `matchId`, salva snapshot da fila e classes no Redis, remove os jogadores da fila e cria lobby temporária (`lobby:temp:<matchId>`), chamando o callback de match encontrado e o ready check.
- `ranked-websocket-server.ts :: QueueManager.onMatchFound` (callback)  
  Emite `MATCH_FOUND` para os 10 jogadores com timeout de 20s.
- `ready-manager.ts :: startReadyCheck`  
  Cria estrutura em memória + Redis (`match:<id>:ready`), inicia timer de 20s.
- `ready-manager.ts :: handleReady` / `handleDecline`  
  Marca READY/DECLINE; se todos aceitam, chama `handleAllReady`; se alguém recusa/timeout, chama `cancelMatch`.
- `ready-manager.ts :: handleAllReady`  
  Persiste linha inicial em `BST_RankedMatch` (status `ready`), limpa Redis de ready e dispara callback `onReadyComplete`.
- `ranked-websocket-server.ts :: ReadyManager.onReadyComplete` (callback)  
  Cria lobby real no `LobbyManager`, envia `LOBBY_READY`/redirect para todos.

## 4) Lobby e veto de mapas
- `lobby-manager.ts :: createLobby` / `getLobby`  
  Gerencia times, chat (geral/time), histórico de vetos.
- `ranked-websocket-server.ts :: handleLobbyJoin`  
  Entrega dados da lobby para cada jogador (anonimizando o time adversário).
- `lobby-manager.ts :: vetoMap` (via `handleMapVeto`)  
  Alterna vetos, controla turno/timeout; ao finalizar, define `selectedMap`.
- `LobbyManager.onMapSelected` callback → `HOSTManager`  
  Seleciona host, notifica criação de sala.

## 5) Host e criação de sala
- `house-manager.ts :: selectHost` / `confirmHostRoom` / `abortByClient`  
  Escolhe host, aplica timeouts/penalidades, confirma sala e mapa escolhidos.
- `ranked-websocket-server.ts :: handleHostRoomCreated`  
  Recebe `HOST_ROOM_CREATED`, confirma no host manager e notifica `HOST_CONFIRMED`.

## 6) Coleta de logs e validação da partida
- `validation-manager.ts :: handleFullMatchLog` (entrada de logs)  
  Recebe e armazena logs OEM (`BST_FullMatchLog`), monitora abandono/relogin, acumula por jogador/time.
- `validation-manager.ts :: tryValidateMatch` / `finalizeMatchIfComplete`  
  Quando possui logs suficientes ou timeout, avalia vencedor, abandonos e integridade.
- `validation-manager.ts :: onMatchCompleted` (callback configurado no servidor)  
  Atualiza `BST_MatchPlayer`, `BST_RankedMatch`, aplica mmr/rank/brasões, publica eventos e dispara payload `MATCH_ENDED`.

## 7) Atualização de ranking e brasões
- `rank-calculator.ts`  
  Funções de cálculo de pontos/MMR (±15 base etc.).  
- `rank-tiers.ts :: computeMatchmakingValue`, `formatTierLabel`, `getBackgroundIdForTier`  
  Converte tier/pontos para valor de matchmaking e mapeia brasões.
- `validation-manager.ts :: updatePlayerBackground`  
  Escreve `COMBATARMS.dbo.CBT_User_NickName_Background` com o `Background` do elo (Emblem=0, EndDate 2500-12-31).

## 8) Saída/limpeza
- `ranked-websocket-server.ts :: handleReadyFailed`  
  Reposiciona jogadores que aceitaram de volta na fila (requeue snapshot) exceto o que recusou.
- `queue-manager.ts :: removeFromQueue` / `clearQueue`  
  Limpa fila e snapshots.
- `ready-manager.ts :: clearAllChecks` / `host-manager.ts :: clearAllAttempts` / `lobby-manager.ts :: stop`  
  Limpam timers e caches em shutdown.
