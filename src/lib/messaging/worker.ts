/* eslint-disable @typescript-eslint/no-unused-vars -- foundation placeholder: the messaging core slice replaces the bodies */
import "server-only";
// The message worker (scheduling-messaging-design.md section 4.3). Placeholder with the final signatures; the bodies
// land with the messaging core (smtp, twilio, inbound, service-due) in the same package.

export type MessageRunResult = { sent: number; failed: number; waiting: number } | { busy: true } | { off: true };

export function runMessages(): Promise<MessageRunResult> {
  return Promise.resolve({ off: true });
}

export async function messageRun(o?: { now?: Date; shopIds?: string[]; forceSchedulers?: boolean }): Promise<MessageRunResult> {
  return { off: true };
}

export async function sendOneNow(id: string): Promise<{ ok: true; detail: string } | { error: string }> {
  return { error: "Messages are switched off on this server (MESSAGES=off)." };
}
