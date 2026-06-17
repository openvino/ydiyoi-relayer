# YDIYOI Relayer

Servicio propio para minteo gasless de los NFTs YDIYOI. **Reemplaza el OpenZeppelin Defender** (Autotask + Relayer), que se apaga el 1 de julio de 2026.

**Stack:** Node.js · Express · ethers v6 · JWT (HS256) · helmet · express-rate-limit.

Forma parte del ecosistema YDIYOI / nft.openvino.org junto con el frontend (`openvinoapp_v2`), el backend (`ydiyoi-api`) y el contrato (`gasless_ydiyoi_contract`).

## Cómo funciona

El frontend (usuario autenticado) envía `POST /mint { to, uri, experienceId }`. El relayer:
1. Valida el JWT (HS256, emitido por `ydiyoi-api`).
2. Si `API_URL` está seteado, consulta `GET /experiences/{experienceId}` y valida que la experiencia **sea del usuario**, **no esté ya minteada** (`nftGenerated`) y que el **`uri` coincida** con el `ipfsUrl` guardado.
3. La wallet del relayer ejecuta `safeMint(to, uri)` pagando el gas y **espera 1 confirmación** (solo responde `success` si la tx se minó OK).

El NFT queda en la wallet del usuario (`to`). No usa el MinimalForwarder ni firmas EIP-712: `safeMint` es público, así que el relayer mintea directo y la autorización es 100% server-side.

## Setup

```bash
cd ydiyoi-relayer
npm install
cp .env.example .env   # completá los valores (ver abajo)
npm start
```

### Variables (.env)

| Variable | Qué es |
|---|---|
| `NODE_ENV` | `production` exige `JWT_SECRET` (sin él no arranca) |
| `PORT` | Puerto del servicio (default 4001) |
| `RPC_URL` | RPC de la red (Base Sepolia / Optimism) |
| `RELAYER_PRIVATE_KEY` | **Hot wallet** que paga el gas. Mantené saldo acotado. Nunca commitear. |
| `CONTRACT_ADDRESS` | Dirección del NFT YDIYOI (`Registry` en deploy.json) |
| `JWT_SECRET` | Mismo secreto que `ydiyoi-api` (keys.ts). Si falta, NO valida auth. |
| `API_URL` | Base de `ydiyoi-api` para validar la experiencia. Si falta, NO valida negocio. |
| `ALLOWED_ORIGIN` | Orígenes CORS permitidos (coma-separado) |
| `TRUST_PROXY` | `1` si corre detrás de reverse proxy (para IP real del rate limit) |
| `MINT_RATE_MAX` / `MINT_RATE_WINDOW_MS` | Rate limit de `/mint` (por usuario/IP) |
| `MAX_URI_LENGTH` | Tope de longitud del tokenURI |

## Endpoints

- `POST /mint` → `{ to, uri, experienceId }` (requiere `Authorization: Bearer <jwt>`). Responde `{ success, txHash }` tras 1 confirmación on-chain.
- `GET /health` → estado del relayer y **saldo de gas** de la wallet (monitorealo).

```bash
# Health
curl http://localhost:4001/health

# Mint
curl -X POST http://localhost:4001/mint \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"to":"0xUserWallet","uri":"ipfs://Qm...","experienceId":1}'
```

## Seguridad

Defensas implementadas (verificadas):

| Vector | Defensa |
|---|---|
| Mints infinitos / vaciar el gas | **Rate limit por usuario** (cae a IP) en `/mint` + limiter global anti-flood |
| Mintear experiencias ajenas o repetidas | **Validación contra `ydiyoi-api`**: la experiencia debe ser del usuario, no estar reclamada y el `uri` debe coincidir |
| Endpoint abierto | **JWT obligatorio** (HS256, algoritmo **fijado** → bloquea `alg:none`). En `NODE_ENV=production` **no arranca sin `JWT_SECRET`** |
| Gas-griefing con tokenURI gigante | Tope de longitud (`MAX_URI_LENGTH`); el valor real se ata al `ipfsUrl` de la experiencia cuando `API_URL` está activo |
| Estado falso (tx revertida) | Espera **1 confirmación**; solo responde `success` si la tx se minó OK |
| Recon / fingerprinting (Burp/Caido) | `helmet` (headers), `x-powered-by` desactivado, **errores genéricos** al cliente (detalles solo en logs del server) |
| DoS por payload | `express.json` limitado a 1kb; JSON malformado → 400; inputs validados (`to` ≠ 0x0) |
| Colisión de nonce | El envío de tx se serializa en cola (una a la vez) |
| Caída silenciosa | Handlers de `unhandledRejection`/`uncaughtException` + salida limpia para que el process manager reinicie |

> **CORS no es un control de seguridad acá**: solo afecta navegadores. Burp/Caido/curl lo ignoran. La protección real es JWT + rate limit + validación.

### Recomendaciones operativas (hacelas antes de prod)

1. **Hot wallet con saldo ACOTADO**: es el techo del daño si alguien abusa del mint. Recargá de a poco y monitoreá el balance con `/health` (alertá si baja).
2. **Secreto JWT fuerte**: cambiá `138asda8213` por uno aleatorio largo, **el mismo en `ydiyoi-api` (keys.ts) y en este `.env`**. Generá: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. **HTTPS** por reverse proxy (nginx/traefik). Si lo usás, seteá `TRUST_PROXY=1` para que el rate limit tome la IP real.
4. **`.env` fuera del repo** (ya está en `.gitignore`), permisos restringidos, y nunca loguear secretos.
5. **Seteá `API_URL`** apuntando a `ydiyoi-api`: activa la validación de negocio (experiencia del usuario, no reclamada, uri coincide). Sin esto, un usuario autenticado podría pedir mints arbitrarios.
6. **Process manager** (pm2/systemd/docker) con auto-restart, e instalá con `npm ci` (lockfile) para builds reproducibles.
