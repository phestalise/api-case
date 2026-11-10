// scripts/migrar-cpf.js
// Criptografa o CPF em texto puro de todos os usuarios/{uid}.
//
// Uso (FIREBASE_SERVICE_ACCOUNT e DADOS_ENC_KEY no ambiente):
//   node scripts/migrar-cpf.js --dry-run   -> só conta quantos seriam migrados
//   node scripts/migrar-cpf.js             -> migra de verdade
//
// Nunca imprime CPF (nem parcial): só uids e contagens.
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { criptografar, descriptografar } = require("../api/_lib/cripto");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Defina FIREBASE_SERVICE_ACCOUNT no ambiente.");
  }
  // Falha cedo se a chave estiver ausente/errada (testa ida e volta).
  if (descriptografar(criptografar("teste")) !== "teste") {
    throw new Error("DADOS_ENC_KEY não passou no teste de ida e volta.");
  }

  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();

  const snap = await db.collection("usuarios").get();
  const pendentes = snap.docs.filter((d) => {
    const cpf = d.data().cpf;
    return cpf !== undefined && cpf !== null && String(cpf).trim() !== "";
  });

  console.log(`Usuários no total: ${snap.size}`);
  console.log(`Com CPF em texto puro: ${pendentes.length}`);

  if (DRY_RUN) {
    console.log("--dry-run: nada foi alterado.");
    return;
  }

  let migrados = 0;
  let invalidos = 0;
  let batch = db.batch();
  let noBatch = 0;

  for (const doc of pendentes) {
    const digitos = String(doc.data().cpf).replace(/\D/g, "");
    if (digitos.length !== 11) {
      // Não mexe: precisa de correção manual. Só o uid é exibido.
      console.warn(`Ignorado (CPF não tem 11 dígitos): ${doc.id}`);
      invalidos++;
      continue;
    }

    batch.update(doc.ref, {
      cpf_enc: criptografar(digitos),
      cpf_final: digitos.slice(-2),
      cpf: FieldValue.delete()
    });
    noBatch++;
    migrados++;

    if (noBatch === 400) {
      await batch.commit();
      batch = db.batch();
      noBatch = 0;
    }
  }

  if (noBatch > 0) await batch.commit();

  console.log(`Migrados: ${migrados}`);
  if (invalidos) console.log(`Ignorados por formato inválido: ${invalidos}`);
}

main().catch((err) => {
  console.error("Erro na migração:", err.message);
  process.exit(1);
});
