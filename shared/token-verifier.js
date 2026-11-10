import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Checks a Supabase access token against the project's public signing key. */
export function createTokenVerifier({ supabaseUrl, keySet }) {
  const keys = keySet ?? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `${supabaseUrl}/auth/v1`, audience: 'authenticated', algorithms: ['ES256'],
    });
    return payload;
  };
}
