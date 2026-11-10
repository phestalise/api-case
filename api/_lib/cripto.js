// api/_lib/cripto.js
// AES-256-GCM com a chave da variável DADOS_ENC_KEY (32 bytes em base64).
// Formato salvo: "<iv b64>:<authTag b64>:<ciphertext b64>"
// (pastas/arquivos com "_" não viram rota no Vercel)
const crypto = require("crypto");

const ALGORITMO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let chaveCache;

function obterChave() {
  if (chaveCache) return chaveCache;
  const b64 = process.env.DADOS_ENC_KEY;
  if (!b64) {
    throw new Error("Variável DADOS_ENC_KEY não configurada.");
  }
  const chave = Buffer.from(b64, "base64");
  if (chave.length !== 32) {
    throw new Error("DADOS_ENC_KEY inválida: precisa ter 32 bytes em base64.");
  }
  chaveCache = chave;
  return chave;
}

function criptografar(texto) {
  const chave = obterChave();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv, { authTagLength: TAG_BYTES });
  const cifrado = Buffer.concat([cipher.update(String(texto), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${cifrado.toString("base64")}`;
}

function descriptografar(valor) {
  const chave = obterChave();
  const partes = String(valor || "").split(":");
  if (partes.length !== 3) {
    throw new Error("Valor criptografado em formato inválido.");
  }
  const [ivB64, tagB64, dadosB64] = partes;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Valor criptografado em formato inválido.");
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITMO, chave, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(dadosB64, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("Falha ao descriptografar: chave errada ou dado corrompido.");
  }
}

module.exports = { criptografar, descriptografar };
