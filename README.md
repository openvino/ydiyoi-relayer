# YDIYOI Relayer

Servicio propio para minteo gasless de los NFTs YDIYOI. Reemplaza el OpenZeppelin Defender (Autotask + Relayer).

**Stack:** Node.js · Express · ethers v6 · JWT (HS256).

## Cómo funciona

El frontend envía `POST /mint { to, uri, experienceId }` con el JWT del usuario. El relayer valida el token (y opcionalmente la experiencia contra `ydiyoi-api`), y una wallet con fondos ejecuta `safeMint(to, uri)` pagando el gas. El NFT queda en la wallet del usuario (`to`).

## Setup

```bash
cd ydiyoi-relayer
npm install
cp .env.example .env   # completá los valores
npm start              # o: npm run dev
```

### Variables (.env)

| Variable | Qué es |
|---|---|
| `PORT` | Puerto del servicio (default 4001) |
| `RPC_URL` | RPC de la red (ej. Base Sepolia / Optimism) |
| `RELAYER_PRIVATE_KEY` | Private key de la wallet que paga el gas |
| `CONTRACT_ADDRESS` | Dirección del NFT YDIYOI (`Registry` en deploy.json) |
| `JWT_SECRET` | Mismo secreto que `ydiyoi-api`. Si falta, no valida auth |
| `API_URL` | Base de `ydiyoi-api` para validar la experiencia. Si falta, no valida |
| `ALLOWED_ORIGIN` | Orígenes CORS permitidos (coma-separado) |
| `MINT_RATE_MAX` / `MINT_RATE_WINDOW_MS` | Rate limit de `/mint` |
| `MAX_URI_LENGTH` | Tope de longitud del tokenURI |

## Endpoints

- `POST /mint` → `{ to, uri, experienceId }` (header `Authorization: Bearer <jwt>`). Responde `{ success, txHash }`.
- `GET /health` → estado del relayer y saldo de gas de la wallet.

```bash
curl http://localhost:4001/health

curl -X POST http://localhost:4001/mint \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"to":"0xUserWallet","uri":"ipfs://Qm...","experienceId":1}'
```
