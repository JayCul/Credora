const { ethers } = require("ethers");

/// Strip everything except a leading "+" and digits so the same phone number always
/// hashes to the same value regardless of spacing/formatting differences
/// (e.g. "+234 801 234 5678" and "2348012345678" both normalize to "+2348012345678").
function normalizePhone(phone) {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/// Salted keccak256 of a phone number. The salt (PHONE_HASH_SALT) is a server-side
/// secret never written on-chain — without it, nobody can brute-force/rainbow-table
/// the public merchantHash/buyerHash values on-chain back into real phone numbers,
/// even though the space of Nigerian phone numbers is small enough to enumerate.
function hashPhone(phone, salt) {
  if (!salt) throw new Error("PHONE_HASH_SALT is required to hash phone numbers.");
  const normalized = normalizePhone(phone);
  return ethers.keccak256(ethers.toUtf8Bytes(`${salt}:${normalized}`));
}

function hashText(text) {
  return ethers.keccak256(ethers.toUtf8Bytes(text || ""));
}

function toBytes3(code) {
  const bytes = ethers.toUtf8Bytes(code);
  if (bytes.length !== 3) {
    throw new Error(`Currency code must be exactly 3 ASCII characters, got "${code}"`);
  }
  return bytes;
}

module.exports = { normalizePhone, hashPhone, hashText, toBytes3 };
