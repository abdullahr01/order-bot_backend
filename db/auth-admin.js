// Supabase Auth accounts for restaurant owners. Lives outside the SQL transaction,
// so callers create the account first and delete it if their transaction fails.
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

  /** Creates the owner's account and emails the invite: they set their own password. */
  async inviteOwner({ email, name, tenantId, redirectTo }) {
    const { data, error } = await this.#admin.inviteUserByEmail(email, { data: { name }, redirectTo });
    if (error) throw new AuthAdminError('invite', error);
    const userId = data.user.id;
    // Role and restaurant go in app_metadata, which only the server can change.
    const { error: metadataError } = await this.#admin.updateUserById(userId, {
      app_metadata: { role: 'tenant_owner', tenant_id: tenantId },
    });
    if (metadataError) {
      await this.deleteUser(userId).catch(() => {});
      throw new AuthAdminError('set_role', metadataError);
    }
    return userId;
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
