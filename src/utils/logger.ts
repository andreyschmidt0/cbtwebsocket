// Em: src/utils/logger.ts (SUBSTITUA TUDO)

type LogLevel = 'info' | 'warn' | 'error' | 'debug'
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'development' ? 'debug' : 'info')

// Define a ordem de severidade
const severities: { [key in LogLevel]: number } = {
  'debug': 0,
  'info': 1,
  'warn': 2,
  'error': 3
}

const CURRENT_SEVERITY = severities[LOG_LEVEL as LogLevel] || 1

const colors = {
  info: '\x1b[36m', // Ciano
  warn: '\x1b[33m', // Amarelo
  error: '\x1b[31m', // Vermelho
  debug: '\x1b[35m', // Magenta
  reset: '\x1b[0m'
}

/**
 * Logger simples com cores e níveis
 */
export function log(level: LogLevel, message: string, data?: any): void {
  // Pula o log se o nível for menor que o configurado
  if (severities[level] < CURRENT_SEVERITY) {
    return
  }

  const timestamp = new Date().toISOString()
  const color = colors[level]
  const reset = colors.reset

  console.log(`${color}[${timestamp}] [${level.toUpperCase()}]${reset} ${message}`)

  // --- ESTA É A PARTE QUE FALTAVA ---
  if (data) {
    if (data instanceof Error) {
      // Se for um Erro, mostra a mensagem e o stack (pilha)
      console.error(`${color}  Error Message:${reset}`, data.message)
      if (process.env.NODE_ENV === 'development') {
        console.error(data.stack)
      }
    } else {
      // Se for um objeto, formata como JSON
      try {
        console.log(`${color}  Data:${reset}`, JSON.stringify(data, null, 2))
      } catch {
        console.log(`${color}  Data:${reset}`, data) // Fallback se não for JSON
      }
    }
  }
  // --- FIM DA CORREÇÃO ---
}