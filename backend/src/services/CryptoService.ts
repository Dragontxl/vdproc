import { Bindings } from '../types/env';
import { SignJWT, jwtVerify } from 'jose';

export class CryptoService {
  private key: CryptoKey | null = null;

  constructor(private env: Bindings) {}

  async getKey(): Promise<CryptoKey> {
    if (this.key) return this.key;

    const keyData = this.env.ENCRYPTION_KEY;
    if (!keyData || keyData.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes');
    }

    const keyBytes = new Uint8Array(keyData.length);
    for (let i = 0; i < keyData.length; i++) {
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

    return btoa(String.fromCharCode(...combined));
  }

  async decrypt(encryptedText: string): Promise<string> {
    const key = await this.getKey();
    const decoded = atob(encryptedText);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      bytes[i] = decoded.charCodeAt(i);
    }

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