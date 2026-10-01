// Mail providers' SMTP settings for the Setup page (scheduling-messaging-design.md section 4.1). Pure.
// Hosts as published by the providers in 2026; the foundation implementer re-checks them before shipping.
export type SmtpPreset = { label: string; host: string; port: number; security: "starttls" | "tls"; help: string };

export const SMTP_PRESETS: Record<string, SmtpPreset> = {
  gmail: { label: "Gmail / Google Workspace", host: "smtp.gmail.com", port: 587, security: "starttls", help: "Turn on 2-step sign-in and make an app password (Google account → Security → App passwords). Use that, not your normal password. About 500 emails a day." },
  outlook: { label: "Outlook.com / Hotmail", host: "smtp-mail.outlook.com", port: 587, security: "starttls", help: "Use an app password (Microsoft account → Security → Advanced security options)." },
  m365: { label: "Microsoft 365 (business)", host: "smtp.office365.com", port: 587, security: "starttls", help: "Microsoft is retiring password sign-in for sending mail: use a relay such as SendGrid, Mailgun, Brevo or SES if it's refused." },
  yahoo: { label: "Yahoo Mail", host: "smtp.mail.yahoo.com", port: 465, security: "tls", help: "Make an app password under Account security." },
  sendgrid: { label: "SendGrid", host: "smtp.sendgrid.net", port: 587, security: "starttls", help: "User name is the word apikey; the password is an API key with Mail Send permission." },
  mailgun: { label: "Mailgun", host: "smtp.mailgun.org", port: 587, security: "starttls", help: "Use the SMTP credentials of your sending domain." },
  brevo: { label: "Brevo", host: "smtp-relay.brevo.com", port: 587, security: "starttls", help: "Use your login email and an SMTP key (not your account password)." },
  ses: { label: "Amazon SES", host: "email-smtp.us-east-1.amazonaws.com", port: 587, security: "starttls", help: "Use your region's host and SMTP credentials made in the SES console." },
  other: { label: "Other", host: "", port: 587, security: "starttls", help: "Your provider's SMTP server name, port and login." },
};

export const PRESET_KEYS = Object.keys(SMTP_PRESETS);
export const isPreset = (s: unknown): s is keyof typeof SMTP_PRESETS => typeof s === "string" && Object.hasOwn(SMTP_PRESETS, s);
