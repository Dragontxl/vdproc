import { Bindings } from '../types/env';
import { SignJWT, jwtVerify } from 'jose';

export class CryptoService {
  private key: CryptoKey | null = null;

  constructor(private env: Bindings) {}

  async getKey(): Promise<CryptoKey> {
    if (this.key) return this.key;

    const keyData = this.env.ENCRYPTION_KEY;
    if (!keyData || keyData.length < 32) {
      throw new Error('ENCRYPTION_KEY must be at least 32 bytes');
    }

    const keyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      keyBytes[i] = keyData.charCodeAt(i);
    }

    this.key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );

    return this.key;
  }

  private uint8ArrayToBase64(arr: Uint8Array): string {
    let result = '';
    const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    
    for (let i = 0; i < arr.length; i += 3) {
      const byte1 = arr[i];
      const byte2 = arr[i + 1] || 0;
      const byte3 = arr[i + 2] || 0;
      
      const encoded1 = byte1 >> 2;
      const encoded2 = ((byte1 & 0x03) << 4) | (byte2 >> 4);
      const encoded3 = ((byte2 & 0x0F) << 2) | (byte3 >> 6);
      const encoded4 = byte3 & 0x3F;
      
      result += base64Chars[encoded1] + base64Chars[encoded2] + 
                (i + 1 < arr.length ? base64Chars[encoded3] : '=') + 
                (i + 2 < arr.length ? base64Chars[encoded4] : '=');
    }
    
    return result;
  }

  private base64ToUint8Array(str: string): Uint8Array {
    const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const decoded: number[] = [];
    let i = 0;
    
    while (i < str.length) {
      const encoded1 = base64Chars.indexOf(str[i++]);
      const encoded2 = base64Chars.indexOf(str[i++]);
      const encoded3 = str[i] === '=' ? 0 : base64Chars.indexOf(str[i++]);
      const encoded4 = str[i] === '=' ? 0 : base64Chars.indexOf(str[i++]);
      
      decoded.push((encoded1 << 2) | (encoded2 >> 4));
      if (encoded3 !== 0 || str[i - 2] !== '=') {
        decoded.push(((encoded2 & 0x0F) << 4) | (encoded3 >> 2));
      }
      if (encoded4 !== 0 || str[i - 1] !== '=') {
        decoded.push(((encoded3 & 0x03) << 6) | encoded4);
      }
    }
    
    return new Uint8Array(decoded);
  }

  async encrypt(text: string): Promise<string> {
    const key = await this.getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = encoder.encode(text);

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );

    const encryptedArray = new Uint8Array(encrypted);
    const combined = new Uint8Array(iv.length + encryptedArray.length);
    combined.set(iv, 0);
    combined.set(encryptedArray, iv.length);

    return this.uint8ArrayToBase64(combined);
  }

  async decrypt(encryptedText: string): Promise<string> {
    const key = await this.getKey();
    const bytes = this.base64ToUint8Array(encryptedText);

    const iv = bytes.slice(0, 12);
    const encryptedData = bytes.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encryptedData
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  }

  async generateHMAC(data: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(data)
    );

    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  async verifyHMAC(data: string, signature: string, secret: string): Promise<boolean> {
    const expectedSignature = await this.generateHMAC(data, secret);
    return expectedSignature === signature;
  }

  generateRandomString(length: number = 32): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const array = crypto.getRandomValues(new Uint8Array(length));
    for (let i = 0; i < length; i++) {
      result += chars[array[i] % chars.length];
    }
    return result;
  }

  async generateAPIKey(): Promise<string> {
    return this.generateRandomString(48);
  }

  async hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const salt = this.generateRandomString(16);
    const combined = `${password}${salt}`;
    
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(combined)
    );
    
    const hashArray = new Uint8Array(hashBuffer);
    const hashHex = Array.from(hashArray)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    return `${salt}:${hashHex}`;
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    if (!hash || !hash.includes(':')) {
      return false;
    }
    
    const [salt, storedHash] = hash.split(':');
    const encoder = new TextEncoder();
    const combined = `${password}${salt}`;
    
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(combined)
    );
    
    const hashArray = new Uint8Array(hashBuffer);
    const computedHash = Array.from(hashArray)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    return computedHash === storedHash;
  }

  async generateToken(userId: string, role: string = 'USER'): Promise<string> {
    const encoder = new TextEncoder();
    const secret = encoder.encode(this.env.JWT_SECRET);

    const token = await new SignJWT({ userId, role })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(secret);

    return token;
  }

  async verifyToken(token: string): Promise<{ userId: string; role: string } | null> {
    const encoder = new TextEncoder();
    const secret = encoder.encode(this.env.JWT_SECRET);

    try {
      const { payload } = await jwtVerify(token, secret);
      return { userId: payload.userId as string, role: payload.role as string };
    } catch {
      return null;
    }
  }
}