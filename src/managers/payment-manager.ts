import { WebSocket } from 'ws';
import { log } from '../utils/logger';

interface PaymentWatcher {
  socket: WebSocket;
  transactionId: string;
}

export class PaymentManager {
  // Map<transactionId, Set<WebSocket>>
  private watchers: Map<string, Set<WebSocket>> = new Map();

  /**
   * Registra um socket para assistir atualizações de uma transação
   */
  public watchTransaction(socket: WebSocket, transactionId: string): void {
    if (!this.watchers.has(transactionId)) {
      this.watchers.set(transactionId, new Set());
    }
    
    this.watchers.get(transactionId)!.add(socket);
    log('debug', `Socket assistindo transação: ${transactionId}`);

    // Remove watcher quando o socket fechar
    socket.on('close', () => {
      this.unwatchTransaction(socket, transactionId);
    });
  }

  /**
   * Remove um socket da lista de watchers
   */
  public unwatchTransaction(socket: WebSocket, transactionId: string): void {
    const watchers = this.watchers.get(transactionId);
    if (watchers) {
      watchers.delete(socket);
      if (watchers.size === 0) {
        this.watchers.delete(transactionId);
      }
    }
  }

  /**
   * Notifica todos os watchers que o pagamento foi confirmado
   */
  public notifyPaymentConfirmed(transactionId: string, payload: any): void {
    const watchers = this.watchers.get(transactionId);
    if (!watchers) return;

    const message = JSON.stringify({
      type: 'PAYMENT_CONFIRMED',
      payload: {
        transactionId,
        amount: payload.amount,
        status: 'PAID'
      }
    });

    log('info', `Notificando ${watchers.size} clientes sobre pagamento ${transactionId}`);

    watchers.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    });

    // Limpa os watchers pois a transação foi finalizada
    this.watchers.delete(transactionId);
  }
}
