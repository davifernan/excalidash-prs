import crypto from "crypto";

const API_KEY_SCRYPT_PEPPER = process.env.API_KEY_HASH_PEPPER || "api-key-hash-pepper";
const API_KEY_SCRYPT_N = 1 << 14;
const API_KEY_SCRYPT_R = 8;
const API_KEY_SCRYPT_P = 1;
const API_KEY_SCRYPT_KEYLEN = 32;
const API_KEY_SCRYPT_MAXMEM = 32 * 1024 * 1024;

export const API_KEY_PREFIX = "exd_";
/**
 * Scopes beyond the defaults, granted only when explicitly asked for.
 *
 * Reading a drawing's history and handing a drawing to another account are
 * both riskier than editing it, so a key does not get them by accident: the
 * default set stays exactly as it was.
 */
export const DRAWINGS_HISTORY_SCOPE = "drawings:history";
export const DRAWINGS_SHARE_SCOPE = "drawings:share";
export const DRAWINGS_READ_SCOPE = "drawings:read";
export const DRAWINGS_WRITE_SCOPE = "drawings:write";

export const DEFAULT_API_KEY_SCOPES = [
  DRAWINGS_READ_SCOPE,
  DRAWINGS_WRITE_SCOPE,
  "collections:read",
  "collections:write",
] as const;

export const generateApiKey = (): {
  token: string;
  keyId: string;
  prefix: string;
  tokenHash: string;
} => {
  const keyId = crypto.randomBytes(12).toString("base64url");
  const secret = crypto.randomBytes(32).toString("base64url");
  const token = `${API_KEY_PREFIX}${keyId}_${secret}`;

  return {
    token,
    keyId,
    prefix: token.slice(0, 16),
    tokenHash: hashApiKey(token),
  };
};

export const hashApiKey = (token: string): string =>
  crypto
    .scryptSync(token, API_KEY_SCRYPT_PEPPER, API_KEY_SCRYPT_KEYLEN, {
      N: API_KEY_SCRYPT_N,
      r: API_KEY_SCRYPT_R,
      p: API_KEY_SCRYPT_P,
      maxmem: API_KEY_SCRYPT_MAXMEM,
    })
    .toString("hex");

export const isApiKeyToken = (token: string): boolean => token.startsWith(API_KEY_PREFIX);

export const extractApiKeyId = (token: string): string | null => {
  if (!isApiKeyToken(token)) return null;
  const withoutPrefix = token.slice(API_KEY_PREFIX.length);
  const separatorIndex = withoutPrefix[16] === "_" ? 16 : withoutPrefix.indexOf("_");
  if (separatorIndex <= 0) return null;
  const keyId = withoutPrefix.slice(0, separatorIndex);
  return /^[A-Za-z0-9_-]{8,64}$/.test(keyId) ? keyId : null;
};

export const apiKeyHashMatches = (token: string, storedHash: string): boolean => {
  const computed = Buffer.from(hashApiKey(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (computed.length !== stored.length) return false;
  return crypto.timingSafeEqual(computed, stored);
};

export const serializeApiKeyScopes = (scopes: readonly string[] = DEFAULT_API_KEY_SCOPES): string =>
  scopes.join(",");

export const parseApiKeyScopes = (raw: string | null | undefined): string[] =>
  (raw || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

const hasBearerApiKey = (authorizationHeader: unknown): boolean => {
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (typeof header !== "string") return false;
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && typeof token === "string" && isApiKeyToken(token);
};

export const isNonBrowserApiKeyBearerRequest = (req: {
  headers: Record<string, unknown>;
}): boolean => {
  if (!hasBearerApiKey(req.headers.authorization)) return false;
  return !req.headers.origin && !req.headers.referer;
};

type ApiKeyClient = {
  apiKey: {
    findUnique: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
};

/**
 * Resolve an API key to the user it belongs to.
 *
 * Shared by the HTTP middleware and the websocket handshake so both accept
 * exactly the same credentials — a key that works for REST but not for live
 * updates would be worse than one that works nowhere.
 */
export const resolveApiKeyUser = async (
  prisma: ApiKeyClient,
  token: string,
): Promise<{ user: any; apiKeyId: string; scopes: string[] } | null> => {
  const keyId = extractApiKeyId(token);
  if (!keyId) return null;

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyId },
    include: { user: true },
  });
  if (!apiKey || apiKey.revokedAt) return null;
  if (!apiKeyHashMatches(token, apiKey.tokenHash)) return null;
  if (!apiKey.user.isActive) return null;

  try {
    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    });
  } catch (error) {
    // Bookkeeping must never cost a caller their request.
    console.warn("Failed to update API key lastUsedAt:", error);
  }

  return {
    user: apiKey.user,
    apiKeyId: apiKey.id,
    scopes: parseApiKeyScopes(apiKey.scopes),
  };
};
