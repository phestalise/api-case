// api/usuario-dados.js
// POST /api/usuario-dados  (Authorization: Bearer <ID token>)  body: { cpf }
//   -> grava usuarios/{uid}.cpf_enc + cpf_final e remove o campo cpf em texto puro
// GET  /api/usuario-dados?uid=<uid>  (Authorization: Bearer <ID token>)
//   -> devolve o CPF descriptografado (do próprio usuário ou, se for admin, de qualquer um)
// GET  /api/usuario-dados?uids=a,b,c  (só admin, até 100 por chamada)
//   -> { cpfs: { uid: "12345678901" | null } }
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { criptografar, descriptografar } = require("./_lib/cripto");
const { aplicarRateLimit } = require("./_lib/ratelimit");

let db;

function iniciarFirebase() {
  if (db) return;
  if (!getApps().length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("Variável FIREBASE_SERVICE_ACCOUNT não configurada no Vercel.");
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  db = getFirestore();
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://cases-estalise.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!(await aplicarRateLimit(req, res, "usuario-dados", 20))) return;

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido." });
  }

  try {
    iniciarFirebase();
  } catch (err) {
    console.error("Erro ao inicializar Firebase Admin:", err.message);
    return res.status(500).json({ error: "Erro de configuração do servidor." });
  }

  let tokenUid;
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) {
      return res.status(401).json({ error: "Faça login para continuar." });
    }
    tokenUid = (await getAuth().verifyIdToken(token)).uid;
  } catch {
    return res.status(401).json({ error: "Sessão expirada. Faça login novamente." });
  }

  try {
    if (req.method === "POST") {
      return await salvarCpf(req, res, tokenUid);
    }
    return await lerCpf(req, res, tokenUid);
  } catch (err) {
    // Nunca loga o CPF nem o body: só a mensagem do erro.
    console.error("Erro em usuario-dados:", err.message);
    return res.status(500).json({ error: "Erro interno." });
  }
};

async function salvarCpf(req, res, uid) {
  const cpf = String((req.body || {}).cpf || "").replace(/\D/g, "");
  if (!validarCPF(cpf)) {
    return res.status(400).json({ error: "CPF inválido." });
  }

  await db.collection("usuarios").doc(uid).set({
    cpf_enc: criptografar(cpf),
    cpf_final: cpf.slice(-2),
    cpf: FieldValue.delete()
  }, { merge: true });

  return res.status(200).json({
    cpf_mascarado: `***.***.*${cpf.slice(7, 9)}-${cpf.slice(9, 11)}`
  });
}

const MAX_UIDS_LOTE = 100;

async function ehAdmin(uid) {
  const doc = await db.collection("usuarios").doc(uid).get();
  return doc.exists && doc.data().is_admin === true;
}

function cpfDoDoc(dados) {
  if (dados.cpf_enc) return descriptografar(dados.cpf_enc);
  // Cadastro antigo ainda não migrado (texto puro).
  if (dados.cpf) return String(dados.cpf).replace(/\D/g, "");
  return null;
}

async function lerCpf(req, res, tokenUid) {
  const query = req.query || {};

  // Lote (só admin): GET ?uids=a,b,c  -> { cpfs: { a: "...", b: null } }
  // Usado pela exportação de pedidos do painel.
  if (query.uids !== undefined) {
    const uids = [...new Set(String(query.uids).split(",").map((u) => u.trim()).filter(Boolean))];
    if (!uids.length || uids.length > MAX_UIDS_LOTE) {
      return res.status(400).json({ error: `Informe de 1 a ${MAX_UIDS_LOTE} uids.` });
    }
    if (!(await ehAdmin(tokenUid))) {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const docs = await db.getAll(...uids.map((u) => db.collection("usuarios").doc(u)));
    const cpfs = {};
    for (const doc of docs) {
      cpfs[doc.id] = doc.exists ? cpfDoDoc(doc.data()) : null;
    }
    return res.status(200).json({ cpfs });
  }

  const alvoUid = String(query.uid || tokenUid);

  if (alvoUid !== tokenUid && !(await ehAdmin(tokenUid))) {
    return res.status(403).json({ error: "Acesso negado." });
  }

  const alvoDoc = await db.collection("usuarios").doc(alvoUid).get();
  if (!alvoDoc.exists) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  return res.status(200).json({ cpf: cpfDoDoc(alvoDoc.data()) });
}

// Mesmo algoritmo do front (public/js/cpf.js).
function validarCPF(cpf) {
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digito = (base) => {
    let soma = 0;
    let peso = base.length + 1;
    for (const n of base) soma += Number(n) * peso--;
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const d1 = digito(cpf.slice(0, 9));
  const d2 = digito(cpf.slice(0, 9) + d1);
  return cpf === cpf.slice(0, 9) + d1 + d2;
}
