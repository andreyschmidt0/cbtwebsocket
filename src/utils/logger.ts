type LogLevel = 'info' | 'warn' | 'error' | 'debug'
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'development' ? 'debug' : 'info')

// Define a ordem de severidade
const severities: { [key in LogLevel]: number } = {
  'debug': 0,
  'info': 1,
  'warn': 2,
  'error': 3
}

const colors = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[35m',
  reset: '\x1b[0m'
}

const CURRENT_SEVERITY = severities[LOG_LEVEL as LogLevel] || 1

export function log(level: LogLevel, message: string, data?: any): void {
  // Pula o log se o nível for menor que o configurado
  if (severities[level] < CURRENT_SEVERITY) {
    return
  }

  const timestamp = new Date().toISOString()
  const color = colors[level]
  const reset = colors.reset

  console.log(`${color}[${timestamp}] [${level.toUpperCase()}]${reset} ${message}`)

  if (data) {
    // ... (resto da sua lógica de log de dados) ...
  }
}