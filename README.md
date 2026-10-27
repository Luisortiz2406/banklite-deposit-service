# Deposit Service (`deposit-service`)

[![Despliegue](https://github.com/Luisortiz2406/banklite-deposit-service/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/Luisortiz2406/banklite-deposit-service/actions/workflows/deploy.yml)

Recargas de saldo (*cash-in*) a la cuenta BankLite con la pasarela **Wompi** en modo
**sandbox**: tarjeta, PSE y Nequi. En sandbox no se mueve dinero real y así se dice en la
interfaz.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Es el único servicio que habla con Wompi y el único que conoce sus llaves. Crea la
recarga, recibe los eventos de Wompi y, cuando un pago queda aprobado, pide el abono
a ledger-service, que sigue siendo la única fuente de verdad del dinero.

**Flujo**

1. `POST /deposits`: el cliente elige cuenta y monto. El servicio valida el rango, que la
   cuenta sea suya, que esté activa y que sea en COP. Luego crea la recarga `PENDING` con
   una referencia única (`BL-<uuid>`), un vencimiento de 30 minutos y la **firma de
   integridad**: SHA256 de referencia, centavos, moneda, vencimiento y secreto de integridad.
2. El frontend abre el widget de Wompi con esos datos. El callback del widget solo dispara
   `POST /deposits/:id/sync`, que consulta a Wompi; el navegador nunca decide el estado.
3. Wompi manda `transaction.updated` a `POST /deposits/wompi/events`, la ruta pública del
   gateway, sin JWT. El servicio:
   - verifica la firma: SHA256 de los valores de `signature.properties`, el `timestamp` y
     el secreto de eventos, comparado en tiempo constante. Si no coincide, responde 401;
   - descarta los eventos de otro ambiente (con sandbox solo acepta `environment: test`);
   - **consulta la transacción a la API de Wompi** (`GET /v1/transactions/:id`, con la llave
     privada) y usa esa respuesta, no el cuerpo del evento;
   - exige que la referencia sea de una recarga y que el monto y la moneda coincidan. Si no
     coinciden, la recarga queda `AMOUNT_MISMATCH` y no se abona.
4. Según el estado en Wompi:
   - `APPROVED`: abono en el ledger (`POST /ledger/internal/cash-ins`) contra la cuenta de
     sistema **Compensación Wompi**. La clave de idempotencia es un UUID v5 del id de la
     transacción de Wompi, así que un webhook repetido no abona dos veces;
   - `DECLINED`, `VOIDED` o `ERROR`: la recarga queda en ese estado y no se abona nada.
5. **Proceso de pendientes** (cada 5 min): revisa en Wompi, por referencia, las recargas
   `PENDING` de más de 10 minutos. Cubre los webhooks que no llegaron y los abonos que el
   ledger no confirmó.
   - Si una hora después del vencimiento no hay ninguna transacción, la recarga queda `EXPIRED`.
   - Es el único lugar donde se reintenta hablar con Wompi.

**Estados de una recarga**: `PENDING`, `APPROVED` (abonada), `DECLINED`, `VOIDED`, `ERROR`,
`EXPIRED`, `AMOUNT_MISMATCH` y `REVIEW`. `REVIEW` requiere revisión manual: Wompi anuló una
recarga ya abonada o el ledger rechazó el abono.

**Robustez**

- Wompi se consulta con un tiempo máximo de 5 s y sin reintentos en línea.
- Si Wompi o el ledger no responden durante el webhook, el servicio contesta 503, la
  recarga sigue `PENDING` y Wompi reenvía el evento (a los 30 min, 3 h y 24 h).
- Los logs nunca llevan el cuerpo de los eventos ni ninguna llave; solo ids y estados.
- El cuerpo de las peticiones está limitado a 64 KB.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | — (el ledger publica `transaction.completed` con `direction: 'in'` al abonar: lo reciben fraud, compliance, notification y rewards) |
| Consume eventos | — |
| Llama a | account-service: la cuenta del cliente (con el token del cliente)<br>ledger-service: `POST /ledger/internal/cash-ins` (clave interna `deposit`) |
| Lo llaman | api-gateway (rutas `/deposits/*`)<br>account-service: resumen para cancelar la cuenta (`/internal/deposits/...`) |
| Integraciones externas | **Wompi** (sandbox): widget de pago, eventos (webhook) y API de transacciones |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/deposits`), aplica CORS y límite de peticiones, y bloquea las
rutas internas. La ruta del webhook tiene en el gateway su propio límite de
peticiones por minuto y de tamaño del cuerpo.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`deposit_db`)

| Tabla | Contenido |
|---|---|
| `deposits` | Recargas: referencia (única), cliente, cuenta, monto, estado, transacción de Wompi (única), medio de pago y transacción del ledger. |

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16.

```bash
npm ci
cp .env.example .env     # completa los secretos y las llaves de sandbox de Wompi
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

El sistema completo se levanta desde el repositorio de integración con
`docker compose up -d --build`. Comprobar: `curl http://localhost:3014/health`

## Endpoints

A través del gateway las rutas son las mismas (`http://localhost:8080/deposits/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base. |
| POST | `/deposits/wompi/events` | Webhook de eventos de Wompi. Autenticado por la firma del evento: 401 si es inválida, 503 si hay que reintentar y 200 en los demás casos. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/deposits/config` | Monto mínimo y máximo, moneda y ambiente de Wompi. |
| GET | `/deposits` | Últimas 20 recargas. |
| POST | `/deposits` | `{accountId, amount}`: crea la recarga y devuelve `checkout` (llave pública, centavos, referencia, vencimiento y firma de integridad) para el widget. |
| GET | `/deposits/:id` | Una recarga. |
| POST | `/deposits/:id/sync` | `{transactionId?}`: consulta la recarga en Wompi sin esperar el webhook. |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/internal/deposits/users/:idUser/resumen-cierre` | Solo **account-service** («Cancelar mi cuenta»): `recargasPendientes` (con pago iniciado, o sin pago y vencidas hace menos de 1 h, el mismo margen del proceso de pendientes) y `recargasEnRevision`, con `sinPendientes`. |

## Variables de entorno

| Variable | Obligatoria | Ejemplo / por defecto | Descripción |
|---|---|---|---|
| `DATABASE_URL` | **Sí** | `postgres://deposit_svc:<clave>@localhost:5432/deposit_db` | Base propia (la crea `scripts/ensure-db.js`). |
| `JWT_SECRET` | **Sí** | — | El mismo de auth-service. |
| `INTERNAL_API_KEY` | **Sí** | — | Clave interna **propia**. ledger-service la acepta como `deposit:<clave>`. |
| `INTERNAL_TRUSTED_KEYS` | Para el resumen de cierre | `account:<clave-de-account>` | Quién puede pedir `/internal/deposits/...` (solo `account`). Sin ella se rechaza todo. |
| `ACCOUNT_SERVICE_URL` | No | `http://localhost:3002` | |
| `LEDGER_SERVICE_URL` | No | `http://localhost:3006` | |
| `WOMPI_ENV` | **Sí** | `sandbox` | `sandbox` o `production`. Define la API (`sandbox.wompi.co` / `production.wompi.co`). |
| `WOMPI_PUBLIC_KEY` | **Sí** | `pub_test_…` | Llave pública (va al widget). |
| `WOMPI_PRIVATE_KEY` | **Sí** | `prv_test_…` | Llave privada: consultar transacciones. Solo en el servidor. |
| `WOMPI_INTEGRITY_SECRET` | **Sí** | `test_integrity_…` | Firma de integridad del widget. |
| `WOMPI_EVENTS_SECRET` | **Sí** | `test_events_…` | Verificación de la firma de los eventos. |
| `DEPOSIT_MIN_AMOUNT` / `DEPOSIT_MAX_AMOUNT` | No | `10000` / `2000000` | Rango de una recarga, en pesos. |
| `PENDING_CHECK_INTERVAL_MS` | No | `300000` | Cada cuánto corre el proceso de pendientes (mínimo 30 s). |
| `PENDING_CHECK_ENABLED` | No | `true` | `false` lo apaga. |

El servicio **no arranca** si:
- falta un secreto o una llave;
- `WOMPI_ENV` no es válido;
- con `WOMPI_ENV=sandbox`, alguna llave es de producción (`pub_prod_`, `prv_prod_`,
  `prod_integrity_`, `prod_events_`);
- con `WOMPI_ENV=production`, hay llaves de prueba.

Los mensajes de error nunca muestran el valor de una llave.

### Configurar Wompi (sandbox)

En el panel de Wompi, en modo **sandbox**, ve a *Desarrolladores › Eventos* y registra
como URL de eventos:

```
https://api-gateway-production-dd7f.up.railway.app/deposits/wompi/events
```

Datos de prueba de Wompi:

| Medio | Aprobada | Rechazada |
|---|---|---|
| Tarjeta | `4242 4242 4242 4242` | `4111 1111 1111 1111` |
| Nequi | `3991111111` | `3992222222` |
| PSE | «Banco que aprueba» | «Banco que rechaza» |

Con cualquier otra tarjeta o número, la transacción queda en `ERROR`.

## Pruebas

```bash
npm test   # TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres para las de base
```

- Firma de eventos válida e inválida.
- Webhook duplicado y webhooks simultáneos: un solo abono.
- Recargas aprobada, rechazada, anulada, con error y con monto alterado.
- El estado sale de la API de Wompi y no del cuerpo del evento.
- Eventos de otro ambiente o de referencias ajenas.
- Wompi o el ledger caídos, y el reintento con la misma clave.
- Proceso de pendientes y expiración.
- Arranque con llaves de producción en sandbox.

## Despliegue

Lo despliega **GitHub Actions** (`.github/workflows/deploy.yml`, que usa el workflow
reutilizable de [banklite-pipelines](https://github.com/Luisortiz2406/banklite-pipelines)):

1. **test**: lint, formato, build y pruebas con Postgres (también en cada pull request).
2. **docker** (solo `main`): imagen en GHCR `ghcr.io/luisortiz2406/banklite-deposit-service`,
   etiquetada con el SHA del commit y `latest` (se guardan las últimas 5).
3. **deploy** (solo `main`): `railway up --ci` sube el commit a Railway, que lo
   construye con el `Dockerfile` y aplica `railway.json` (health check en `/health`);
   el job espera a que el despliegue quede activo.

El repositorio está desconectado del autodeploy de Railway: un push a `main` despliega
solo a través de este pipeline, y únicamente si las pruebas pasan. Rollback: panel de
Railway → *Deployments* → versión anterior → *Rollback*.

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta `/deposits/*` (incluido el webhook de Wompi) |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Llama a:** valida que la cuenta sea del cliente (con su token) |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Llama a:** abono de la recarga (`POST /ledger/internal/cash-ins`) |
| [banklite-frontend](https://github.com/Luisortiz2406/banklite-frontend) | **Lo llama:** botón «Recargar saldo» y widget de Wompi |
