'use strict';
/*
 * Encrypted content coding
 *
 * === Note about versions ===
 *
 * This code supports multiple versions of the draft.  This is selected using
 * the |version| parameter.
 *
 * aes128gcm: The most recent version, the salt, record size and key identifier
 *    are included in a header that is part of the encrypted content coding.
 *
 * aesgcm: The version that is widely deployed with WebPush (as of 2016-11).
 *    This version is selected by default, unless you specify a |padSize| of 1.
 *
 * aesgcm128: This version is old and will be removed in an upcoming release.
 *     This version is selected by providing a |padSize| parameter of 1.
 */

var crypto = require('crypto');
var base64 = require('urlsafe-base64');

var saved = {
  keymap: {},
  keylabels: {}
};
var AES_GCM = 'aes-128-gcm';
var PAD_SIZE = { 'aes128gcm': 2, 'aesgcm': 2, 'aesgcm128': 1 };
var TAG_LENGTH = 16;
var KEY_LENGTH = 16;
var NONCE_LENGTH = 12;
var SHA_256_LENGTH = 32;
var MODE_ENCRYPT = 'encrypt';
var MODE_DECRYPT = 'decrypt';

var keylog;
if (process.env.ECE_KEYLOG === '1') {
  keylog = function(m, k) {
    console.warn(m + ' [' + k.length + ']: ' + base64.encode(k));
    return k;
  };
} else {
  keylog = function(m, k) { return k; };
}

/* Optionally base64 decode something. */
function decode(b) {
  if (typeof b === 'string') {
    return base64.decode(b);
  }
  return b;
}

function HMAC_hash(key, input) {
  var hmac = crypto.createHmac('sha256', key);
  hmac.update(input);
  return hmac.digest();
}

/* HKDF as defined in RFC5869, using SHA-256 */
function HKDF_extract(salt, ikm) {
  keylog('salt', salt);
  keylog('ikm', ikm);
  return keylog('extract', HMAC_hash(salt, ikm));
}

function HKDF_expand(prk, info, l) {
  keylog('prk', prk);
  keylog('info', info);
  var output = new Buffer(0);
  var T = new Buffer(0);
  info = new Buffer(info, 'ascii');
  var counter = 0;
  var cbuf = new Buffer(1);
  while (output.length < l) {
    cbuf.writeUIntBE(++counter, 0, 1);
    T = HMAC_hash(prk, Buffer.concat([T, info, cbuf]));
    output = Buffer.concat([output, T]);
  }

  return keylog('expand', output.slice(0, l));
}

function HKDF(salt, ikm, info, len) {
  return HKDF_expand(HKDF_extract(salt, ikm), info, len);
}

function info(base, context) {
  var result = Buffer.concat([
    new Buffer('Content-Encoding: ' + base + '\0', 'ascii'),
    context
  ]);
  keylog('info ' + base, result);
  return result;
}

function lengthPrefix(buffer) {
  var b = Buffer.concat([new Buffer(2), buffer]);
  b.writeUIntBE(buffer.length, 0, 2);
  return b;
}

function extractDH(header, mode) {
  var key = header.privateKey;
  if (!key) {
    if (!header.keymap || !header.keyid || !header.keymap[header.keyid]) {
      throw new Error('No known DH key for ' + header.keyid);
    }
    key = header.keymap[header.keyid];
  }
  if (!header.keylabels[header.keyid]) {
    throw new Error('No known DH key label for ' + header.keyid);
  }
  var senderPubKey, receiverPubKey;
  if (mode === MODE_ENCRYPT) {
    senderPubKey = key.getPublicKey();
    receiverPubKey = header.dh;
  } else if (mode === MODE_DECRYPT) {
    senderPubKey = header.dh;
    receiverPubKey = key.getPublicKey();
  } else {
    throw new Error('Unknown mode only ' + MODE_ENCRYPT +
                    ' and ' + MODE_DECRYPT + ' supported');
  }
  return {
    secret: key.computeSecret(header.dh),
    context: Buffer.concat([
      decode(header.keylabels[header.keyid]),
      Buffer.from([0]),
      lengthPrefix(receiverPubKey), // user agent
      lengthPrefix(senderPubKey)    // application server
    ])
  };
}

