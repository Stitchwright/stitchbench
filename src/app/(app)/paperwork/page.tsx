import { redirect } from "next/navigation";

// Paperwork opens on its first tab.
export default function PaperworkPage() {
  redirect("/paperwork/warranty");
}
