require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const { ethers } = require("ethers");

// ---- Config (todo desde .env) --------------------------------------------
const {
  PORT = "4001",
  NODE_ENV = "development",
  RPC_URL,
  RELAYER_PRIVATE_KEY,
  CONTRACT_ADDRESS,
  JWT_SECRET,
  API_URL,
  ALLOWED_ORIGIN, 
  TRUST_PROXY,
  MINT_RATE_MAX = "5",
  MINT_RATE_WINDOW_MS = "60000", 
  MAX_URI_LENGTH = "512",
} = process.env;

const isProd = NODE_ENV === "production";
const mintMax = Number(MINT_RATE_MAX) || 5;
const mintWindow = Number(MINT_RATE_WINDOW_MS) || 60000;
const maxUri = Number(MAX_URI_LENGTH) || 512;

// ---- Validación de configuración (falla temprano y claro) -----------------
if (!RPC_URL || !RELAYER_PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error(
    "Missing environment variables: RPC_URL, RELAYER_PRIVATE_KEY and CONTRACT_ADDRESS are required.",
  );
  process.exit(1);
}
// La private key debe ser 0x + 64 hex (32 bytes). Atrapa el placeholder "0x..." del .env.example.
if (!/^0x[0-9a-fA-F]{64}$/.test(RELAYER_PRIVATE_KEY)) {
  console.error(
    "Invalid RELAYER_PRIVATE_KEY: must be '0x' + 64 hex characters.\n" +
      "Looks like you left the .env.example placeholder — set the real private key of the relayer wallet.",
  );
  process.exit(1);
}
if (!ethers.isAddress(CONTRACT_ADDRESS)) {
  console.error(`Invalid CONTRACT_ADDRESS: '${CONTRACT_ADDRESS}' is not an address.`);
  process.exit(1);
}


if (isProd && !JWT_SECRET) {
  console.error(
    "JWT_SECRET is required in production (otherwise /mint is open and your gas gets drained).",
  );
  process.exit(1);
}
if (!JWT_SECRET) {
  console.warn(
    "[WARNING] JWT_SECRET is not set: the endpoint does NOT validate authentication (local testing only).",
  );
} else if (JWT_SECRET.length < 32) {
  console.warn(
    "[WARNING] JWT_SECRET is short/weak: use a random secret of >=32 chars (same as ydiyoi-api).",
  );
}
if (!API_URL) {
  console.warn(
    "[WARNING] API_URL is not set: the experience is NOT validated against ydiyoi-api " +
      "(any authenticated user could request mints). Set it in production.",
  );
} else if (isProd && !JWT_SECRET) {
  // (ya cubierto arriba) la validación de experiencia necesita el id del usuario del JWT
}

// ABI mínima: solo lo que usamos
const ABI = ["function safeMint(address to, string uri) public"];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