function extractSecretAndContext(header, mode) {
  var result = { secret: null, context: new Buffer(0) };
  if (header.key) {
    result.secret = header.key;
    if (result.secret.length !== KEY_LENGTH) {
      throw new Error('An explicit key must be ' + KEY_LENGTH + ' bytes');
    }
  } else if (header.dh) { // receiver/decrypt
    result = extractDH(header, mode);
  } else if (typeof header.keyid !== undefined) {
    result.secret = header.keymap[header.keyid];
  }
  if (!result.secret) {
    throw new Error('Unable to determine key');
  }
  keylog('secret', result.secret);
  keylog('context', result.context);
  if (header.authSecret) {
    result.secret = HKDF(header.authSecret, result.secret,
                         info('auth', new Buffer(0)), SHA_256_LENGTH);
    keylog('authsecret', result.secret);
  }
  return result;
}

function webpushSecret(header, mode) {
  if (!header.authSecret) {
    throw new Error('No authentication secret for webpush');
  }
  keylog('authsecret', header.authSecret);

  var remotePubKey, senderPubKey, receiverPubKey;
  if (mode === MODE_ENCRYPT) {
    senderPubKey = header.privateKey.getPublicKey();
    remotePubKey = receiverPubKey = header.dh;
  } else if (mode === MODE_DECRYPT) {
    remotePubKey = senderPubKey = header.keyid;
    receiverPubKey = header.privateKey.getPublicKey();
  } else {
    throw new Error('Unknown mode only ' + MODE_ENCRYPT +
                    ' and ' + MODE_DECRYPT + ' supported');
  }
  keylog('remote pubkey', remotePubKey);
  keylog('sender pubkey', senderPubKey);
  keylog('receiver pubkey', receiverPubKey);
  return keylog('secret dh',
                HKDF(header.authSecret,
                     header.privateKey.computeSecret(remotePubKey),
                     Buffer.concat([
                       Buffer.from('WebPush: info\0'),
                       receiverPubKey,
                       senderPubKey
                     ]),
                     SHA_256_LENGTH));
}

function extractSecret(header, mode) {
  if (header.key) {
    if (header.key.length !== KEY_LENGTH) {
      throw new Error('An explicit key must be ' + KEY_LENGTH + ' bytes');
    }
    return keylog('secret key', header.key);
  }

  if (!header.privateKey) {
    // Lookup based on keyid
    var key = header.keymap && header.keymap[header.keyid];
    if (!key) {
      throw new Error('No saved key (keyid: "' + header.keyid + '")');
    }
    return key;
  }

  return webpushSecret(header, mode);
}

function deriveKeyAndNonce(header, mode) {
  if (!header.salt) {
    throw new Error('must include a salt parameter for ' + header.version);
  }
  var keyInfo;
  var nonceInfo;
  var secret;
  if (header.version === 'aesgcm128') {
    // really old
    keyInfo = 'Content-Encoding: aesgcm128';
    nonceInfo = 'Content-Encoding: nonce';
    secret = extractSecretAndContext(header, mode).secret;
  } else if (header.version === 'aesgcm') {
    // old
    var s = extractSecretAndContext(header, mode);
    keyInfo = info('aesgcm', s.context);
    nonceInfo = info('nonce', s.context);
    secret = s.secret;
  } else if (header.version === 'aes128gcm') {
    // latest
    keyInfo = Buffer.from('Content-Encoding: aes128gcm\0');
    nonceInfo = Buffer.from('Content-Encoding: nonce\0');
    secret = extractSecret(header, mode);
  } else {
    throw new Error('Unable to set context for mode ' + params.version);
  }
  var prk = HKDF_extract(header.salt, secret);
  var result = {
    key: HKDF_expand(prk, keyInfo, KEY_LENGTH),
    nonce: HKDF_expand(prk, nonceInfo, NONCE_LENGTH)
  };
  keylog('key', result.key);
  keylog('nonce base', result.nonce);
  return result;
}

