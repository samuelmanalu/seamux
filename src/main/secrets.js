'use strict';

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

/**
 * Encrypted-at-rest JSON blob for anything credential-bearing.
 *
 * Electron's safeStorage keys this to the macOS Keychain, so the file is
 * useless to anyone who copies it off the disk without the login keychain.
 *
 * If encryption is unavailable we still work, but we write plaintext with 0600
 * and set `encrypted: false` so the UI can say so out loud. Silently degrading
 * to plaintext for a file full of production credentials is not acceptable --
 * the user has to be able to see which mode they are in.
 */
class SecretStore {
  constructor(file) {
    this.file = file;
    this.encrypted = false;
    this.data = { envSets: [] };
    this.load();
  }

  available() {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.file); } catch { return; }
    try {
      const envelope = JSON.parse(raw.toString('utf8'));
      if (envelope.encrypted) {
        const buf = Buffer.from(envelope.payload, 'base64');
        this.data = JSON.parse(safeStorage.decryptString(buf));
        this.encrypted = true;
      } else {
        this.data = envelope.payload;
        this.encrypted = false;
      }
    } catch (err) {
      // A corrupt or undecryptable store must not wipe itself on next save.
      this.loadError = String(err && err.message || err);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const json = JSON.stringify(this.data);
    let envelope;
    if (this.available()) {
      envelope = { encrypted: true, payload: safeStorage.encryptString(json).toString('base64') };
      this.encrypted = true;
    } else {
      envelope = { encrypted: false, payload: this.data };
      this.encrypted = false;
    }
    fs.writeFileSync(this.file, JSON.stringify(envelope), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
}

module.exports = { SecretStore };
