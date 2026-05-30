import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = process.env.ZKLOGIN_SALT_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "ZKLOGIN_SALT_SECRET is not configured" },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => null) as { jwt?: string } | null;
  const jwt = body?.jwt;
  if (!jwt) {
    return NextResponse.json({ error: "jwt is required" }, { status: 400 });
  }

  const claims = decodeJwtPayload(jwt);
  const issuer = stringClaim(claims.iss);
  const subject = stringClaim(claims.sub);
  const audience = Array.isArray(claims.aud)
    ? claims.aud.map(stringClaim).join(",")
    : stringClaim(claims.aud);

  if (!issuer || !subject || !audience) {
    return NextResponse.json({ error: "JWT missing iss, sub, or aud" }, { status: 400 });
  }

  const salt = createHmac("sha256", secret)
    .update("utxopia:sui:zklogin:salt:v1")
    .update("\0")
    .update(issuer)
    .update("\0")
    .update(audience)
    .update("\0")
    .update(subject)
    .digest("hex");

  return NextResponse.json({ salt });
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split(".");
  if (!payload) throw new Error("Invalid JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value : "";
}
