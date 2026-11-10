import { AuthModel } from '../model/auth.model.js';
import { hashToken } from '../shared/crypto.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid } from '../shared/validation.js';

// Token problems that mean "sign in again". Anything else, such as Supabase's keys
// being unreachable, is our fault and must not sign people out.
const INVALID_TOKEN_CODES = new Set([
  'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_INVALID', 'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

const bearer = (header) => /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1] ?? null;

// The restaurant, branch and person always come from credentials, never the request.
export class AuthService {
  #repository;
  #verifyToken;

  constructor({ repository, verifyToken }) {
    this.#repository = repository;
    this.#verifyToken = verifyToken;
  }

  async #claims(headers) {
    const token = bearer(headers.authorization);
    if (!token) throw apiError('unauthorized', 'Please sign in to continue.');
    try {
      return await this.#verifyToken(token);
    } catch (error) {
      if (INVALID_TOKEN_CODES.has(error?.code)) throw apiError('unauthorized', 'Your session has ended. Please sign in again.');
      throw error;
    }
  }

  async authenticateAdmin(headers, log) {
    const claims = await this.#claims(headers);
    // app_metadata only: users can edit their own user_metadata.
    const metadata = claims.app_metadata ?? {};
    if (metadata.role !== 'super_admin') throw apiError('forbidden', 'This needs a platform team account.');
    if (claims.aal !== 'aal2') throw apiError('forbidden', 'Sign in with your authenticator code to continue.');

    let adminScope = null;
    if (metadata.admin_scope !== undefined && metadata.admin_scope !== null) {
      const parsed = AuthModel.adminScope.safeParse(metadata.admin_scope);
      if (!parsed.success) throw apiError('forbidden', 'This account is not set up correctly.');
      adminScope = parsed.data;
    }
    log.success({ kind: 'admin', adminRole: adminScope?.role ?? 'founder' }, 'Platform team member authenticated');
    return Object.freeze({
      kind: 'admin', role: 'super_admin', userId: claims.sub, name: metadata.name ?? claims.email ?? 'Platform team',
      adminScope, viewCountry: headers['x-admin-country'] ?? null,
    });
  }

  async authenticatePortal(headers, log) {
    if (headers['x-counter-device']) return this.#authenticateCounterPerson(headers, log);

    const claims = await this.#claims(headers);
    const metadata = claims.app_metadata ?? {};
    if (!['tenant_owner', 'tenant_staff'].includes(metadata.role) || !isUuid(metadata.tenant_id)) {
      throw apiError('forbidden', 'This needs a restaurant account.');
    }

    // Removing someone ends their access on this request, not when their token expires.
    const member = await this.#repository.findTeamMember(claims.sub, metadata.tenant_id);
    const removed = !member || member.role !== metadata.role ||
      (member.role === 'tenant_staff' && (member.branch_id !== metadata.branch_id || member.branch_retired));
    if (removed) throw apiError('account_removed', 'Your access has been removed. Ask the owner if this is a mistake.');

    const owner = member.role === 'tenant_owner';
    log.success({ kind: owner ? 'owner' : 'staff', tenantId: metadata.tenant_id, branchId: member.branch_id }, 'Restaurant user authenticated');
    return Object.freeze({
      kind: owner ? 'owner' : 'staff', role: member.role, userId: claims.sub, name: member.name,
      tenantId: metadata.tenant_id, branchId: owner ? null : member.branch_id,
    });
  }

  /** A paired PC, before anyone has unlocked it. */
  async authenticateDevice(headers, log) {
    const device = await this.#device(headers, null);
    log.success({ kind: 'device', tenantId: device.tenant_id, branchId: device.branch_id, deviceId: device.id }, 'Counter device authenticated');
    return Object.freeze({
      kind: 'device', tenantId: device.tenant_id, branchId: device.branch_id, deviceId: device.id, name: device.name,
    });
  }

  async #authenticateCounterPerson(headers, log) {
    const staffToken = bearer(headers.authorization);
    const device = await this.#device(headers, staffToken ? hashToken(staffToken) : null);
    const allowed = device.user_id && (device.person_role === 'tenant_owner' || device.person_branch_id === device.branch_id);
    if (!allowed) throw apiError('counter_locked', 'The counter is locked. Enter your PIN to carry on.');

    log.success({ kind: 'counter', tenantId: device.tenant_id, branchId: device.branch_id, deviceId: device.id }, 'Counter person authenticated');
    // Everyone at a counter works on its branch, the owner included. Permissions use their real role.
    return Object.freeze({
      kind: 'counter', role: device.person_role, userId: device.user_id, name: device.person_name,
      tenantId: device.tenant_id, branchId: device.branch_id, deviceId: device.id,
    });
  }

  async #device(headers, staffHash) {
    const token = headers['x-counter-device'];
    const device = token ? await this.#repository.findCounter(hashToken(token), staffHash) : null;
    if (!device || device.status === 'cancelled' || device.branch_retired) {
      throw apiError('device_revoked', 'This counter is no longer paired. Ask the owner for a new pairing code.');
    }
    return device;
  }
}
