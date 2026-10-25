/**
 * Llaves de Wompi. Solo vienen de variables de entorno y nunca se registran en
 * los logs. El servicio no arranca si falta una, si WOMPI_ENV no es válido o si
 * las llaves no corresponden al ambiente: con WOMPI_ENV=sandbox se rechazan las
 * llaves de producción (pub_prod_, prv_prod_, prod_integrity_, prod_events_).
 */
export type WompiEnvironment = 'sandbox' | 'production';

export interface WompiConfig {
  environment: WompiEnvironment;
  /** URL base de la API (https://sandbox.wompi.co/v1 o https://production.wompi.co/v1). */
  apiUrl: string;
  publicKey: string;
  privateKey: string;
  integritySecret: string;
  eventsSecret: string;
}

const API_URLS: Record<WompiEnvironment, string> = {
  sandbox: 'https://sandbox.wompi.co/v1',
  production: 'https://production.wompi.co/v1',
};

// Prefijo esperado de cada llave según el ambiente.
const PREFIXES: Record<WompiEnvironment, Record<string, string>> = {
  sandbox: {
    WOMPI_PUBLIC_KEY: 'pub_test_',
    WOMPI_PRIVATE_KEY: 'prv_test_',
    WOMPI_INTEGRITY_SECRET: 'test_integrity_',
    WOMPI_EVENTS_SECRET: 'test_events_',
  },
  production: {
    WOMPI_PUBLIC_KEY: 'pub_prod_',
    WOMPI_PRIVATE_KEY: 'prv_prod_',
    WOMPI_INTEGRITY_SECRET: 'prod_integrity_',
    WOMPI_EVENTS_SECRET: 'prod_events_',
  },
};

const PRODUCTION_KEY = /^(pub_prod_|prv_prod_|prod_integrity_|prod_events_)/;

/** Lee y valida la configuración de Wompi. Los mensajes de error nunca incluyen el valor de una llave. */
export function readWompiConfig(env: Record<string, unknown>): WompiConfig {
  const read = (key: string) => (typeof env[key] === 'string' ? (env[key] as string).trim() : '');
  const errors: string[] = [];

  const environment = read('WOMPI_ENV') as WompiEnvironment;
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(
      'Configuración de Wompi inválida, el servicio no arranca:\n - WOMPI_ENV debe ser "sandbox" o "production".',
    );
  }

  for (const [key, prefix] of Object.entries(PREFIXES[environment])) {
    const value = read(key);
    if (!value) {
      errors.push(`${key} es obligatoria.`);
    } else if (environment === 'sandbox' && PRODUCTION_KEY.test(value)) {
      errors.push(`${key} es una llave de PRODUCCIÓN y WOMPI_ENV es sandbox.`);
    } else if (!value.startsWith(prefix)) {
      errors.push(`${key} debe empezar por ${prefix} con WOMPI_ENV=${environment}.`);
    } else if (value.length <= prefix.length + 8) {
      errors.push(`${key} está incompleta.`);
    }
  }
  if (errors.length) {
    throw new Error(`Configuración de Wompi inválida, el servicio no arranca:\n - ${errors.join('\n - ')}`);
  }

  return {
    environment,
    apiUrl: API_URLS[environment],
    publicKey: read('WOMPI_PUBLIC_KEY'),
    privateKey: read('WOMPI_PRIVATE_KEY'),
    integritySecret: read('WOMPI_INTEGRITY_SECRET'),
    eventsSecret: read('WOMPI_EVENTS_SECRET'),
  };
}
