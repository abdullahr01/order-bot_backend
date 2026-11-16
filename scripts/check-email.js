// Sends one test email with the SMTP settings, to prove our own emails work:
//   npm run check:email -- you@example.com
// Uses SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and MAIL_FROM; prints no secrets.
import { SmtpMailer } from '../db/smtp-mailer.js';
import { settings } from '../shared/settings.js';

const [to] = process.argv.slice(2);
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error('Usage: npm run check:email -- you@example.com');
  process.exit(1);
}
if (!settings.mail) {
  console.error('Email is not set up: add SMTP_HOST, SMTP_USER, SMTP_PASSWORD and MAIL_FROM to .env (see docs/CONFIGURATION.md).');
  process.exit(1);
}
try {
  await new SmtpMailer(settings.mail).send({
    to,
    subject: 'QR Dine-in test email',
    text: 'Hello,\n\nThis is a test from the QR Dine-in backend. If you can read it, the unpaid reminders can reach owners.\n\nQR Dine-in',
  });
  console.log(`Sent through ${settings.mail.host}:${settings.mail.port}. Check the inbox (and spam) of the address you gave.`);
} catch (error) {
  console.error(`Not sent (${error.code ?? 'error'}). EAUTH: check SMTP_USER and the app password. ECONNECTION or ETIMEDOUT: check SMTP_HOST and SMTP_PORT.`);
  process.exitCode = 1;
}
