'use strict';

/**
 * Email sender used by the "forgot password" flow.
 *
 * If SMTP is configured in Settings, mail is sent for real via nodemailer.
 * If it is NOT configured (typical on first local run), the message is written
 * to data/outbox/*.txt and logged, so the flow is fully testable offline.
 *
 * SECURITY: the SMTP password is stored encrypted and only decrypted here,
 * in memory, at send time.
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('./config');
const store = require('./store');
const { decrypt } = require('./crypto');

const OUTBOX = path.join(config.dataDir, 'outbox');

function getSmtp() {
  const s = store.get().settings.smtp || {};
  return {
    host: s.host || '',
    port: parseInt(s.port || 587, 10),
    user: s.user || '',
    pass: decrypt(s.pass || ''),
    from: s.from || s.user || 'no-reply@ftechdeals.com',
  };
}

async function sendMail({ to, subject, text }) {
  const smtp = getSmtp();

  if (!smtp.host || !smtp.user || !smtp.pass) {
    // Offline fallback — write to outbox so nothing is lost.
    if (!fs.existsSync(OUTBOX)) fs.mkdirSync(OUTBOX, { recursive: true });
    const file = path.join(OUTBOX, `mail-${Date.now()}.txt`);
    fs.writeFileSync(
      file,
      `To: ${to}\nSubject: ${subject}\n\n${text}\n\n---\n(SMTP not configured — saved locally instead of sending. Add SMTP in Settings to email for real.)\n`
    );
    return { delivered: false, file };
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  await transporter.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
  });
  return { delivered: true };
}

module.exports = { sendMail };