/* Parse command-line arguments. */
function parseParams(params) {
  var header = {};
  if (params.version) {
    header.version = params.version;
  } else {
    header.version = (params.padSize === 1) ? 'aesgcm128' : 'aesgcm';
  }

  header.rs = parseInt(params.rs, 10);
  if (isNaN(header.rs)) {
    header.rs = 4096;
  }
  if (header.rs <= PAD_SIZE[header.version]) {
    throw new Error('The rs parameter has to be greater than ' +
                    PAD_SIZE[header.version]);
  }

  if (params.salt) {
    header.salt = decode(params.salt);
    if (header.salt.length !== KEY_LENGTH) {
      throw new Error('The salt parameter must be ' + KEY_LENGTH + ' bytes');
    }
  }
  header.keyid = params.keyid;
  if (params.key) {
    header.key = decode(params.key);
  } else {
    header.privateKey = params.privateKey;
    if (!header.privateKey) {
      header.keymap = params.keymap || saved.keymap;
    }
    if (header.version !== 'aes128gcm') {
      header.keylabels = params.keylabels || saved.keylabels;
    }
    if (params.dh) {
      header.dh = decode(params.dh);
    }
  }
  if (params.authSecret) {
    header.authSecret = decode(params.authSecret);
  }
  return header;
}

function generateNonce(base, counter) {
  var nonce = new Buffer(base);
  var m = nonce.readUIntBE(nonce.length - 6, 6);
  var x = ((m ^ counter) & 0xffffff) +
      ((((m / 0x1000000) ^ (counter / 0x1000000)) & 0xffffff) * 0x1000000);
  nonce.writeUIntBE(x, nonce.length - 6, 6);
  keylog('nonce' + counter, nonce);
  return nonce;
}

/* Used when decrypting aes128gcm to populate the header values. Modifies the
 * header values in place and returns the size of the header. */
function readHeader(buffer, header) {
  var idsz = buffer.readUIntBE(20, 1);
  header.salt = buffer.slice(0, KEY_LENGTH);
  header.rs = buffer.readUIntBE(KEY_LENGTH, 4);
  header.keyid = buffer.slice(21, 21 + idsz);
  return 21 + idsz;
}

function decryptRecord(key, counter, buffer, header) {
  keylog('decrypt', buffer);
  var nonce = generateNonce(key.nonce, counter);
  var gcm = crypto.createDecipheriv(AES_GCM, key.key, nonce);
  gcm.setAuthTag(buffer.slice(buffer.length - TAG_LENGTH));
  var data = gcm.update(buffer.slice(0, buffer.length - TAG_LENGTH));
  data = Buffer.concat([data, gcm.final()]);
  keylog('decrypted', data);
  var padSize = PAD_SIZE[header.version];
  var pad = data.readUIntBE(0, padSize);
  if (pad + padSize > data.length) {
    throw new Error('padding exceeds block size');
  }
  keylog('padding', data.slice(0, padSize + pad));
  var padCheck = new Buffer(pad);
  padCheck.fill(0);
  if (padCheck.compare(data.slice(padSize, padSize + pad)) !== 0) {
    throw new Error('invalid padding');
  }
  return data.slice(padSize + pad);
}

// TODO: this really should use the node streams stuff

/**
 * Decrypt some bytes.  This uses the parameters to determine the key and block
 * size, which are described in the draft.  Binary values are base64url encoded.
 *
 * |params.version| contains the version of encoding to use: aes128gcm is the latest,
 * but aesgcm and aesgcm128 are also accepted (though the latter two might
 * disappear in a future release).  If omitted, assume aesgcm, unless
 * |params.padSize| is set to 1, which means aesgcm128.
 *
 * If |params.key| is specified, that value is used as the key.
 *
 * If |params.keyid| is specified without |params.dh|, the keyid value is used
 * to lookup the |params.keymap| for a buffer containing the key.
 *
 * For version aesgcm and aesgcm128, |params.dh| includes the public key of the sender.  The ECDH key
 * pair used to decrypt is looked up using |params.keymap[params.keyid]|.
 *
 * Version aes128gcm is stricter.  The |params.privateKey| includes the private
 * key of the receiver.  The keyid is extracted from the header and used as the
 * ECDH public key of the sender.
 */
function decrypt(buffer, params) {
  var header = parseParams(params);
  if (header.version === 'aes128gcm') {
    var headerLength = readHeader(buffer, header);
    buffer = buffer.slice(headerLength);
  }
  var key = deriveKeyAndNonce(header, MODE_DECRYPT);
  var start = 0;
  var result = new Buffer(0);

  for (var i = 0; start < buffer.length; ++i) {
    var end = start + header.rs + TAG_LENGTH;
    if (end === buffer.length) {
      throw new Error('Truncated payload');
    }
    end = Math.min(end, buffer.length);
    if (end - start <= TAG_LENGTH) {
      throw new Error('Invalid block: too small at ' + i);
    }
    var block = decryptRecord(key, i, buffer.slice(start, end),
                              header);
    result = Buffer.concat([result, block]);
    start = end;
  }
  return result;
}

