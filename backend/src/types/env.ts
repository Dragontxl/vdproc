export interface Bindings {
  DB: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;
  ADMIN_API_KEY: string;
  CALLBACK_SECRET: string;
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;
  ENVIRONMENT: 'development' | 'production';
  GITHUB_REPO_OWNER: string;
  GITHUB_REPO_NAME: string;
  R2_PUBLIC_URL: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
}