// ---- Cola para evitar colisiones de nonce ---------------------------------
// Serializa el ENVÍO de transacciones (una a la vez). La confirmación se espera fuera de la cola.
let txQueue = Promise.resolve();
function enqueue(task) {
  const run = txQueue.then(task, task);
  txQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- App ------------------------------------------------------------------
const app = express();
app.disable("x-powered-by"); // no revelar el stack
if (TRUST_PROXY) app.set("trust proxy", Number(TRUST_PROXY)); // IP real detrás de proxy (para rate limit)
app.use(helmet()); // headers de seguridad
app.use(express.json({ limit: "1kb" })); // payload chico: solo {to, uri, experienceId}

// CORS solo afecta navegadores (no frena Burp/curl). La seguridad real es auth + rate limit + validación.
app.use(
  cors({
    origin: ALLOWED_ORIGIN
      ? ALLOWED_ORIGIN.split(",").map((s) => s.trim())
      : true,
    methods: ["POST", "GET"],
  }),
);

// Rate limit global (anti-flood)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Rate limit de /mint: por usuario autenticado (cae a IP si no hay user)
const mintLimiter = rateLimit({
  windowMs: mintWindow,
  max: mintMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.user && req.user.id ? `u:${req.user.id}` : req.ip,
  message: { success: false, message: "Too many mint attempts, try again later." },
});

// Verifica el JWT emitido por ydiyoi-api (HS256, mismo secreto). Algoritmo fijado.
function requireAuth(req, res, next) {
  if (!JWT_SECRET) return next(); // sin secreto configurado (solo dev)
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Missing authentication token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// Valida contra ydiyoi-api que la experiencia exista, sea del usuario y no esté reclamada.
async function validateExperience(req, uri) {
  if (!API_URL) return; // sin backend configurado, no valida (dev/aislado)
  const { experienceId } = req.body || {};
  if (experienceId === undefined || experienceId === null || experienceId === "") {
    throw Object.assign(new Error("Missing experienceId"), { status: 400 });
  }
  let exp;
  try {
    const r = await fetch(`${API_URL}/experiences/${encodeURIComponent(experienceId)}`, {
      headers: { Authorization: req.headers.authorization || "" },
    });
    if (!r.ok) throw new Error(`backend responded ${r.status}`);
    exp = await r.json();
  } catch (e) {
    console.error("validateExperience: could not query ydiyoi-api:", e.message);
    throw Object.assign(new Error("Could not validate the experience"), { status: 502 });
  }
  if (String(exp.userId) !== String(req.user && req.user.id)) {
    throw Object.assign(new Error("The experience does not belong to the user"), { status: 403 });
  }
  if (exp.nftGenerated === true) {
    throw Object.assign(new Error("This experience has already been minted"), { status: 409 });
  }
  if (exp.ipfsUrl && uri !== exp.ipfsUrl) {
    throw Object.assign(new Error("The uri does not match the experience"), { status: 400 });
  }
}

app.get("/health", async (_req, res) => {
  try {
    const [balance, network] = await Promise.all([
      provider.getBalance(wallet.address),
      provider.getNetwork(),
    ]);
    res.json({
      ok: true,
      relayer: wallet.address,
      balance: ethers.formatEther(balance),
      chainId: Number(network.chainId),
      contract: CONTRACT_ADDRESS,
    });
  } catch (err) {
    console.error("Error in /health:", err.message);
    res.status(500).json({ ok: false, message: "Unavailable" });
  }
});

// Mint gasless: el relayer paga el gas y mintea al `to` indicado
app.post("/mint", requireAuth, mintLimiter, async (req, res) => {
  const { to, uri } = req.body || {};
  const userId = (req.user && req.user.id) || "-";

  if (!to || typeof to !== "string" || !ethers.isAddress(to) || to === ethers.ZeroAddress) {
    return res.status(400).json({ success: false, message: "Invalid 'to' parameter" });
  }
  if (!uri || typeof uri !== "string") {
    return res.status(400).json({ success: false, message: "Missing or empty 'uri' parameter" });
  }
  if (uri.length > maxUri) {
    return res.status(400).json({ success: false, message: `'uri' too long (max ${maxUri} chars)` });
  }

  // Validación de negocio contra ydiyoi-api (dueño + no reclamada + uri coincide)
  try {
    await validateExperience(req, uri);
  } catch (e) {
    console.warn(`Mint rejected (user=${userId} to=${to}): ${e.message}`);
    return res.status(e.status || 403).json({ success: false, message: e.message });
  }

  try {
    // El envío va en cola (orden de nonce); la confirmación se espera fuera de la cola.
    const tx = await enqueue(() => contract.safeMint(to, uri));
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error("The transaction reverted on-chain");
    }
    console.log(`Mint OK: tx=${tx.hash} user=${userId} to=${to} uri=${uri}`);
    return res.json({ success: true, txHash: tx.hash });
  } catch (err) {
    // Log detallado solo en el server; al cliente, mensaje genérico (no filtrar internals).
    console.error(
      `Mint error (user=${userId} to=${to}):`,
      err.reason || err.error?.message || err.message,
    );
    return res.status(502).json({ success: false, message: "Could not process the mint at this time." });
  }
});

// 404 y manejador de errores que no filtran stack traces
app.use((_req, res) => res.status(404).json({ message: "Not found" }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ message: "Invalid JSON" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Payload too large" });
  }
  console.error("Unhandled error:", err.message);
  res.status(500).json({ message: "Internal error" });
});

const server = app.listen(Number(PORT), () => {
  console.log(`YDIYOI relayer listening on :${PORT} (${NODE_ENV})`);
  console.log(`Relayer wallet: ${wallet.address}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Experience validation: ${API_URL ? "ON (" + API_URL + ")" : "OFF"}`);
});

// Resiliencia: que un glitch no mate el relayer en silencio.
server.on("error", (err) => {
  console.error("Server error (listen):", err.message);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err.message);
  process.exit(1); // salir para que el process manager (pm2/systemd) reinicie limpio
});
