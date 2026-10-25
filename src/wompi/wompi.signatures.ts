import { createHash, timingSafeEqual } from 'crypto';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Firma de integridad del widget: SHA256 de
 * "<referencia><montoEnCentavos><moneda>[<vencimiento>]<secretoDeIntegridad>".
 * Se calcula solo en el servidor: así nadie puede cambiar el monto en el navegador.
 */
export function integritySignature(params: {
  reference: string;
  amountInCents: number;
  currency: string;
  expirationTime?: string;
  integritySecret: string;
}): string {
  return sha256(
    `${params.reference}${params.amountInCents}${params.currency}${params.expirationTime ?? ''}${params.integritySecret}`,
  );
}

export interface WompiEvent {
  event?: string;
  data?: Record<string, any>;
  environment?: string;
  signature?: { properties?: unknown; checksum?: unknown };
  timestamp?: unknown;
  sent_at?: string;
}

// Solo propiedades de la transacción, con nombres simples (p. ej. "transaction.amount_in_cents").
const PROPERTY = /^transaction\.[a-z_]+(\.[a-z_]+)*$/;
const CHECKSUM = /^[0-9a-f]{64}$/;

/**
 * Verifica la firma de un evento de Wompi: SHA256 de los valores de
 * signature.properties (en orden, tomados de data), seguidos del timestamp y del
 * secreto de eventos. Se compara en tiempo constante con el checksum del
 * encabezado X-Event-Checksum (o, si no viene, con el del cuerpo).
 */
export function isValidEventSignature(
  event: WompiEvent,
  headerChecksum: string | undefined,
  eventsSecret: string,
): boolean {
  const properties = event?.signature?.properties;
  const timestamp = event?.timestamp;
  const bodyChecksum = typeof event?.signature?.checksum === 'string' ? event.signature.checksum : '';
  const checksum = (headerChecksum || bodyChecksum).trim().toLowerCase();
  if (!Array.isArray(properties) || !properties.length || !CHECKSUM.test(checksum)) return false;
  if (typeof timestamp !== 'number' && !(typeof timestamp === 'string' && /^\d+$/.test(timestamp))) return false;

  let concatenated = '';
  for (const property of properties) {
    if (typeof property !== 'string' || !PROPERTY.test(property)) return false;
    const value = property.split('.').reduce<any>((node, key) => (node == null ? undefined : node[key]), event.data);
    if (value === undefined || value === null || typeof value === 'object') return false;
    concatenated += String(value);
  }
  const expected = Buffer.from(sha256(`${concatenated}${timestamp}${eventsSecret}`));
  const received = Buffer.from(checksum);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * UUID v5 (RFC 4122), determinístico: el mismo id de transacción de Wompi produce
 * siempre la misma clave de idempotencia para el ledger.
 */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
