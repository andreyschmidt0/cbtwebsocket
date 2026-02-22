import { DateTime } from 'luxon';

// Retorna string formatada para gravar no banco como horário local de Brasília (UTC-3)
export function toBrasiliaForDb(dateInput?: string | Date): string {
  let dt: DateTime;
  if (!dateInput) {
    dt = DateTime.utc();
  } else if (typeof dateInput === 'string') {
    dt = DateTime.fromISO(dateInput, { zone: 'utc' });
  } else {
    dt = DateTime.fromJSDate(dateInput, { zone: 'utc' });
  }

  return dt.setZone('America/Sao_Paulo').toFormat('yyyy-LL-dd HH:mm:ss');
}

export function toBrasiliaISOWithOffset(dateInput?: string | Date): string {
  let dt: DateTime;
  if (!dateInput) {
    dt = DateTime.utc();
  } else if (typeof dateInput === 'string') {
    dt = DateTime.fromISO(dateInput, { zone: 'utc' });
  } else {
    dt = DateTime.fromJSDate(dateInput, { zone: 'utc' });
  }
  return dt.setZone('America/Sao_Paulo').toISO({ suppressMilliseconds: true, includeOffset: true });
}

