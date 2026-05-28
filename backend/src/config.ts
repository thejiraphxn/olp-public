import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  jwtSecret: required('JWT_SECRET', 'dev-only-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  databaseUrl: required('DATABASE_URL'),
  cookie: {
    // Set COOKIE_SECURE=true when serving over HTTPS in prod.
    secure: boolEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production'),
    // 'lax' works for same-origin proxy setups (recommended).
    // Use 'none' only if you MUST do cross-site cookies — then secure must be true.
    sameSite: (process.env.COOKIE_SAMESITE ?? 'lax') as 'lax' | 'strict' | 'none',
  },
  s3: {
    endpoint: required('S3_ENDPOINT'),
    publicEndpoint: process.env.PUBLIC_S3_ENDPOINT ?? process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey: required('S3_ACCESS_KEY'),
    secretKey: required('S3_SECRET_KEY'),
    bucket: required('S3_BUCKET'),
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  },
};
