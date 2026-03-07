/**
 * crypto.js — End-to-End Encryption helpers (TweetNaCl box)
 *
 * One ephemeral X25519 key-pair per session (shared across all rooms).
 * Per-room peer-key maps isolate which peers belong to which room.
 * The server only ever sees ciphertext + nonce (base64-encoded).
 */

const E2E = (() => {
  let myKeyPair = null; // { publicKey: Uint8Array, secretKey: Uint8Array }

  // roomId -> { socketId -> Uint8Array publicKey }
  const roomPeerKeys = {};

  /**
   * Generate (or return existing) key pair.
   * Returns the public key as a base64 string.
   */
  function generateKeyPair() {
    if (!myKeyPair) myKeyPair = nacl.box.keyPair();
    return nacl.util.encodeBase64(myKeyPair.publicKey);
  }

  /** Alias used by multi-room join flow. */
  function generateKeyPairForRoom(roomId) {
    return generateKeyPair();
  }

  function initRoom(roomId) {
    if (!roomPeerKeys[roomId]) roomPeerKeys[roomId] = {};
  }

  function destroyRoom(roomId) {
    delete roomPeerKeys[roomId];
  }

  function addPeerKeyForRoom(roomId, socketId, publicKeyB64) {
    if (!roomPeerKeys[roomId]) roomPeerKeys[roomId] = {};
    roomPeerKeys[roomId][socketId] = nacl.util.decodeBase64(publicKeyB64);
  }

  function removePeerKeyForRoom(roomId, socketId) {
    if (roomPeerKeys[roomId]) delete roomPeerKeys[roomId][socketId];
  }

  function getAllPeerIdsForRoom(roomId) {
    return roomPeerKeys[roomId] ? Object.keys(roomPeerKeys[roomId]) : [];
  }

  function encryptForInRoom(roomId, socketId, plaintext) {
    const map = roomPeerKeys[roomId];
    if (!map || !map[socketId]) throw new Error('No public key for ' + socketId + ' in room ' + roomId);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const msgUint8 = nacl.util.decodeUTF8(plaintext);
    const encrypted = nacl.box(msgUint8, nonce, map[socketId], myKeyPair.secretKey);
    return {
      encryptedMessage: nacl.util.encodeBase64(encrypted),
      nonce: nacl.util.encodeBase64(nonce)
    };
  }

  function decryptInRoom(roomId, encryptedMessageB64, nonceB64, fromSocketId) {
    const map = roomPeerKeys[roomId];
    if (!map || !map[fromSocketId]) return null;
    try {
      const ct       = nacl.util.decodeBase64(encryptedMessageB64);
      const nonce    = nacl.util.decodeBase64(nonceB64);
      const decrypted = nacl.box.open(ct, nonce, map[fromSocketId], myKeyPair.secretKey);
      if (!decrypted) return null;
      return nacl.util.encodeUTF8(decrypted);
    } catch {
      return null;
    }
  }

  function getMyPublicKeyB64() {
    return myKeyPair ? nacl.util.encodeBase64(myKeyPair.publicKey) : null;
  }

  return {
    generateKeyPair,
    generateKeyPairForRoom,
    initRoom,
    destroyRoom,
    addPeerKeyForRoom,
    removePeerKeyForRoom,
    getAllPeerIdsForRoom,
    encryptForInRoom,
    decryptInRoom,
    getMyPublicKeyB64
  };
})();
