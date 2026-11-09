-- Better Auth 1.7.18 / Prisma adapter 1.7.18 reviewed provider schema.
-- Same six models as the accepted spike; no registration, account or runtime activation.
CREATE SCHEMA "identity";
REVOKE ALL ON SCHEMA "identity" FROM PUBLIC;
CREATE TABLE "identity"."User" (
 "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE,
 "emailVerified" BOOLEAN NOT NULL DEFAULT false, "image" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL, "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "identity"."Session" (
 "id" TEXT PRIMARY KEY, "token" TEXT NOT NULL UNIQUE, "userId" TEXT NOT NULL,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL, "ipAddress" TEXT, "userAgent" TEXT,
 FOREIGN KEY("userId") REFERENCES "identity"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Session_userId_idx" ON "identity"."Session"("userId");
CREATE TABLE "identity"."Account" (
 "id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT,
 "accessTokenExpiresAt" TIMESTAMPTZ(3), "refreshTokenExpiresAt" TIMESTAMPTZ(3),
 "scope" TEXT, "password" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 UNIQUE("providerId","accountId"),
 FOREIGN KEY("userId") REFERENCES "identity"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Account_userId_idx" ON "identity"."Account"("userId");
CREATE TABLE "identity"."Verification" (
 "id" TEXT PRIMARY KEY, "identifier" TEXT NOT NULL, "value" TEXT NOT NULL,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "Verification_identifier_idx" ON "identity"."Verification"("identifier");
CREATE TABLE "identity"."TwoFactor" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "secret" TEXT NOT NULL, "backupCodes" TEXT NOT NULL,
 "verified" BOOLEAN NOT NULL DEFAULT true, "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
 "lockedUntil" TIMESTAMPTZ(3),
 FOREIGN KEY("userId") REFERENCES "identity"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TwoFactor_userId_idx" ON "identity"."TwoFactor"("userId");
CREATE INDEX "TwoFactor_secret_idx" ON "identity"."TwoFactor"("secret");
CREATE TABLE "identity"."RateLimit" (
 "id" TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, "count" INTEGER NOT NULL, "lastRequest" BIGINT NOT NULL
);
REVOKE ALL ON ALL TABLES IN SCHEMA "identity" FROM PUBLIC;
