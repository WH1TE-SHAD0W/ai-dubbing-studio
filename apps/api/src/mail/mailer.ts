import { createTransport } from "nodemailer";

// Sends one plain-text email to the team inbox (YGP-119). Routes depend on this
// type, so tests pass a fake instead of an SMTP server.
export type Mailer = {
  send(mail: { subject: string; text: string; replyTo?: string }): Promise<void>;
};

export type MailConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  to: string;
  from?: string;
};

// A header value is one line: CR and LF would let a sender add headers.
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function createMailer(config: MailConfig): Mailer {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    // Port 465 is TLS from the start; other ports upgrade with STARTTLS.
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
  });
  return {
    async send({ subject, text, replyTo }) {
      await transport.sendMail({
        from: config.from ?? config.user,
        to: config.to,
        subject: oneLine(subject),
        text,
        replyTo: replyTo ? oneLine(replyTo) : undefined,
      });
    },
  };
}
