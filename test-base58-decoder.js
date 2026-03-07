// Test the inline base58 decoder
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str) {
  const BASE = BigInt(58);
  
  try {
    // Convert base58 string to bigint
    let num = BigInt(0);
    for (const char of str) {
      const digit = ALPHABET.indexOf(char);
      if (digit === -1) {
        throw new Error(`Invalid base58 character: ${char}`);
      }
      num = num * BASE + BigInt(digit);
    }
    
    // Convert bigint to bytes
    const bytes = [];
    while (num > 0n) {
      bytes.unshift(Number(num % 256n));
      num = num / 256n;
    }
    
    // Add leading zero bytes for leading '1's in base58
    for (const char of str) {
      if (char === '1') {
        bytes.unshift(0);
      } else {
        break;
      }
    }
    
    return bytes.length > 0 ? new Uint8Array(bytes) : null;
  } catch (error) {
    console.error('Decode error:', error.message);
    return null;
  }
}

// Test with the known Phantom key
const phantomKey = '3zvwJvNsb213zhvLvPzDCgRSwxpVTBKdmmuHsjAQBsC8YyTmBBdbgsJUCYTbBW6XLYHMdhLphGgX2kP3zAhSCPZ1';
const decoded = base58Decode(phantomKey);

if (decoded) {
  console.log('✅ Decoded successfully');
  console.log(`   Length: ${decoded.length} bytes`);
  console.log(`   First 8 bytes (hex): ${Array.from(decoded.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  
  // Check if first 32 bytes (seed) match expected values
  const seedHex = Array.from(decoded.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('');
  const expectedSeedHex = '95fd965ea9f7343dda2bf1be66bc077d4ea4e01d8f15691117b8ff41c1daabc9';
  
  if (seedHex === expectedSeedHex) {
    console.log(`✅ Seed (first 32 bytes) matches expected value!`);
  } else {
    console.log(`❌ Seed mismatch!`);
    console.log(`   Expected: ${expectedSeedHex}`);
    console.log(`   Got:      ${seedHex}`);
  }
} else {
  console.log('❌ Decode failed');
}
