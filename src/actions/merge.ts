"use server";

// Merging and deleting customers and machines (round 3 L126): the "Merge or delete" card on a customer's and a
// machine's page. Owner or admin; the name typed to confirm comes in the form's `confirm`. Bodies in src/lib/merge.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { safe } from "@/lib/action";
import { str } from "@/lib/format";
import { assertId } from "@/lib/input";
import { deleteCustomerFor, deleteMachineFor, mergeCustomersFor, mergeMachinesFor } from "@/lib/merge";
import { requireAdmin } from "@/lib/session";

export const mergeCustomer = safe(async function mergeCustomer(fromId: string, intoId: string, fd: FormData) {
  const user = await requireAdmin();
  const kept = await mergeCustomersFor(user, assertId(fromId), assertId(intoId), str(fd.get("confirm")));
  revalidatePath("/customers");
  revalidatePath("/machines");
  revalidatePath(`/customers/${kept}`);
  redirect(`/customers/${kept}`);
});

export const deleteCustomer = safe.whileLapsed("deleteCustomer")(async function deleteCustomer(customerId: string, fd: FormData) {
  const user = await requireAdmin();
  await deleteCustomerFor(user, assertId(customerId), str(fd.get("confirm")));
  revalidatePath("/customers");
  revalidatePath("/machines");
  redirect("/customers");
});

export const mergeMachine = safe(async function mergeMachine(fromId: string, intoId: string, fd: FormData) {
  const user = await requireAdmin();
  const kept = await mergeMachinesFor(user, assertId(fromId), assertId(intoId), str(fd.get("confirm")));
  revalidatePath("/machines");
  revalidatePath(`/machines/${kept}`);
  redirect(`/machines/${kept}`);
});

export const deleteMachine = safe(async function deleteMachine(machineId: string, fd: FormData) {
  const user = await requireAdmin();
  await deleteMachineFor(user, assertId(machineId), str(fd.get("confirm")));
  revalidatePath("/machines");
  redirect("/machines");
});
