import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const prefix = "enc:v1:";

export class AccountCookieSeal {
  private readonly key: Buffer;

  constructor(root: string, encryptedRowsExist: boolean, keyFile = "account-center-cookie.key") {
    const file = path.join(root, keyFile);
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!existing) {
      if (encryptedRowsExist) throw new Error("Account center cookie key is missing; encrypted sessions cannot be restored");
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(file, flags, 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeSync(fd, randomBytes(32).toString("base64"));
      } finally { fs.closeSync(fd); }
    } else if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Account center cookie key must be a regular file");
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Account center cookie key must be a regular file");
    const encoded = fs.readFileSync(file, "utf8").trim();
    this.key = Buffer.from(encoded, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== encoded) throw new Error("Invalid account center cookie key");
  }

  static isSealed(value: string): boolean { return value.startsWith(prefix); }

  seal(cookie: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(cookie, "utf8"), cipher.final()]);
    return prefix + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  open(value: string): string {
    if (!AccountCookieSeal.isSealed(value)) throw new Error("Cookie is not sealed");
    const payload = Buffer.from(value.slice(prefix.length), "base64url");
    if (payload.length < 29) throw new Error("Invalid sealed cookie");
    const decipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
  }
}
