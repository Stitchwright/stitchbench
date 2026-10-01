/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the notices package fills in the body */
import "server-only";
// The automatic notices' schedulers (reminders, uncollected-machine notices, service due, review requests, bags due),
// run by the message worker for the shops with Marketing on. Foundation stub (owner: notices).

export async function runSchedulers(now: Date, shopIds: string[]): Promise<void> {}
