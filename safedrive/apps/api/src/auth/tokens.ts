import { SignJWT, jwtVerify } from 'jose';

export interface AccessClaims {
  sub: string;
  sid: string;
  adm: boolean;
}

export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid, adm: claims.adm })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setIssuer('safedrive')
      .setAudience('safedrive-api')
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: 'safedrive',
        audience: 'safedrive-api',
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      return { sub: payload.sub, sid: payload.sid, adm: payload.adm === true };
    } catch {
      return null;
    }
  }
}
