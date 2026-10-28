// lib/auth/invite.ts
// Inviting a user to a named tenant, and the invite email (WP-DS05, DSD-12). Used by
// scripts/add-user.ts. Kept here, not in the script, so a test can run it against an
// in-memory store and read what it would print.
//
// Nothing here sends mail. No provider is wired (WP-DS08 picks one). The email is rendered and
// handed back; the script prints it with the link. The template itself lives in brand/email
// (WP-BR06), so the printed invite matches the branded HTML twin exactly.

import { INVITE_TTL_DAYS, tenantSlug, type AuthStore, type Tenant } from "./store";
import { renderInviteEmail as renderBrandInviteEmail, type RenderedEmail } from "../../../brand/email/invite";

export const DEFAULT_APP_URL = "http://localhost:3000";

export type InviteEmail = RenderedEmail;

export function inviteLink(appUrl: string, token: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}/login?invite=${encodeURIComponent(token)}`;
}

// The invite template (WP-BR06's branded base: table HTML plus a plain-text twin).
export function renderInviteEmail(args: {
  email: string;
  tenantName: string;
  link: string;
  expiresAt: Date;
  fromInvites?: string;
}): InviteEmail {
  return renderBrandInviteEmail(args);
}

export interface AddUserOptions {
  tenant: string; // tenant name or id
  email: string;
  createTenant?: boolean; // make the tenant if no tenant has that name
  dryRun?: boolean; // read only: write nothing, print what would happen
  appUrl?: string;
  now?: Date;
}

export interface AddUserResult {
  dryRun: boolean;
  tenant: Tenant;
  tenantCreated: boolean;
  email: string;
  link: string;
  expiresAt: Date;
  message: InviteEmail;
}

// Throws with a plain message on anything the admin must fix (no tenant, bad email, account
// already exists). In a dry run the store is only read and the link carries a placeholder.
export async function addUser(store: AuthStore, opts: AddUserOptions): Promise<AddUserResult> {
  const email = opts.email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error(`"${opts.email}" is not an email address.`);
  const tenantArg = opts.tenant.trim();
  if (!tenantArg) throw new Error("Name the tenant with --tenant.");
  const now = opts.now ?? new Date();
  const dryRun = Boolean(opts.dryRun);

  const existing = await store.findUserByEmail(email);
  if (existing) throw new Error(`${email} already has an account (tenant ${existing.tenantId}). No invite written.`);

  let tenant = await store.findTenant(tenantArg);
  let tenantCreated = false;
  if (!tenant) {
    if (!opts.createTenant) {
      throw new Error(`No tenant is named "${tenantArg}". Check the name, or pass --create-tenant to make it.`);
    }
    tenant = dryRun ? { id: tenantSlug(tenantArg), name: tenantArg } : await store.createTenant(tenantArg);
    tenantCreated = true;
  }

  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  let token = "DRY-RUN-NO-TOKEN";
  if (!dryRun) {
    const made = await store.createInvite(tenant.id, email, expiresAt);
    token = made.token;
  }
  const link = inviteLink(opts.appUrl || DEFAULT_APP_URL, token);
  const message = renderInviteEmail({
    email,
    tenantName: tenant.name,
    link,
    expiresAt,
    fromInvites: process.env.MAIL_FROM_INVITES,
  });
  return { dryRun, tenant, tenantCreated, email, link, expiresAt, message };
}

// ---- The command line (scripts/add-user.ts) ------------------------------------------------

export interface AddUserArgs {
  help: boolean;
  tenant: string;
  email: string;
  send: boolean;
  dryRun: boolean;
  createTenant: boolean;
  appUrl: string;
  errors: string[];
}

export const ADD_USER_HELP = `add-user.ts: invite a user to a named tenant (WP-DS05)

  npx tsx scripts/add-user.ts --tenant <name> --email <address> [--send] [--dry-run]

  --tenant <name>     the tenant name or id, e.g. demo
  --email <address>   the person to invite
  --send              print the whole invite email as well as the link
  --dry-run           write nothing, print what would happen
  --create-tenant     make the tenant if none has that name (its id is the slug of the name)
  --app-url <url>     the base of the link (or APP_URL), default ${DEFAULT_APP_URL}

  The invite is stored with DATABASE_URL (or POSTGRES_URL) when one is set. Without one it
  lives only in this process, so the link will not work anywhere else.
  No email is ever sent. No mail provider is wired yet. --send prints the email for you to send.`;

export function parseAddUserArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): AddUserArgs {
  const a: AddUserArgs = {
    help: false,
    tenant: "",
    email: "",
    send: false,
    dryRun: false,
    createTenant: false,
    appUrl: env.APP_URL || DEFAULT_APP_URL,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        a.errors.push(`${arg} needs a value`);
        return "";
      }
      i++;
      return v;
    };
    if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--tenant") a.tenant = value();
    else if (arg === "--email") a.email = value();
    else if (arg === "--app-url") a.appUrl = value() || a.appUrl;
    else if (arg === "--send") a.send = true;
    else if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--create-tenant") a.createTenant = true;
    else a.errors.push(`unknown argument ${arg}`);
  }
  if (!a.help) {
    if (!a.tenant) a.errors.push("--tenant is required");
    if (!a.email) a.errors.push("--email is required");
  }
  return a;
}

// Runs the command against a store and writes to `out`. Returns the exit code: 0 done, 1 refused,
// 2 bad arguments. Never sends anything.
export async function runAddUser(
  argv: string[],
  store: AuthStore,
  out: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<number> {
  const args = parseAddUserArgs(argv, env);
  if (args.help) {
    out(ADD_USER_HELP);
    return 0;
  }
  if (args.errors.length) {
    for (const e of args.errors) out(`add-user: ${e}`);
    out("Run with --help for usage.");
    return 2;
  }
  let r: AddUserResult;
  try {
    r = await addUser(store, {
      tenant: args.tenant,
      email: args.email,
      createTenant: args.createTenant,
      dryRun: args.dryRun,
      appUrl: args.appUrl,
      now,
    });
  } catch (e) {
    out(`add-user: ${(e as Error).message}`);
    return 1;
  }
  if (r.dryRun) out("DRY RUN. Nothing was written and nothing was sent.");
  if (r.tenantCreated) out(`${r.dryRun ? "Would create" : "Created"} tenant "${r.tenant.name}" (id ${r.tenant.id}).`);
  out(`${r.dryRun ? "Would invite" : "Invited"} ${r.email} to tenant "${r.tenant.name}" (id ${r.tenant.id}).`);
  out(`Expires: ${r.expiresAt.toISOString()}`);
  out(`Link: ${r.link}`);
  if (args.send) {
    out("");
    out("No mail provider is wired, so nothing was sent. Send this yourself:");
    out("----------------------------------------------------------------");
    out(`To: ${r.message.to}`);
    out(`Subject: ${r.message.subject}`);
    out("");
    out(r.message.text);
    out("----------------------------------------------------------------");
  }
  return 0;
}
