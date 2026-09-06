const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const MAX_BUNDLE_BYTES = 1024 * 1024;
const AAD = Buffer.from("CodexAuth portable credentials v1");

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 10 || password.length > 1024) {
    throw new Error("迁移密码须为 10～1024 个字符。");
  }
}

async function deriveKey(password, salt) {
  validatePassword(password);
  return scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function decodeField(value, size) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("迁移文件格式无效。");
  const bytes = Buffer.from(value, "base64");
  if ((size && bytes.length !== size) || bytes.toString("base64") !== value) throw new Error("迁移文件格式无效。");
  return bytes;
}

function validatePayload(payload) {
  if (!payload || typeof payload.auth !== "string" || !payload.auth.length || Buffer.byteLength(payload.auth) > 256 * 1024 ||
      typeof payload.displayName !== "string" || payload.displayName.length > 200) throw new Error("迁移文件中的账号数据无效。");
  return { auth: payload.auth, displayName: payload.displayName };
}

async function encryptPortableCredentials(payload, password) {
  const data = validatePayload(payload);
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = await deriveKey(password, salt);
  const plain = Buffer.from(JSON.stringify(data));
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({ format: "codexauth-portable", version: 1, kdf: "scrypt", cipher: "aes-256-gcm",
      salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64") }) + "\n";
  } finally { key.fill(0); plain.fill(0); }
}

async function decryptPortableCredentials(content, password) {
  validatePassword(password);
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BUNDLE_BYTES) throw new Error("迁移文件过大或格式无效。");
  let envelope;
  try { envelope = JSON.parse(content); } catch { throw new Error("不是有效的 CodexAuth 迁移文件。"); }
  if (envelope?.format !== "codexauth-portable" || envelope.version !== 1 || envelope.kdf !== "scrypt" || envelope.cipher !== "aes-256-gcm") {
    throw new Error("不支持此迁移文件格式或版本。");
  }
  const salt = decodeField(envelope.salt, 16), iv = decodeField(envelope.iv, 12), tag = decodeField(envelope.tag, 16);
  const ciphertext = decodeField(envelope.ciphertext);
  const key = await deriveKey(password, salt);
  let plain;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validatePayload(JSON.parse(plain.toString("utf8")));
  } catch { throw new Error("密码错误或迁移文件已损坏，未导入任何账号。"); }
  finally { key.fill(0); plain?.fill(0); }
}

module.exports = { encryptPortableCredentials, decryptPortableCredentials, validatePassword, MAX_BUNDLE_BYTES };
