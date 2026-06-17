// Prueba rápida del relayer sin frontend.
// Uso:
//   node test-mint.js <to> <uri>
// Variables opcionales:
//   RELAYER_URL  (default http://localhost:4001/mint)
//   TEST_JWT     token Bearer a enviar (si el relayer exige auth)
//
// Ejemplo:
//   node test-mint.js 0xTuWalletDePrueba ipfs://QmTest

const url = process.env.RELAYER_URL || "http://localhost:4001/mint";
const to = process.argv[2];
const uri = process.argv[3] || "ipfs://QmTestMetadata";

if (!to) {
  console.error("Falta el argumento <to> (address que recibe el NFT).");
  process.exit(1);
}

const headers = { "Content-Type": "application/json" };
if (process.env.TEST_JWT) headers.Authorization = `Bearer ${process.env.TEST_JWT}`;

(async () => {
  console.log(`POST ${url}  ->  { to: ${to}, uri: ${uri} }`);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ to, uri }),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}`, data);
  process.exit(res.ok && data.success ? 0 : 1);
})();
