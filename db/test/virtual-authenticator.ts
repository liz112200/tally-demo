// A software passkey for the database tests: a real P-256 key that answers
// WebAuthn registration and sign-in exactly as an authenticator would (CBOR
// attestation object, authenticator data, ES256 signature over it), so the
// real @simplewebauthn verification runs on every test, not a mock of it.
// It also lets a test misbehave on purpose: a replayed counter, a wrong
// origin, a signature over something else.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { encodeCBOR, type CBORType } from '@levischuck/tiny-cbor';

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | Buffer | string) => createHash('sha256').update(data).digest();

// Flags: user present, user verified; attested credential data on create.
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export class VirtualAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  signCount = 0;

  constructor(
    private readonly rpID = 'localhost',
    private readonly origin = 'http://localhost:3000',
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.publicJwk = { x: jwk.x, y: jwk.y };
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private authData(flags: number, attested: Buffer | null): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.signCount);
    return Buffer.concat([sha256(this.rpID), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  // The answer to generateRegistrationOptions(): an attestation of type none.
  register(options: { challenge: string }, overrides: { origin?: string } = {}) {
    const coseKey = encodeCBOR(
      new Map<number, CBORType>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(this.publicJwk.x, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(this.publicJwk.y, 'base64url'))],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, Buffer.from(coseKey)]);
    const attestationObject = encodeCBOR(
      new Map<string, CBORType>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(this.authData(UP | UV | AT, attested))],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, overrides.origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  // The answer to generateAuthenticationOptions(). Each answer counts up,
  // as a real authenticator's signature counter does, unless `signCount` is
  // forced to replay an old value.
  authenticate(options: { challenge: string }, overrides: { signCount?: number; origin?: string } = {}) {
    this.signCount = overrides.signCount ?? this.signCount + 1;
    const authenticatorData = this.authData(UP | UV, null);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, overrides.origin);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }
}
