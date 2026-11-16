import { createTransport } from 'nodemailer';

export class MailError extends Error {
  constructor(cause) {
    super('Email could not be sent');
    this.name = 'MailError';
    // Only the category (EAUTH, ECONNECTION, ETIMEDOUT...), never the server's reply.
    this.code = typeof cause?.code === 'string' ? cause.code : undefined;
  }
}

/** Sends our own plain-text emails through SMTP (Gmail now, Resend's SMTP later). */
export class SmtpMailer {
  #transport;
  #from;

  constructor({ host, port, user, password, from }) {
    this.#transport = createTransport({
      host, port, secure: port === 465, requireTLS: port !== 465 && port !== 25,
      auth: { user, pass: password },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
    this.#from = from;
  }

  async send({ to, subject, text }) {
    try {
      await this.#transport.sendMail({ from: this.#from, to, subject, text });
    } catch (error) {
      throw new MailError(error);
    }
  }
}
