/**
 * crypto.js — End-to-End Encryption helpers (TweetNaCl box)
 *
 * Per-room ephemeral X25519 key-pairs for forward secrecy.
 * Each room gets its own key-pair generated fresh on join.
 * Per-room peer-key maps isolate peers per room.
 * The server only ever sees ciphertext + nonce (base64-encoded).
 */

const E2E = (() => {
  // roomId -> { publicKey: Uint8Array, secretKey: Uint8Array }
  const roomKeyPairs = {};

  // roomId -> { socketId -> Uint8Array publicKey }
  const roomPeerKeys = {};

  /**
   * Generate (or return cached) key pair for a specific room.
   * Returns the public key as a base64 string.
   */
  function generateKeyPairForRoom(roomId) {
    if (!roomKeyPairs[roomId]) roomKeyPairs[roomId] = nacl.box.keyPair();
    return nacl.util.encodeBase64(roomKeyPairs[roomId].publicKey);
  }

  function initRoom(roomId) {
    if (!roomPeerKeys[roomId]) roomPeerKeys[roomId] = {};
  }

  function destroyRoom(roomId) {
    delete roomPeerKeys[roomId];
    delete roomKeyPairs[roomId];
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
    const myKP = roomKeyPairs[roomId];
    if (!myKP) throw new Error('No key pair for room ' + roomId);
    const map = roomPeerKeys[roomId];
    if (!map || !map[socketId]) throw new Error('No public key for ' + socketId + ' in room ' + roomId);
    const nonce     = nacl.randomBytes(nacl.box.nonceLength);
    const msgUint8  = nacl.util.decodeUTF8(plaintext);
    const encrypted = nacl.box(msgUint8, nonce, map[socketId], myKP.secretKey);
    return {
      encryptedMessage: nacl.util.encodeBase64(encrypted),
      nonce:            nacl.util.encodeBase64(nonce)
    };
  }

  function decryptInRoom(roomId, encryptedMessageB64, nonceB64, fromSocketId) {
    const myKP = roomKeyPairs[roomId];
    if (!myKP) return null;
    const map = roomPeerKeys[roomId];
    if (!map || !map[fromSocketId]) return null;
    try {
      const ct        = nacl.util.decodeBase64(encryptedMessageB64);
      const nonce     = nacl.util.decodeBase64(nonceB64);
      const decrypted = nacl.box.open(ct, nonce, map[fromSocketId], myKP.secretKey);
      if (!decrypted) return null;
      return nacl.util.encodeUTF8(decrypted);
    } catch {
      return null;
    }
  }

  return {
    generateKeyPairForRoom,
    initRoom,
    destroyRoom,
    addPeerKeyForRoom,
    removePeerKeyForRoom,
    getAllPeerIdsForRoom,
    encryptForInRoom,
    decryptInRoom
  };
})();