function encryptRecord(key, counter, buffer, pad, padSize) {
  keylog('encrypt', buffer);
  pad = pad || 0;
  var nonce = generateNonce(key.nonce, counter);
  var gcm = crypto.createCipheriv(AES_GCM, key.key, nonce);
  var padding = new Buffer(pad + padSize);
  padding.fill(0);
  padding.writeUIntBE(pad, 0, padSize);
  keylog('padding', padding);
  var epadding = gcm.update(padding);
  var ebuffer = gcm.update(buffer);
  gcm.final();
  var tag = gcm.getAuthTag();
  if (tag.length !== TAG_LENGTH) {
    throw new Error('invalid tag generated');
  }
  return keylog('encrypted', Buffer.concat([epadding, ebuffer, tag]));
}

function writeHeader(header) {
  var ints = new Buffer(5);
  var keyid = Buffer.from(header.keyid || []);
  if (keyid.length > 255) {
    throw new Error('keyid is too large');
  }
  ints.writeUIntBE(header.rs, 0, 4);
  ints.writeUIntBE(keyid.length, 4, 1);
  return Buffer.concat([header.salt, ints, keyid]);
}

/**
 * Encrypt some bytes.  This uses the parameters to determine the key and block
 * size, which are described in the draft.
 *
 * |params.version| contains the version of encoding to use: aes128gcm is the latest,
 * but aesgcm and aesgcm128 are also accepted (though the latter two might
 * disappear in a future release).  If omitted, assume aesgcm, unless
 * |params.padSize| is set to 1, which means aesgcm128.
 *
 * If |params.key| is specified, that value is used as the key.
 *
 * If |params.keyid| is specified without |params.dh|, the keyid value is used
 * to lookup the |params.keymap| for a buffer containing the key.
 *
 * For Diffie-Hellman (WebPush), |params.dh| includes the public key of the
 * receiver.  |params.privateKey| is used to establish a shared secret.  For
 * versions aesgcm and aesgcm128, if a private key is not provided, the ECDH key
 * pair used to encrypt is looked up using |params.keymap[params.keyid]|, and
 * |params.keymap| defaults to the values saved with saveKey().  Key pairs can
 * be created using |crypto.createECDH()|.
 */
function encrypt(buffer, params) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('buffer argument must be a Buffer');
  }
  var header = parseParams(params);
  if (!header.salt) {
    header.salt = crypto.randomBytes(KEY_LENGTH);
  }

  var result;
  if (header.version === 'aes128gcm') {
    // Save the DH public key in the header.
    if (header.privateKey && !header.keyid) {
      header.keyid = header.privateKey.getPublicKey();
    }
    result = writeHeader(header);
  } else {
    // No header on other versions
    result = new Buffer(0);
  }

  var key = deriveKeyAndNonce(header, MODE_ENCRYPT);
  var start = 0;
  var padSize = PAD_SIZE[header.version];
  var pad = isNaN(parseInt(params.pad, 10)) ? 0 : parseInt(params.pad, 10);

  // Note the <= here ensures that we write out a padding-only block at the end
  // of a buffer.
  for (var i = 0; start <= buffer.length; ++i) {
    // Pad so that at least one data byte is in a block.
    var recordPad = Math.min((1 << (padSize * 8)) - 1, // maximum padding
                             Math.min(header.rs - padSize - 1, pad));
    pad -= recordPad;

    var end = Math.min(start + header.rs - padSize - recordPad, buffer.length);
    var block = encryptRecord(key, i, buffer.slice(start, end),
                              recordPad, padSize);
    result = Buffer.concat([result, block]);
    start += header.rs - padSize - recordPad;
  }
  if (pad) {
    throw new Error('Unable to pad by requested amount, ' + pad + ' remaining');
  }
  return result;
}

/**
 * Deprecated.  Use the keymap and keylabels arguments to encrypt()/decrypt().
 */
function saveKey(id, key, dhLabel) {
  saved.keymap[id] = key;
  if (dhLabel) {
    saved.keylabels[id] = dhLabel;
  }
}

module.exports = {
  decrypt: decrypt,
  encrypt: encrypt,
  saveKey: saveKey
};
