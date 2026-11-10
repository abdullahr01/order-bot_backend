// Supabase Auth accounts for restaurant owners and staff. Lives outside the SQL
// transaction, so callers create the account first and delete it if their transaction fails.
export class AuthAdminError extends Error {
  constructor(operation, cause) {
    super(`Supabase Auth ${operation} failed`);
    this.name = 'AuthAdminError';
    this.operation = operation;
    // Supabase's own code, such as email_exists or over_email_send_rate_limit. Never its message.
    this.code = typeof cause?.code === 'string' ? cause.code : null;
    this.status = Number.isInteger(cause?.status) ? cause.status : null;
  }
}

export class SupabaseAuthAdmin {
  #admin;

  constructor(client) { this.#admin = client.auth.admin; }

  /**
   * Creates the account and emails the invite: the person sets their own password.
   * `appMetadata` (role, restaurant, branch) goes where only the server can change it.
   */
  async invite({ email, name, appMetadata, redirectTo }) {
    const { data, error } = await this.#admin.inviteUserByEmail(email, { data: { name }, redirectTo });
    if (error) throw new AuthAdminError('invite', error);
    const userId = data.user.id;
    const { error: metadataError } = await this.#admin.updateUserById(userId, { app_metadata: appMetadata });
    if (metadataError) {
      await this.deleteUser(userId).catch(() => {});
      throw new AuthAdminError('set_role', metadataError);
    }
    return userId;
  }

  /** A restaurant owner: role tenant_owner and their restaurant. */
  inviteOwner({ email, name, tenantId, redirectTo }) {
    return this.invite({ email, name, redirectTo, appMetadata: { role: 'tenant_owner', tenant_id: tenantId } });
  }

  /** Branch staff: role tenant_staff, their restaurant and branch. */
  inviteStaff({ email, name, tenantId, branchId, redirectTo }) {
    return this.invite({ email, name, redirectTo, appMetadata: { role: 'tenant_staff', tenant_id: tenantId, branch_id: branchId } });
  }

  /** Moves staff to another branch. Their current token still names the old one, so they sign in again. */
  async setStaffBranch(userId, { tenantId, branchId }) {
    const { error } = await this.#admin.updateUserById(userId, {
      app_metadata: { role: 'tenant_staff', tenant_id: tenantId, branch_id: branchId },
    });
    if (error) throw new AuthAdminError('set_branch', error);
  }

  async changeEmail(userId, email) {
    const { error } = await this.#admin.updateUserById(userId, { email, email_confirm: true });
    if (error) throw new AuthAdminError('change_email', error);
  }

  async deleteUser(userId) {
    const { error } = await this.#admin.deleteUser(userId);
    if (error) throw new AuthAdminError('delete', error);
  }
}
